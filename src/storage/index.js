'use strict';

const LocalStorage = require('./local');
const S3Storage = require('./s3');

/**
 * Create the configured storage backend.
 * @param {object} config - application config
 * @returns {LocalStorage|S3Storage}
 */
function createStorage(config) {
  if (config.storageBackend === 's3') {
    return new S3Storage(config.s3);
  }
  return new LocalStorage(config.localStoragePath);
}

module.exports = { createStorage };
