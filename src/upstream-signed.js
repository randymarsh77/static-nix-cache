'use strict';

// Which store paths a trusted upstream cache has signed.
//
// A path that carries a valid signature from an upstream cache came from that cache, so
// publishing it again would only mirror it. Deploy would find that out anyway, by asking the
// upstream cache about each path over the network; a signature answers the same question
// from what the local store already knows, with no request at all.
//
// The signature is verified here, not taken at its word: a store records whatever signatures
// came with a path, and a path copied in from a store that is trusted without signatures
// could carry one that is not genuine.

const { verifyNarinfo } = require('./signing');

/** Public keys of upstream caches that are known without being told. */
const WELL_KNOWN_KEYS = {
  'https://cache.nixos.org': 'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=',
};

const BASE32 = '0123456789abcdfghijklmnpqrsvwxyz';

/** Nix's own base-32, which is not RFC 4648: it reads the bytes from the end. */
function nixBase32(bytes) {
  const length = Math.ceil((bytes.length * 8) / 5);
  let out = '';
  for (let n = length - 1; n >= 0; n--) {
    const b = n * 5;
    const i = Math.floor(b / 8);
    const j = b % 8;
    const c = (bytes[i] >> j) | (i + 1 < bytes.length ? bytes[i + 1] << (8 - j) : 0);
    out += BASE32[c & 0x1f];
  }
  return out;
}

/**
 * A NAR hash as a signature covers it: "sha256:" and Nix base-32. Nix reports hashes in
 * several spellings depending on its version (SRI, hex, base-32).
 * @returns {string|null} null for a hash that is not SHA-256 or cannot be read
 */
function narHashForFingerprint(hash) {
  if (typeof hash !== 'string') return null;
  const sri = /^sha256-([A-Za-z0-9+/]+=*)$/.exec(hash);
  if (sri) {
    const bytes = Buffer.from(sri[1], 'base64');
    return bytes.length === 32 ? `sha256:${nixBase32(bytes)}` : null;
  }
  const plain = /^sha256:(.+)$/.exec(hash);
  if (!plain) return null;
  if (/^[0-9a-f]{64}$/.test(plain[1])) return `sha256:${nixBase32(Buffer.from(plain[1], 'hex'))}`;
  if (/^[0-9a-df-np-sv-z]{52}$/.test(plain[1])) return hash;
  return null;
}

/**
 * The keys to check signatures against: the ones given, and the well-known key of each
 * upstream cache that has one.
 * @param {string[]} upstreamCaches - cache URLs
 * @param {string[]} publicKeys     - "<name>:<base64>" keys
 */
function upstreamKeys(upstreamCaches = [], publicKeys = []) {
  const keys = new Set(publicKeys.filter(Boolean));
  for (const url of upstreamCaches) {
    const known = WELL_KNOWN_KEYS[url.replace(/\/+$/, '')];
    if (known) keys.add(known);
  }
  return [...keys];
}

/**
 * Reads the output of `nix path-info --json`, whose shape depends on the Nix version: an
 * object keyed by path, or a list of objects that each name their path. A path Nix does not
 * have is absent or null, and is left out here.
 * @returns {Map<string, object>} store path -> its information
 */
function parsePathInfo(json, storeDir = '/nix/store') {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const entries = Array.isArray(data)
    ? data.map(info => [info && info.path, info])
    : Object.entries(data || {});
  const full = p => (p.startsWith('/') ? p : `${storeDir}/${p}`);
  const infos = new Map();
  for (const [path, info] of entries) {
    if (!path || !info || typeof info !== 'object') continue;
    infos.set(full(path), {
      storePath: full(path),
      narHash: narHashForFingerprint(info.narHash),
      narSize: info.narSize,
      references: (info.references || []).map(full),
      signatures: info.signatures || [],
    });
  }
  return infos;
}

/** Whether one of the keys made a valid signature the path carries. */
function signedBy(info, keys) {
  if (!info || !info.narHash || !Number.isInteger(info.narSize)) return false;
  for (const key of keys) {
    const name = key.slice(0, key.indexOf(':'));
    for (const sig of info.signatures) {
      if (sig.slice(0, sig.indexOf(':')) !== name) continue;
      try {
        if (verifyNarinfo(info, sig, key)) return true;
      } catch {
        // A key or signature that cannot be read signs nothing.
      }
    }
  }
  return false;
}

/**
 * Splits store paths into those an upstream cache signed and the rest. A path whose
 * information is missing is kept with the rest, so that it is still published.
 * @param {string[]} paths
 * @param {Map<string, object>} infos - from parsePathInfo
 * @param {string[]} keys
 */
function partition(paths, infos, keys) {
  const signed = [];
  const rest = [];
  for (const p of paths) (signedBy(infos.get(p), keys) ? signed : rest).push(p);
  return { signed, rest };
}

module.exports = { WELL_KNOWN_KEYS, nixBase32, narHashForFingerprint, upstreamKeys, parsePathInfo, signedBy, partition };
