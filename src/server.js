'use strict';

const express = require('express');
const { createCacheRouter } = require('./routes/cache');
const { createStorage } = require('./storage');
const { requestLogger } = require('./middleware/logging');
const config = require('./config');

/**
 * Create and configure the Express application.
 * @param {object} [overrideConfig] - optional config overrides (used in tests)
 * @returns {express.Application}
 */
function createApp(overrideConfig) {
  const cfg = overrideConfig ? { ...config, ...overrideConfig } : config;
  const storage = cfg._storage || createStorage(cfg);

  const app = express();
  app.use(requestLogger());
  app.use('/', createCacheRouter(storage, cfg));

  return app;
}

module.exports = { createApp };
