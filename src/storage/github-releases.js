'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const stream = require('stream');
const { promisify } = require('util');

const pipeline = promisify(stream.pipeline);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * GitHub Releases storage backend.
 *
 * NAR files are stored as release assets on a GitHub Release.
 * narinfo files are stored on the local filesystem (for later static export).
 *
 * Layout:
 *   GitHub Release assets:  <filename>        (NAR files)
 *   Local filesystem:       <localPath>/narinfo/<hash>.narinfo
 */
class GitHubReleasesStorage {
  constructor({ token, owner, repo, releaseTag, localPath }) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.releaseTag = releaseTag;
    this.localPath = localPath;
    this._releaseId = null;

    // Ensure local narinfo directory exists
    fs.mkdirSync(path.join(this.localPath, 'narinfo'), { recursive: true });
  }

  /**
   * Get or create the GitHub Release and return its ID.
   */
  async _getReleaseId() {
    if (this._releaseId) return this._releaseId;

    // Try to get existing release by tag
    const getUrl = `https://api.github.com/repos/${this.owner}/${this.repo}/releases/tags/${encodeURIComponent(this.releaseTag)}`;
    console.log(`[github-releases] Looking up release by tag: ${this.releaseTag}`);
    const getResp = await fetch(getUrl, {
      headers: this._headers(),
    });

    if (getResp.ok) {
      const release = await getResp.json();
      this._releaseId = release.id;
      console.log(`[github-releases] Found existing release id=${this._releaseId}`);
      return this._releaseId;
    }

    console.log(`[github-releases] Release not found (${getResp.status}), creating new release`);

    // Create release if it doesn't exist
    const createUrl = `https://api.github.com/repos/${this.owner}/${this.repo}/releases`;
    const createResp = await fetch(createUrl, {
      method: 'POST',
      headers: { ...this._headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: this.releaseTag,
        name: `Nix Binary Cache (${this.releaseTag})`,
        body: 'Nix binary cache NAR files managed by static-nix-cache.',
        draft: false,
        prerelease: false,
      }),
    });

    if (!createResp.ok) {
      const errBody = await createResp.text();
      console.error(`[github-releases] Failed to create release: ${createResp.status} ${errBody}`);
      throw new Error(`Failed to create GitHub release: ${createResp.status} ${errBody}`);
    }

    const release = await createResp.json();
    this._releaseId = release.id;
    console.log(`[github-releases] Created release id=${this._releaseId}`);
    return this._releaseId;
  }

  _headers() {
    return {
      Authorization: `token ${this.token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'static-nix-cache',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  // ── narinfo (local filesystem) ──────────────────────────────────────────────

  async _exists(filePath) {
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async hasNarinfo(hash) {
    return this._exists(path.join(this.localPath, 'narinfo', `${hash}.narinfo`));
  }

  async getNarinfo(hash) {
    const filePath = path.join(this.localPath, 'narinfo', `${hash}.narinfo`);
    try {
      return await fsp.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  async putNarinfo(hash, content) {
    console.log(`[github-releases] Storing narinfo ${hash}`);
    // Write locally for immediate use by the server and static site generation
    await fsp.writeFile(
      path.join(this.localPath, 'narinfo', `${hash}.narinfo`),
      content,
      'utf8'
    );

    // Also persist to GitHub Releases so other jobs (e.g. matrix builds) and
    // future static site generations can discover all narinfo across runs.
    const filename = `${hash}.narinfo`;
    const releaseId = await this._getReleaseId();
    const body = Buffer.from(content, 'utf8');

    // Delete existing asset with the same name if present
    const existing = await this._findAsset(filename);
    if (existing) {
      await fetch(
        `https://api.github.com/repos/${this.owner}/${this.repo}/releases/assets/${existing.id}`,
        { method: 'DELETE', headers: this._headers() }
      );
    }

    const uploadUrl = `https://uploads.github.com/repos/${this.owner}/${this.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(filename)}`;
    const resp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...this._headers(),
        'Content-Type': 'text/plain',
        'Content-Length': String(body.length),
      },
      body,
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.warn(`[github-releases] Warning: failed to upload narinfo asset ${filename}: ${resp.status} ${errBody}`);
    }
  }

  /**
   * Download all `.narinfo` release assets into the local narinfo directory.
   *
   * This ensures the local narinfo directory is a complete superset of all
   * narinfo ever pushed to the release (across matrix jobs, previous runs, etc.).
   * Called before static site generation so the generated site is complete.
   *
   * @returns {Promise<number>} number of narinfo files fetched from the release
   */
  async fetchAllNarinfo() {
    console.log('[github-releases] Fetching all narinfo from release...');
    const assets = await this._listAllAssets();
    const narinfoAssets = assets.filter(a => a.name.endsWith('.narinfo'));
    const narinfoDir = path.join(this.localPath, 'narinfo');
    let fetched = 0;

    for (const asset of narinfoAssets) {
      const localFile = path.join(narinfoDir, asset.name);
      // Skip if we already have this file locally (just written by this job)
      if (await this._exists(localFile)) continue;

      const resp = await fetch(asset.url, {
        headers: {
          ...this._headers(),
          Accept: 'application/octet-stream',
        },
        redirect: 'follow',
      });

      if (!resp.ok) {
        console.warn(`[github-releases] Warning: could not download narinfo asset ${asset.name}: ${resp.status}`);
        continue;
      }

      const content = await resp.text();
      await fsp.writeFile(localFile, content, 'utf8');
      fetched++;
    }

    console.log(`[github-releases] Fetched ${fetched} narinfo file(s) from release (${narinfoAssets.length} total on release)`);
    return fetched;
  }

  // ── NAR files (GitHub Release assets) ───────────────────────────────────────

  async hasNar(filename) {
    const asset = await this._findAsset(filename);
    return asset !== null;
  }

  async getNarStream(filename) {
    const asset = await this._findAsset(filename);
    if (!asset) return null;

    const resp = await fetch(asset.url, {
      headers: {
        ...this._headers(),
        Accept: 'application/octet-stream',
      },
      redirect: 'follow',
    });

    if (!resp.ok) return null;

    const { Readable } = require('stream');
    return Readable.fromWeb(resp.body);
  }

  async putNarStream(filename, readableStream) {
    const releaseId = await this._getReleaseId();

    // Collect stream into buffer for upload.
    // Note: GitHub's upload API requires Content-Length, so the full NAR
    // must be buffered.  For very large NARs consider using S3 storage.
    const chunks = [];
    for await (const chunk of readableStream) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);

    console.log(`[github-releases] Uploading NAR asset ${filename} (${body.length} bytes)`);

    // Delete existing asset with the same name if present
    const existing = await this._findAsset(filename);
    if (existing) {
      console.log(`[github-releases] Deleting existing asset ${filename} (id=${existing.id})`);
      await fetch(
        `https://api.github.com/repos/${this.owner}/${this.repo}/releases/assets/${existing.id}`,
        { method: 'DELETE', headers: this._headers() }
      );
    }

    const uploadUrl = `https://uploads.github.com/repos/${this.owner}/${this.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(filename)}`;
    const resp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...this._headers(),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
      },
      body,
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error(`[github-releases] Failed to upload asset ${filename}: ${resp.status} ${errBody}`);
      throw new Error(`Failed to upload release asset: ${resp.status} ${errBody}`);
    }

    console.log(`[github-releases] Uploaded asset ${filename} successfully`);
  }

  /**
   * Find a release asset by filename (paginates through all assets).
   * @param {string} filename
   * @returns {Promise<object|null>}
   */
  async _findAsset(filename) {
    const releaseId = await this._getReleaseId();
    let page = 1;

    while (true) {
      const url = `https://api.github.com/repos/${this.owner}/${this.repo}/releases/${releaseId}/assets?per_page=100&page=${page}`;
      const resp = await fetch(url, { headers: this._headers() });

      if (!resp.ok) return null;

      const assets = await resp.json();
      if (assets.length === 0) return null;

      const match = assets.find(a => a.name === filename);
      if (match) return match;

      if (assets.length < 100) return null;
      page++;
    }
  }

  /**
   * List all release assets (paginates through all pages).
   * @returns {Promise<object[]>}
   */
  async _listAllAssets() {
    const releaseId = await this._getReleaseId();
    const all = [];
    let page = 1;

    while (true) {
      const url = `https://api.github.com/repos/${this.owner}/${this.repo}/releases/${releaseId}/assets?per_page=100&page=${page}`;
      const resp = await fetch(url, { headers: this._headers() });

      if (!resp.ok) break;

      const assets = await resp.json();
      if (assets.length === 0) break;

      all.push(...assets);
      if (assets.length < 100) break;
      page++;
    }

    return all;
  }

  /**
   * Read all local narinfo files and extract the NAR filenames they reference.
   * Narinfo files contain a `URL:` field like `nar/<filename>`.
   * @returns {Promise<Set<string>>}
   */
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
            const filename = url.startsWith('nar/') ? url.slice(4) : url;
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
      const resp = await fetch(
        `https://api.github.com/repos/${this.owner}/${this.repo}/releases/assets/${asset.id}`,
        { method: 'DELETE', headers: this._headers() }
      );

      if (resp.ok) {
        deleted.push(asset.name);
      } else {
        console.error(`[github-releases] Failed to delete asset ${asset.name}: ${resp.status}`);
        kept.push(asset.name);
      }
    }

    console.log(`[github-releases] Pruning complete: ${deleted.length} deleted, ${kept.length} kept (orphaned), ${referencedNames.length} referenced`);

    return { deleted, kept, referenced: referencedNames };
  }

  /**
   * Return the public download URL for a NAR file on GitHub Releases.
   * This URL does not require authentication.
   * @param {string} filename
   * @returns {string}
   */
  narDownloadUrl(filename) {
    return `https://github.com/${this.owner}/${this.repo}/releases/download/${encodeURIComponent(this.releaseTag)}/${encodeURIComponent(filename)}`;
  }
}

module.exports = GitHubReleasesStorage;
