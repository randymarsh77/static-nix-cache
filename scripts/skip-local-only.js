#!/usr/bin/env node
'use strict';

// Removes from a list of store paths those built by a derivation with allowSubstitutes =
// false, and every path that depends on one: paths that are quicker to build where they are
// used than to fetch, and the paths that would bring them along (src/local-only.js).
//
//   node scripts/skip-local-only.js <paths-file>
//
// The file is rewritten in place. It reads the local store and the derivations in it, so it
// only runs where the paths were built (src/local-only-scan.js).
//
// It never drops a path it is unsure of: if Nix cannot be asked, every path stays.

const fs = require('fs');
const { scanLocalOnly } = require('../src/local-only-scan');

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: skip-local-only.js <paths-file>');
  const paths = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (!paths.length) return;
  const { held, rest, localOnly } = await scanLocalOnly(paths, { log: console.log });
  fs.writeFileSync(file, rest.map(p => `${p}\n`).join(''));
  for (const p of held) console.log(`  skipped (${localOnly.has(p) ? 'local-only' : 'depends on a local-only path'}): ${p}`);
  console.log(`Skipped ${held.length} local-only store path(s) and their dependents; ${rest.length} left`);
}

main().catch(err => {
  // Publishing everything is slower but never wrong, so a failure here stops nothing.
  console.log(`::warning::Skipping local-only paths failed; all paths are kept. ${String(err.message).split('\n')[0]}`);
});
