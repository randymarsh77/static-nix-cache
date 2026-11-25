#!/usr/bin/env node
'use strict';

// Records a root for the cache's garbage collection (src/gc.js): the closure of the given
// store paths, as the store that built them has it.
//
//   node scripts/record-root.js <paths-file>
//
// The file lists store paths, or links to them such as ./result. ROOT_NAME names the root
// (the newest few of each name are always kept); ROOT_ID tells roots of one name apart.
// NIX_STORE_URL, when set, is the store to read closures from instead of the local one. The
// storage is configured as for the server (STORAGE_BACKEND=r2, R2_BUCKET, ...).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../src/config');
const { bucketStorage, writeRoot } = require('../src/gc-storage');

const run = promisify(execFile);
const BATCH = 200;

function resolve(p) {
  // A link such as ./result names the store path it points to.
  if (!p.startsWith(`${config.storeDir}/`) && fs.existsSync(p)) return fs.realpathSync(p);
  return p;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: record-root.js <paths-file>');
  const name = process.env.ROOT_NAME;
  if (!name) throw new Error('ROOT_NAME is required');
  const paths = fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(resolve)
    .map(p => path.join(config.storeDir, path.relative(config.storeDir, p).split('/')[0]));
  if (!paths.length) {
    console.log('No store paths, so no root is recorded');
    return;
  }
  const nix = process.env.NIX_BIN || 'nix';
  const store = process.env.NIX_STORE_URL || '';
  const closure = new Set();
  for (let i = 0; i < paths.length; i += BATCH) {
    const args = ['path-info', '--recursive', ...(store ? ['--store', store] : []), ...paths.slice(i, i + BATCH)];
    const { stdout } = await run(nix, args, { maxBuffer: 1024 * 1024 * 1024 });
    for (const p of stdout.split('\n').filter(Boolean)) closure.add(p.trim());
  }
  const { key, count } = await writeRoot(bucketStorage(config), {
    name, id: process.env.ROOT_ID || '', paths: [...closure],
  });
  console.log(`Recorded root ${key}: ${count} store path(s), the closure of ${paths.length}`);
}

main().catch(err => {
  console.log(`::error::Recording the cache root failed: ${err.message}. Pruning may then delete what this run published.`);
  process.exit(1);
});
