"use strict";

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_ASSET_BYTES = 2 * 1024 ** 3; // GitHub requires strictly less than 2 GiB.

/** Release shards are append-only and share one metadata index. Use one writer
 * per repository (GitHub Actions concurrency); serialization here also handles
 * concurrent requests within that writer. Existing base-tag caches remain valid.
 */
class GitHubReleasesStorage {
  constructor({ token, owner, repo, releaseTag, localPath, maxAssets = 900,
    requestIntervalMs = 4000, writeIntervalMs = 7500,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (!Number.isInteger(maxAssets) || maxAssets < 1 || maxAssets > 1000) {
      throw new Error('maxAssets must be between 1 and 1000');
    }
    Object.assign(this, { token, owner, repo, releaseTag, localPath, maxAssets,
      requestIntervalMs, writeIntervalMs, sleep });
    this._assets = new Map();
    this._shards = [];
    this._initializing = null;
    this._writes = Promise.resolve();
    this._requests = Promise.resolve();
    this._lastRequest = 0;
    this._lastWrite = 0;
    fs.mkdirSync(path.join(localPath, 'narinfo'), { recursive: true });
  }

  _headers() {
    return {
      Authorization: `token ${this.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'static-nix-cache',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  // Serialize and pace API calls. Retry only explicit throttling / server errors;
  // request factories reopen upload streams for every retry.
  _request(url, options = {}) {
    const task = this._requests.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const opts = typeof options === 'function' ? options() : options;
        const write = opts.method && opts.method !== 'GET';
        const delay = Math.max(this._lastRequest + this.requestIntervalMs - Date.now(),
          write ? this._lastWrite + this.writeIntervalMs - Date.now() : 0, 0);
        if (delay) await this.sleep(delay);
        this._lastRequest = Date.now();
        if (write) this._lastWrite = Date.now();
        let resp;
        try {
          resp = await fetch(url, opts);
        } finally {
          // Also close streams when a mocked/failed fetch never consumes them.
          if (opts.body instanceof Readable) opts.body.destroy();
        }
        const retryAfter = resp.headers?.get('retry-after');
        const exhausted = resp.headers?.get('x-ratelimit-remaining') === '0';
        if (attempt >= 4 || !(resp.status === 429 || resp.status >= 500 ||
          (resp.status === 403 && (retryAfter || exhausted)))) return resp;
        await resp.body?.cancel();
        const reset = Number(resp.headers?.get('x-ratelimit-reset')) * 1000;
        const delayMs = retryAfter ? Number(retryAfter) * 1000 :
          exhausted && reset > Date.now() ? reset - Date.now() : 1000 * 2 ** attempt;
        await this.sleep(Math.max(delayMs, 1000));
      }
    });
    this._requests = task.catch(() => {});
    return task;
  }

  async _json(url, options = {}) {
    const resp = await this._request(url, { headers: this._headers(), ...options });
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }

  get _api() { return `https://api.github.com/repos/${this.owner}/${this.repo}`; }

  async _pages(url) {
    const result = [];
    for (let page = 1; ; page++) {
      const batch = await this._json(`${url}?per_page=100&page=${page}`);
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  }

  async _init() {
    if (!this._initializing) this._initializing = (async () => {
      const releases = await this._pages(`${this._api}/releases`);
      const cacheReleases = new Map();
      for (const release of releases) {
        const suffix = release.tag_name.slice(this.releaseTag.length);
        if (release.tag_name !== this.releaseTag &&
          !(release.tag_name.startsWith(this.releaseTag) && /^-\d{6}$/.test(suffix))) continue;
        const matches = cacheReleases.get(release.tag_name) || [];
        matches.push(release);
        cacheReleases.set(release.tag_name, matches);
      }
      for (const [tag, matches] of cacheReleases) {
        // Legacy concurrent writers could create multiple releases for one tag.
        // Only the release resolved by GitHub's tag endpoint backs public
        // /releases/download/<tag>/ URLs. Do not index or write hidden copies.
        const release = matches.length === 1 ? matches[0] :
          await this._json(`${this._api}/releases/tags/${encodeURIComponent(tag)}`);
        if (release.draft) throw new Error(`Cache release ${release.tag_name} is a draft`);
        const assets = await this._pages(`${this._api}/releases/${release.id}/assets`);
        const shard = { id: release.id, tag: release.tag_name, count: assets.length };
        this._shards.push(shard);
        for (const asset of assets) {
          if (asset.state && asset.state !== 'uploaded') continue;
          // A duplicate name can occur after an interrupted legacy upload.
          if (this._assets.has(asset.name)) throw new Error(`Duplicate cache asset: ${asset.name}`);
          this._assets.set(asset.name, { ...asset, shard });
        }
      }
      this._shards.sort((a, b) => a.tag.localeCompare(b.tag));
    })();
    return this._initializing;
  }

  async _writableShard() {
    await this._init();
    const available = this._shards.find(s => s.count < this.maxAssets);
    if (available) return available;
    const last = Math.max(0, ...this._shards.map(s => Number(s.tag.slice(this.releaseTag.length + 1)) || 0));
    const tag = this._shards.length ? `${this.releaseTag}-${String(last + 1).padStart(6, '0')}` : this.releaseTag;
    const release = await this._json(`${this._api}/releases`, {
      method: 'POST',
      headers: { ...this._headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name: `Nix cache (${tag})`,
        body: 'Managed by static-nix-cache. Do not modify cache assets.',
        draft: false, prerelease: true, make_latest: 'false' }),
    });
    const shard = { id: release.id, tag, count: 0 };
    this._shards.push(shard);
    return shard;
  }

  _serialize(fn) {
    const task = this._writes.then(fn);
    this._writes = task.catch(() => {});
    return task;
  }

  async _upload(filename, size, bodyFactory, contentType) {
    if (size >= MAX_ASSET_BYTES) throw new Error(`Asset ${filename} must be under 2 GiB; enable compression or use S3`);
    await this._init();
    // Content-addressed assets are immutable. Never delete a working download.
    if (this._assets.has(filename)) return this._assets.get(filename);
    const shard = await this._writableShard();
    const resp = await this._request(
      `https://uploads.github.com/repos/${this.owner}/${this.repo}/releases/${shard.id}/assets?name=${encodeURIComponent(filename)}`,
      () => ({ method: 'POST', headers: { ...this._headers(),
        'Content-Type': contentType, 'Content-Length': String(size) },
        body: bodyFactory(), duplex: 'half' }));
    if (!resp.ok) {
      // A retried POST may conflict after an earlier response was lost. Recover
      // the completed immutable asset; never delete it to retry an upload.
      if (resp.status === 422) {
        const listed = await this._pages(`${this._api}/releases/${shard.id}/assets`);
        const completed = listed.find(a => a.name === filename && a.state === 'uploaded');
        shard.count = listed.length;
        if (completed) {
          const recovered = { ...completed, shard };
          this._assets.set(filename, recovered);
          return recovered;
        }
      }
      throw new Error(`Failed to upload ${filename}: ${resp.status} ${await resp.text()}`);
    }
    const asset = { ...await resp.json(), shard };
    this._assets.set(filename, asset);
    shard.count++;
    return asset;
  }

  async _findAsset(filename) {
    await this._init();
    return this._assets.get(filename) || null;
  }

  async _listAllAssets() {
    await this._init();
    return [...this._assets.values()];
  }

  async hasNarinfo(hash) {
    return (await this.getNarinfo(hash)) !== null;
  }

  async getNarinfo(hash) {
    const file = path.join(this.localPath, 'narinfo', `${hash}.narinfo`);
    try { return await fsp.readFile(file, 'utf8'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const asset = await this._findAsset(`${hash}.narinfo`);
    if (!asset) return null;
    const resp = await this._request(asset.url, {
      headers: { ...this._headers(), Accept: 'application/octet-stream' }, redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`Cannot download metadata ${asset.name}: ${resp.status}`);
    const content = await resp.text();
    // Upgrade legacy relative URLs using the complete cross-shard NAR index.
    const rewritten = await this._absoluteNarUrl(content);
    await fsp.writeFile(file, rewritten);
    return rewritten;
  }

  async _absoluteNarUrl(content) {
    const match = content.match(/^URL: nar\/(.+)$/m);
    if (!match) return content;
    const asset = await this._findAsset(match[1].trim());
    if (!asset) throw new Error(`Missing NAR asset: ${match[1]}`);
    return content.replace(match[0], `URL: ${this.narDownloadUrl(asset.name)}`);
  }

  async putNarinfo(hash, content) {
    return this._serialize(async () => {
      const filename = `${hash}.narinfo`;
      if (await this._findAsset(filename)) {
        await this.getNarinfo(hash);
        return;
      }
      // Nix signatures cover store path, NAR hash/size and references, not URL.
      const rewritten = await this._absoluteNarUrl(content);
      const body = Buffer.from(rewritten);
      await this._upload(filename, body.length, () => body, 'text/plain');
      // Only expose metadata after its durable upload succeeds.
      await fsp.writeFile(path.join(this.localPath, 'narinfo', filename), rewritten);
    });
  }

  async fetchAllNarinfo() {
    const assets = await this._listAllAssets();
    let fetched = 0;
    for (const asset of assets) {
      if (!asset.name.endsWith('.narinfo')) continue;
      await this.getNarinfo(asset.name.slice(0, -8));
      fetched++;
    }
    return fetched;
  }

  async hasNar(filename) { return (await this._findAsset(filename)) !== null; }

  async getNarStream(filename) {
    const asset = await this._findAsset(filename);
    if (!asset) return null;
    const resp = await this._request(asset.url, {
      headers: { ...this._headers(), Accept: 'application/octet-stream' }, redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`Cannot download NAR ${filename}: ${resp.status}`);
    return Readable.fromWeb(resp.body);
  }

  async putNarStream(filename, readableStream) {
    // Spool to disk to determine Content-Length without retaining GiB in RAM.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'static-nix-cache-nar-'));
    const file = path.join(dir, 'asset');
    let size = 0;
    try {
      await pipeline(readableStream, new Transform({ transform(chunk, encoding, done) {
        size += chunk.length;
        if (size >= MAX_ASSET_BYTES) return done(new Error('NAR must be under 2 GiB; enable compression or use S3'));
        done(null, chunk);
      } }), fs.createWriteStream(file));
      await this._serialize(() => this._upload(filename, size,
        () => fs.createReadStream(file), 'application/octet-stream'));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  async _getReferencedNarFilenames() {
    const narinfoDir = path.join(this.localPath, 'narinfo');
    const referenced = new Set();

    let entries;
    try {
      entries = await fsp.readdir(narinfoDir);
    } catch {
      return referenced;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.narinfo')) continue;
      try {
        const content = await fsp.readFile(path.join(narinfoDir, entry), 'utf8');
        for (const line of content.split('\n')) {
          if (line.startsWith('URL:')) {
            const url = line.slice(4).trim();
            // URL is typically "nar/<filename>" – extract just the filename
            const filename = decodeURIComponent(new URL(url, 'https://cache.invalid/').pathname.split('/').pop());
            if (filename) referenced.add(filename);
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    return referenced;
  }

  /**
   * Remove release assets that are not referenced by any local narinfo file.
   *
   * When `retentionDays` is greater than 0, only orphaned assets whose
   * `created_at` timestamp is older than `retentionDays` days ago are deleted.
   * This avoids removing assets that were just uploaded but whose narinfo
   * has not yet been written or propagated.
   *
   * @param {object} [options]
   * @param {number} [options.retentionDays=0] - grace period in days before
   *   an orphaned asset is deleted.  0 means delete immediately.
   * @returns {Promise<{deleted: string[], kept: string[], referenced: string[]}>}
   */
  async pruneAssets({ retentionDays = 0 } = {}) {
    console.log(`[github-releases] Starting asset pruning (retentionDays=${retentionDays})`);

    await this.fetchAllNarinfo();
    const [assets, referenced] = await Promise.all([
      this._listAllAssets(),
      this._getReferencedNarFilenames(),
    ]);

    console.log(`[github-releases] Found ${assets.length} release asset(s), ${referenced.size} referenced NAR filename(s)`);

    const cutoff = retentionDays > 0
      ? new Date(Date.now() - retentionDays * MS_PER_DAY)
      : null;

    const deleted = [];
    const kept = [];
    const referencedNames = [];

    for (const asset of assets) {
      // Skip narinfo assets — they are metadata, not orphan candidates
      if (asset.name.endsWith('.narinfo')) continue;

      if (referenced.has(asset.name)) {
        referencedNames.push(asset.name);
        continue;
      }

      // Asset is orphaned – check retention period
      if (cutoff) {
        const createdAt = new Date(asset.created_at);
        if (createdAt >= cutoff) {
          console.log(`[github-releases] Keeping orphaned asset ${asset.name} (created ${asset.created_at}, within retention window)`);
          kept.push(asset.name);
          continue;
        }
      }

      console.log(`[github-releases] Deleting orphaned asset ${asset.name} (id=${asset.id})`);
      const resp = await this._request(
        `https://api.github.com/repos/${this.owner}/${this.repo}/releases/assets/${asset.id}`,
        { method: 'DELETE', headers: this._headers() }
      );

      if (resp.ok) {
        deleted.push(asset.name);
        this._assets.delete(asset.name);
        asset.shard.count--;
      } else {
        console.error(`[github-releases] Failed to delete asset ${asset.name}: ${resp.status}`);
        kept.push(asset.name);
      }
    }

    console.log(`[github-releases] Pruning complete: ${deleted.length} deleted, ${kept.length} kept (orphaned), ${referencedNames.length} referenced`);

    return { deleted, kept, referenced: referencedNames };
  }

  narDownloadUrl(filename) {
    const tag = this._assets.get(filename)?.shard.tag || this.releaseTag;
    return `https://github.com/${this.owner}/${this.repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
  }
}

module.exports = GitHubReleasesStorage;
