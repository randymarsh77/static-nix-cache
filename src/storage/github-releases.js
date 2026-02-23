'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const stream = require('stream');
const { promisify } = require('util');

const pipeline = promisify(stream.pipeline);

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
        body: 'Nix binary cache NAR files managed by OpenCache.',
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
      'User-Agent': 'OpenCache',
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
    await fsp.writeFile(
      path.join(this.localPath, 'narinfo', `${hash}.narinfo`),
      content,
      'utf8'
    );
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
