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
//
// A store can lose the `ca` of a path it got from a binary cache whose narinfo left it out.
// A path added by its NAR hash (a flake input, builtins.path, fetchTree, fetchzip) can still
// be told apart: its name in the store is made from that hash, so the name is checked.

const crypto = require('crypto');
const path = require('path');
const { parsePathInfo, nixBase32 } = require('./upstream-signed');

const BASE32 = '0123456789abcdfghijklmnpqrsvwxyz';

/** Reads Nix's base-32 back into bytes; null if it is not that. */
function fromNixBase32(s) {
  const bytes = Buffer.alloc(Math.floor((s.length * 5) / 8));
  for (let n = 0; n < s.length; n++) {
    const digit = BASE32.indexOf(s[s.length - 1 - n]);
    if (digit < 0) return null;
    const b = n * 5;
    const i = b >> 3;
    const j = b & 7;
    bytes[i] |= (digit << j) & 0xff;
    if (i + 1 < bytes.length) bytes[i + 1] |= digit >> (8 - j);
    else if (digit >> (8 - j)) return null;
  }
  return bytes;
}

/**
 * Whether a path's name in the store is the one Nix gives a path added by the SHA-256 of
 * its NAR (makeFixedOutputPath with the NAR method), which only such a path can have.
 */
function isNarAddressed(info) {
  if (!info || typeof info.storePath !== 'string' || typeof info.narHash !== 'string') return false;
  const m = /^sha256:([0-9a-df-np-sv-z]{52})$/.exec(info.narHash);
  const hash = m && fromNixBase32(m[1]);
  if (!hash) return false;
  const storeDir = path.dirname(info.storePath);
  const base = path.basename(info.storePath);
  const name = base.slice(33);
  if (base[32] !== '-' || !name) return false;
  const refs = [...(info.references || [])].sort();
  const type = ['source', ...refs.filter(r => r !== info.storePath), ...(refs.includes(info.storePath) ? ['self'] : [])].join(':');
  const digest = crypto.createHash('sha256').update(`${type}:sha256:${hash.toString('hex')}:${storeDir}:${name}`).digest();
  const short = Buffer.alloc(20);
  for (let i = 0; i < digest.length; i++) short[i % 20] ^= digest[i];
  return nixBase32(short) === base.slice(0, 32);
}

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
    (info && (isFixedOutput(info.ca) || (!info.ca && isNarAddressed(info))) ? fixed : rest).push(p);
  }
  return { fixed, rest };
}

module.exports = { isFixedOutput, isNarAddressed, partitionFixedOutput, parsePathInfo };
