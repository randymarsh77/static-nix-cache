#!/usr/bin/env node
'use strict';

// Removes from a list of store paths those a trusted upstream cache has signed, so that
// deploy does not spend a request on each to learn that it need not be published.
//
//   node scripts/skip-upstream-signed.js <paths-file>
//
// The file is rewritten in place. UPSTREAM_CACHES are the cache URLs deploy was given and
// UPSTREAM_PUBLIC_KEYS their public keys; the key of cache.nixos.org is known without being
// given. With no key to check against, the file is left as it is.
//
// It never drops a path it is unsure of: if Nix cannot be asked about some paths, they stay.

const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { upstreamKeys, parsePathInfo, partition } = require('../src/upstream-signed');

const run = promisify(execFile);
const words = value => (value || '').split(/\s+/).filter(Boolean);
const BATCH = 200;

async function pathInfo(paths, nix) {
  const { stdout } = await run(nix, ['path-info', '--json', ...paths], { maxBuffer: 256 * 1024 * 1024 });
  return parsePathInfo(stdout);
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: skip-upstream-signed.js <paths-file>');
  const keys = upstreamKeys(words(process.env.UPSTREAM_CACHES), words(process.env.UPSTREAM_PUBLIC_KEYS));
  const paths = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (!keys.length || !paths.length) return;

  const nix = process.env.NIX_BIN || 'nix';
  const kept = [];
  let skipped = 0;
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    try {
      const { signed, rest } = partition(batch, await pathInfo(batch, nix), keys);
      skipped += signed.length;
      kept.push(...rest);
    } catch (err) {
      console.log(`::warning::Could not read signatures for ${batch.length} path(s); they will be checked against the cache instead. ${String(err.message).split('\n')[0]}`);
      kept.push(...batch);
    }
  }
  fs.writeFileSync(file, kept.map(p => `${p}\n`).join(''));
  console.log(`Skipped ${skipped} store path(s) an upstream cache has signed; ${kept.length} left to check`);
}

main().catch(err => {
  // Publishing everything is slower but never wrong, so a failure here stops nothing.
  console.log(`::warning::Skipping upstream-signed paths failed; all paths will be checked. ${err.message}`);
});
