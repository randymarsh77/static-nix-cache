'use strict';

// Which store paths are the outputs of fixed-output derivations.
//
// A fixed-output derivation declares the hash of what it produces before it runs: fetchurl,
// fetchzip, fetchFromGitHub and every derivation that only downloads a file. Nix records
// such an output as content-addressed, and `nix path-info` reports that as its `ca`. A
// derivation that builds something has no `ca`.
//
// Leaving such a path out of the list of paths to publish does not leave it out of the
// cache when something published depends on it: `nix copy` copies the whole closure of
// each path it is given. Only a download that nothing published refers to is left out,
// and anyone who needs it can download it again from where it came from.

const { parsePathInfo } = require('./upstream-signed');

/**
 * Whether a `ca` as `nix path-info --json` reports it is a fixed-output one. Older Nix
 * spells it "fixed:[r:]<hash>"; newer Nix, with --json-format 2, as { method, hash },
 * where the method is "flat", "nar" or "git". A "text" one is a file written by
 * builtins.toFile, not downloaded, and is not counted.
 */
function isFixedOutput(ca) {
  if (typeof ca === 'string') return ca.startsWith('fixed:');
  if (ca && typeof ca === 'object') return ['flat', 'nar', 'git'].includes(ca.method);
  return false;
}

/**
 * Splits store paths into fixed-output ones and the rest. A path whose information is
 * missing is kept with the rest, so that it is still published.
 * @param {string[]} paths
 * @param {Map<string, object>} infos - from parsePathInfo
 */
function partitionFixedOutput(paths, infos) {
  const fixed = [];
  const rest = [];
  for (const p of paths) {
    const info = infos.get(p);
    (info && isFixedOutput(info.ca) ? fixed : rest).push(p);
  }
  return { fixed, rest };
}

module.exports = { isFixedOutput, partitionFixedOutput, parsePathInfo };
