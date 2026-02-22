'use strict';

const { fingerprint, signNarinfo, verifyNarinfo } = require('../src/signing');
const crypto = require('crypto');

// Generate a real ed25519 key pair for tests
function generateTestKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  // PKCS8 for ed25519: 48 bytes total, last 32 are the seed
  const seed = privDer.slice(16);

  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  // SPKI for ed25519: 44 bytes total, last 32 are the public key
  const pubBytes = pubDer.slice(12);

  // Nix stores 64-byte (seed || pubkey)
  const nixPrivKey = `test-1:${Buffer.concat([seed, pubBytes]).toString('base64')}`;
  const nixPubKey = `test-1:${pubBytes.toString('base64')}`;

  return { nixPrivKey, nixPubKey };
}

describe('signing', () => {
  const sampleNarinfo = {
    storePath: '/nix/store/aaaabbbbccccdddd0000000000000000-example-1.0',
    narHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    narSize: 12345,
    references: [
      '/nix/store/aaaabbbbccccdddd0000000000000000-example-1.0',
    ],
  };

  test('fingerprint produces expected format', () => {
    const fp = fingerprint(sampleNarinfo);
    expect(fp).toBe(
      '1;' +
      '/nix/store/aaaabbbbccccdddd0000000000000000-example-1.0;' +
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;' +
      '12345;' +
      '/nix/store/aaaabbbbccccdddd0000000000000000-example-1.0'
    );
  });

  test('fingerprint with no references', () => {
    const fp = fingerprint({ ...sampleNarinfo, references: [] });
    expect(fp).toMatch(/^1;.*;sha256:[^;]+;12345;$/);
  });

  test('signNarinfo returns "<keyname>:<base64>"', () => {
    const { nixPrivKey } = generateTestKeyPair();
    const sig = signNarinfo(sampleNarinfo, nixPrivKey);
    expect(sig).toMatch(/^test-1:[A-Za-z0-9+/]+=*$/);
  });

  test('verifyNarinfo verifies a signature produced by signNarinfo', () => {
    const { nixPrivKey, nixPubKey } = generateTestKeyPair();
    const sig = signNarinfo(sampleNarinfo, nixPrivKey);
    expect(verifyNarinfo(sampleNarinfo, sig, nixPubKey)).toBe(true);
  });

  test('verifyNarinfo rejects tampered narinfo', () => {
    const { nixPrivKey, nixPubKey } = generateTestKeyPair();
    const sig = signNarinfo(sampleNarinfo, nixPrivKey);
    const tampered = { ...sampleNarinfo, narSize: 99999 };
    expect(verifyNarinfo(tampered, sig, nixPubKey)).toBe(false);
  });

  test('verifyNarinfo rejects signature from different key', () => {
    const { nixPrivKey } = generateTestKeyPair();
    const { nixPubKey: otherPub } = generateTestKeyPair();
    const sig = signNarinfo(sampleNarinfo, nixPrivKey);
    expect(verifyNarinfo(sampleNarinfo, sig, otherPub)).toBe(false);
  });
});
