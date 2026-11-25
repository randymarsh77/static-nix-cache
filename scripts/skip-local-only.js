#!/usr/bin/env node
'use strict';

// Removes from a list of store paths those built by a derivation with allowSubstitutes =
// false, and every path that depends on one: paths that are quicker to build where they are
// used than to fetch, and the paths that would bring them along (src/local-only.js).
//
//   node scripts/skip-local-only.js <paths-file>
//
// The file is rewritten in place. It reads the local store and the derivations in it, so it
// only runs where the paths were built.
//
// It never drops a path it is unsure of: if Nix cannot be asked, every path stays.

const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { parsePathInfo } = require('../src/upstream-signed');
const { localOnlyOutputs, partitionLocalOnly } = require('../src/local-only');

const run = promisify(execFile);
const BATCH = 200;
const BUFFER = 1024 * 1024 * 1024;

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: skip-local-only.js <paths-file>');
  const paths = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (!paths.length) return;
  const nix = process.env.NIX_BIN || 'nix';

  // The closure of every path, with references and derivers.
  const raw = [];
  for (let i = 0; i < paths.length; i += BATCH) {
    const { stdout } = await run(nix, ['path-info', '--json', '--recursive', ...paths.slice(i, i + BATCH)], { maxBuffer: BUFFER });
    raw.push(JSON.parse(stdout));
  }
  const infos = new Map();
  const derivers = new Set();
  for (const data of raw) {
    for (const [p, info] of parsePathInfo(data)) infos.set(p, info);
    const entries = Array.isArray(data) ? data.map(i => [i && i.path, i]) : Object.entries(data || {});
    for (const [, info] of entries) {
      const d = info && info.deriver;
      if (typeof d === 'string') derivers.add(d.startsWith('/') ? d : `/nix/store/${d}`);
    }
  }

  // Derivations of paths that were downloaded from a cache may not be in the store. Their
  // outputs were fetched from a cache, so they are not local-only anyway.
  const present = [...derivers].filter(d => fs.existsSync(d));
  const localOnly = new Set();
  for (let i = 0; i < present.length; i += BATCH) {
    const { stdout } = await run(nix, ['derivation', 'show', ...present.slice(i, i + BATCH)], { maxBuffer: BUFFER });
    for (const p of localOnlyOutputs(stdout)) localOnly.add(p);
  }

  const { held, rest } = partitionLocalOnly(paths, infos, localOnly);
  fs.writeFileSync(file, rest.map(p => `${p}\n`).join(''));
  for (const p of held) console.log(`  skipped (${localOnly.has(p) ? 'local-only' : 'depends on a local-only path'}): ${p}`);
  console.log(`Skipped ${held.length} local-only store path(s) and their dependents; ${rest.length} left`);
}

main().catch(err => {
  // Publishing everything is slower but never wrong, so a failure here stops nothing.
  console.log(`::warning::Skipping local-only paths failed; all paths are kept. ${String(err.message).split('\n')[0]}`);
});
