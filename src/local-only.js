'use strict';

// Which store paths should be built where they are used, rather than fetched from a cache.
//
// A derivation says so with `allowSubstitutes = false`: Nix then never looks for its output in
// a binary cache. nixpkgs' trivial builders (runCommandLocal, writeText, symlinkJoin and the
// like) set it, because building their output is quicker than fetching it; so can anything
// that only repackages a download, such as a macOS app unpacked from a .dmg.
//
// Leaving such a path out of the list of paths to publish is not enough: `nix copy` copies the
// whole closure of each path it is given, so anything that depends on one would bring it
// along. Every path whose closure holds a local-only path is left out too. Whoever needs those
// builds them, and still fetches everything else they depend on from the cache.

/**
 * Whether a derivation, as `nix derivation show` reports it, sets allowSubstitutes = false.
 * Nix passes false to the builder as "" in env; with __structuredAttrs it is kept as false,
 * in `structuredAttrs` (format 4) or in the `__json` env entry (older formats).
 */
function isLocalOnly(drv) {
  if (!drv || typeof drv !== 'object') return false;
  const env = drv.env || {};
  if ('allowSubstitutes' in env) return env.allowSubstitutes === '' || env.allowSubstitutes === '0';
  if (drv.structuredAttrs && 'allowSubstitutes' in drv.structuredAttrs) {
    return drv.structuredAttrs.allowSubstitutes === false;
  }
  if (typeof env.__json === 'string') {
    try {
      return JSON.parse(env.__json).allowSubstitutes === false;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * The outputs of the local-only derivations in `nix derivation show` output. Format 4 nests
 * derivations under `derivations` and gives paths relative to the store; older formats give a
 * map of derivation paths with whole output paths.
 * @returns {Set<string>}
 */
function localOnlyOutputs(json, storeDir = '/nix/store') {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const drvs = data && data.derivations && typeof data.version === 'number' ? data.derivations : data || {};
  const full = p => (p.startsWith('/') ? p : `${storeDir}/${p}`);
  const out = new Set();
  for (const drv of Object.values(drvs)) {
    if (!isLocalOnly(drv)) continue;
    for (const o of Object.values(drv.outputs || {})) {
      if (o && typeof o.path === 'string') out.add(full(o.path));
    }
  }
  return out;
}

/**
 * Splits paths into those that are local-only or depend on one, and the rest.
 * @param {string[]} paths
 * @param {Map<string, {references: string[]}>} infos - the closure of the paths, from parsePathInfo
 * @param {Set<string>} localOnly
 */
function partitionLocalOnly(paths, infos, localOnly) {
  const memo = new Map();
  // Whether a path's closure holds a local-only path. A path is in progress (false) while its
  // references are visited, so a reference cycle, which Nix allows for a path and itself, ends.
  const holds = p => {
    if (memo.has(p)) return memo.get(p);
    memo.set(p, false);
    let result = localOnly.has(p);
    const info = infos.get(p);
    if (!result && info) {
      for (const r of info.references) {
        if (r !== p && holds(r)) {
          result = true;
          break;
        }
      }
    }
    memo.set(p, result);
    return result;
  };
  const held = [];
  const rest = [];
  for (const p of paths) (holds(p) ? held : rest).push(p);
  return { held, rest };
}

module.exports = { isLocalOnly, localOnlyOutputs, partitionLocalOnly };
