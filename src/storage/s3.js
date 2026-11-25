'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const {
  S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');

// A single PutObject is limited to 5 GiB by S3 and R2.
const MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * S3-compatible storage backend.
 *
 * Supports AWS S3, Cloudflare R2, Backblaze B2, MinIO, etc.
 *
 * Layouts in bucket:
 *   legacy (default)  narinfo/<hash>.narinfo, nar/<filename>
 *   nix               <hash>.narinfo, nar/<filename>, nix-cache-info
 *
 * The `nix` layout is the one Nix's own s3:// store reads, so the bucket can be
 * used directly as a substituter (s3://<bucket>?endpoint=...) with no server.
 */
class S3Storage {
  constructor({
    bucket, region, endpoint, accessKeyId, secretAccessKey, forcePathStyle,
    layout = 'legacy', cacheInfo, checksums, client,
  }) {
    if (layout !== 'legacy' && layout !== 'nix') {
      throw new Error(`Unknown S3 layout '${layout}' (expected 'legacy' or 'nix')`);
    }
    this.bucket = bucket;
    this.layout = layout;
    this.cacheInfo = cacheInfo;
    this._cacheInfoWritten = null;
    this.client = client || new S3Client({
      region,
      endpoint,
      forcePathStyle: forcePathStyle || false,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      // R2 does not accept every checksum the SDK sends by default.
      ...(checksums === 'when-required' ? {
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      } : {}),
    });
  }

  _narinfoKey(hash) {
    return this.layout === 'nix' ? `${hash}.narinfo` : `narinfo/${hash}.narinfo`;
  }

  async _exists(key) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
      throw err;
    }
  }

  /**
   * Write nix-cache-info once, so a client with read-only keys finds it: Nix
   * otherwise tries to create it, which read-only keys cannot.
   */
  async _ensureCacheInfo() {
    if (this.layout !== 'nix' || !this.cacheInfo) return;
    if (!this._cacheInfoWritten) {
      this._cacheInfoWritten = (async () => {
        await this.client.send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: 'nix-cache-info',
          Body: this.cacheInfo,
          ContentType: 'text/x-nix-cache-info',
        }));
      })().catch(err => {
        this._cacheInfoWritten = null;
        throw err;
      });
    }
    await this._cacheInfoWritten;
  }

  async hasNarinfo(hash) {
    return this._exists(this._narinfoKey(hash));
  }

  async getNarinfo(hash) {
    try {
      const resp = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this._narinfoKey(hash),
      }));
      const chunks = [];
      for await (const chunk of resp.Body) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async putNarinfo(hash, content) {
    await this._ensureCacheInfo();
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this._narinfoKey(hash),
      Body: content,
      ContentType: 'text/x-nix-narinfo',
    }));
  }

  async hasNar(filename) {
    return this._exists(`nar/${filename}`);
  }

  async getNarStream(filename) {
    try {
      const resp = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: `nar/${filename}`,
      }));
      if (resp.Body instanceof Readable) {
        return resp.Body;
      }
      // AWS SDK v3 can return a web ReadableStream in some environments; convert it
      return Readable.from(resp.Body);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async putNarStream(filename, readableStream) {
    // PutObject needs a Content-Length, which an upload stream does not carry.
    // Spool to disk to learn it without holding the NAR in memory.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'static-nix-cache-nar-'));
    const file = path.join(dir, 'nar');
    try {
      await pipeline(readableStream, fs.createWriteStream(file));
      const { size } = await fsp.stat(file);
      if (size > MAX_OBJECT_BYTES) {
        throw new Error('NAR must be at most 5 GiB for a single S3 upload; enable compression');
      }
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: `nar/${filename}`,
        Body: fs.createReadStream(file),
        ContentLength: size,
        ContentType: 'application/x-nix-nar',
      }));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Every object under a prefix (the whole bucket when it is empty).
   * @returns {Promise<{key: string, lastModified: Date, size: number}[]>}
   */
  async listObjects(prefix = '') {
    const out = [];
    let token;
    do {
      const resp = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        ...(prefix ? { Prefix: prefix } : {}),
        ...(token ? { ContinuationToken: token } : {}),
      }));
      for (const o of resp.Contents || []) {
        out.push({ key: o.Key, lastModified: new Date(o.LastModified), size: o.Size || 0 });
      }
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /** An object's contents as text, or null when there is none. */
  async getText(key) {
    try {
      const resp = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const chunks = [];
      for await (const chunk of resp.Body) chunks.push(chunk);
      return Buffer.concat(chunks).toString('utf8');
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async putText(key, content, contentType = 'text/plain') {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: content, ContentType: contentType,
    }));
  }

  /** Deletes objects, 1000 to a request (the most S3 and R2 take). */
  async deleteObjects(keys) {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const resp = await this.client.send(new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true },
      }));
      const errors = resp.Errors || [];
      if (errors.length) {
        throw new Error(`Could not delete ${errors.length} object(s), such as ${errors[0].Key}: ${errors[0].Message || errors[0].Code}`);
      }
    }
  }
}

module.exports = S3Storage;
