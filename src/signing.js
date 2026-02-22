'use strict';

const crypto = require('crypto');

/**
 * Parse a Nix ed25519 key string in the format "<keyname>:<base64-encoded-key>".
 * @param {string} keyString
 * @returns {{ name: string, key: Buffer }}
 */
function parseKey(keyString) {
  const colonIdx = keyString.indexOf(':');
  if (colonIdx === -1) {
    throw new Error('Invalid Nix key format: expected "<keyname>:<base64-key>"');
  }
  const name = keyString.slice(0, colonIdx);
  const key = Buffer.from(keyString.slice(colonIdx + 1), 'base64');
  return { name, key };
}

/**
 * Build the fingerprint string that Nix signs for a narinfo entry.
 * @param {object} narinfo
 * @param {string} narinfo.storePath
 * @param {string} narinfo.narHash   - e.g. "sha256:abc..."
 * @param {number} narinfo.narSize
 * @param {string[]} narinfo.references - list of full store paths
 * @returns {string}
 */
function fingerprint(narinfo) {
  const refs = (narinfo.references || []).join(',');
  return `1;${narinfo.storePath};${narinfo.narHash};${narinfo.narSize};${refs}`;
}

/**
 * Sign a narinfo fingerprint with an ed25519 private key.
 *
 * Nix keys are 64-byte ed25519 seed+pubkey pairs (libsodium format).
 * Node's crypto module expects a PKCS#8 DER key, so we convert it.
 *
 * @param {object} narinfo
 * @param {string} privateKeyString - "<keyname>:<base64-encoded-64-byte-key>"
 * @returns {string} - signature in the form "<keyname>:<base64-signature>"
 */
function signNarinfo(narinfo, privateKeyString) {
  const { name, key } = parseKey(privateKeyString);

  // Nix stores 64-byte (seed || public-key) in libsodium format.
  // Node's createPrivateKey for ed25519 needs just the 32-byte seed.
  const seed = key.length === 64 ? key.slice(0, 32) : key;

  // Build PKCS#8 DER for an ed25519 private key (seed only, 32 bytes)
  // Structure: SEQUENCE { SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING { seed } } }
  const oid = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([oid, seed]);

  const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const msg = Buffer.from(fingerprint(narinfo));
  const sig = crypto.sign(null, msg, privateKey);
  return `${name}:${sig.toString('base64')}`;
}

/**
 * Verify a narinfo signature using an ed25519 public key.
 *
 * @param {object} narinfo
 * @param {string} sigString      - "<keyname>:<base64-signature>"
 * @param {string} publicKeyString - "<keyname>:<base64-encoded-32-byte-pubkey>"
 * @returns {boolean}
 */
function verifyNarinfo(narinfo, sigString, publicKeyString) {
  const { key: pubkeyBytes } = parseKey(publicKeyString);

  // Build SubjectPublicKeyInfo DER for ed25519 (32 bytes)
  const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
  const der = Buffer.concat([spkiHeader, pubkeyBytes]);

  const publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  const { key: sigBytes } = parseKey(sigString);
  const msg = Buffer.from(fingerprint(narinfo));
  return crypto.verify(null, msg, publicKey, sigBytes);
}

module.exports = { fingerprint, signNarinfo, verifyNarinfo };
