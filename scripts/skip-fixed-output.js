#!/usr/bin/env node
'use strict';

// Removes from a list of store paths the outputs of fixed-output derivations: paths that
// were downloaded, not built. A download that something kept depends on is still copied
// with it, as part of its closure; only downloads nothing kept refers to are left out.
//
//   node scripts/skip-fixed-output.js <paths-file>
//
// The file is rewritten in place. NIX_STORE_URL, when set, is the store to ask about the
// paths (such as file:///tmp/export) instead of the local one.
//
// It never drops a path it is unsure of: if Nix cannot be asked about some paths, they stay.

const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { parsePathInfo, partitionFixedOutput } = require('../src/fixed-output');

const run = promisify(execFile);
const BATCH = 200;

async function pathInfo(paths, nix, store) {
  const args = ['path-info', '--json', ...(store ? ['--store', store] : []), ...paths];
  const { stdout } = await run(nix, args, { maxBuffer: 256 * 1024 * 1024 });
  return parsePathInfo(stdout);
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: skip-fixed-output.js <paths-file>');
  const paths = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (!paths.length) return;

  const nix = process.env.NIX_BIN || 'nix';
  const store = process.env.NIX_STORE_URL || '';
  const kept = [];
  const skipped = [];
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    try {
      const { fixed, rest } = partitionFixedOutput(batch, await pathInfo(batch, nix, store));
      skipped.push(...fixed);
      kept.push(...rest);
    } catch (err) {
      console.log(`::warning::Could not tell whether ${batch.length} path(s) were downloaded; they are kept. ${String(err.message).split('\n')[0]}`);
      kept.push(...batch);
    }
  }
  fs.writeFileSync(file, kept.map(p => `${p}\n`).join(''));
  for (const p of skipped) console.log(`  skipped (fixed-output): ${p}`);
  console.log(`Skipped ${skipped.length} fixed-output store path(s); ${kept.length} left`);
}

main().catch(err => {
  // Publishing everything is slower but never wrong, so a failure here stops nothing.
  console.log(`::warning::Skipping fixed-output paths failed; all paths are kept. ${err.message}`);
});
