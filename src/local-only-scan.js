'use strict';

// Finds, in the local store, which of some store paths are local-only or depend on one
// (src/local-only.js has the rules). Used by skip-local-only, to leave them out of what is
// published, and by record-root, to leave them out of a root, so that copies a cache holds
// from before they were left out are collected.
//
// What makes a path local-only is its derivation, so each path's derivation must be found.
// The deriver a path records is not enough: a path fetched from a cache records whatever
// deriver that cache's narinfo gave, which may be none (a cache can leave it out) or one this
// store does not have. So the store is also asked which of its derivations produce each
// path: evaluating an expression writes its derivations, so whatever the build evaluated is
// found, however its outputs got into the store.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { parsePathInfo } = require('./upstream-signed');
const { localOnlyOutputs, partitionLocalOnly } = require('./local-only');

const run = promisify(execFile);
const BATCH = 200;
const BUFFER = 1024 * 1024 * 1024;

/** nix-store beside the given nix, so that both come from the same installation. */
function nixStoreBin(nix) {
  if (process.env.NIX_STORE_BIN) return process.env.NIX_STORE_BIN;
  return nix.includes('/') ? path.join(path.dirname(nix), 'nix-store') : 'nix-store';
}

/**
 * Splits paths into those held back (local-only, or depending on a local-only path) and the
 * rest. Throws when Nix cannot be asked; callers decide what that means.
 * @param {string[]} paths
 * @returns {Promise<{held: string[], rest: string[], localOnly: Set<string>, closure: string[], heldClosure: Set<string>}>}
 */
async function scanLocalOnly(paths, { nix = process.env.NIX_BIN || 'nix', log = () => {} } = {}) {
  // The closure of every path, with references and recorded derivers.
  const infos = new Map();
  const derivers = new Set();
  for (let i = 0; i < paths.length; i += BATCH) {
    const { stdout } = await run(nix, ['path-info', '--json', '--recursive', ...paths.slice(i, i + BATCH)], { maxBuffer: BUFFER });
    const data = JSON.parse(stdout);
    for (const [p, info] of parsePathInfo(data)) infos.set(p, info);
    const entries = Array.isArray(data) ? data.map(x => [x && x.path, x]) : Object.entries(data || {});
    for (const [, info] of entries) {
      const d = info && info.deriver;
      if (typeof d === 'string') derivers.add(d.startsWith('/') ? d : `/nix/store/${d}`);
    }
  }
  const closure = [...infos.keys()];

  // The derivations in this store that produce each path, whatever the path recorded.
  const nixStore = nixStoreBin(nix);
  try {
    for (let i = 0; i < closure.length; i += BATCH) {
      const { stdout } = await run(nixStore, ['--query', '--valid-derivers', ...closure.slice(i, i + BATCH)], { maxBuffer: BUFFER });
      for (const d of stdout.split('\n').map(s => s.trim()).filter(Boolean)) derivers.add(d);
    }
  } catch (err) {
    log(`::warning::Could not ask ${nixStore} for derivations; only the ones paths record are read. ${String(err.message).split('\n')[0]}`);
  }

  const present = [...derivers].filter(d => fs.existsSync(d));
  const localOnly = new Set();
  for (let i = 0; i < present.length; i += BATCH) {
    const { stdout } = await run(nix, ['derivation', 'show', ...present.slice(i, i + BATCH)], { maxBuffer: BUFFER });
    for (const p of localOnlyOutputs(stdout)) localOnly.add(p);
  }
  // Every path of the closure that is held back, then the given ones among them.
  const heldClosure = new Set(partitionLocalOnly(closure, infos, localOnly).held);
  const held = paths.filter(p => heldClosure.has(p));
  const rest = paths.filter(p => !heldClosure.has(p));
  return { held, rest, localOnly, closure, heldClosure };
}

module.exports = { scanLocalOnly, nixStoreBin };
