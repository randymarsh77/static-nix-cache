'use strict';

const LocalStorage = require('./local');
const S3Storage = require('./s3');
const GitHubReleasesStorage = require('./github-releases');

/** The nix-cache-info a bucket in the Nix layout is given. */
function cacheInfo(config) {
  return `StoreDir: ${config.storeDir}\nWantMassQuery: 1\nPriority: ${config.priority}\n`;
}

/**
 * Options for a Cloudflare R2 bucket: the S3 backend in the layout Nix's own
 * s3:// store reads, so a private bucket can be used as a substituter directly.
 */
function r2Options(config) {
  const { accountId, bucket, accessKeyId, secretAccessKey, endpoint } = config.r2 || {};
  if (!bucket) throw new Error('R2_BUCKET is required for the r2 backend');
  if (!endpoint && !accountId) throw new Error('R2_ACCOUNT_ID (or R2_ENDPOINT) is required for the r2 backend');
  return {
    bucket,
    region: 'auto',
    endpoint: endpoint || `https://${accountId}.r2.cloudflarestorage.com`,
    accessKeyId,
    secretAccessKey,
    // R2 serves path-style requests on every endpoint, custom ones included.
    forcePathStyle: true,
    layout: 'nix',
    checksums: 'when-required',
    cacheInfo: cacheInfo(config),
  };
}

/**
 * Create the configured storage backend.
 * @param {object} config - application config
 * @returns {LocalStorage|S3Storage|GitHubReleasesStorage}
 */
function createStorage(config) {
  if (config.storageBackend === 's3') {
    return new S3Storage({ ...config.s3, cacheInfo: cacheInfo(config) });
  }
  if (config.storageBackend === 'r2') {
    return new S3Storage(r2Options(config));
  }
  if (config.storageBackend === 'github-releases') {
    return new GitHubReleasesStorage({
      ...config.github,
      localPath: config.localStoragePath,
    });
  }
  return new LocalStorage(config.localStoragePath);
}

module.exports = { createStorage, r2Options };
