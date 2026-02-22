'use strict';

const { createApp } = require('./src/server');
const config = require('./src/config');

const app = createApp();

app.listen(config.port, () => {
  console.log(`OpenCache Nix binary cache listening on port ${config.port}`);
  console.log(`  Storage backend: ${config.storageBackend}`);
  console.log(`  Store dir:       ${config.storeDir}`);
  console.log(`  Priority:        ${config.priority}`);
  if (config.signingKey) {
    const keyName = config.signingKey.split(':')[0];
    console.log(`  Signing key:     ${keyName}`);
  }
});
