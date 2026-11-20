'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { repairEmptyFields } = require('../src/narinfo');
const { addSignature } = require('../src/routes/cache');
const { generateStaticSite } = require('../src/generate-static');

// Nix takes a field's value from two characters past the colon, so an empty
// field has to keep its space: "References: ", never "References:".

function signingKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return `test-1:${Buffer.concat([seed, pub]).toString('base64')}`;
}

const noReferences =
  'StorePath: /nix/store/fd12fcwb7yfr54xpsxxnb7568v60iddh-pkg\n' +
  'URL: nar/abc.nar.xz\nCompression: xz\n' +
  'NarHash: sha256:17bi0vjvij868cvc8si0cg9hnvh7acm85qrbjy2kyy1l21mhl444\n' +
  'NarSize: 100\nReferences: \n';

describe('a narinfo with no references', () => {
  test('keeps the space after "References:" when it is signed', () => {
    const signed = addSignature(noReferences, signingKey());
    expect(signed).toMatch(/\nReferences: \nSig: test-1:[A-Za-z0-9+/]+=*\n$/);
  });

  test('replaces a signature it already had', () => {
    const signed = addSignature(`${noReferences}Sig: other-1:AAAA\n`, signingKey());
    expect(signed).not.toContain('other-1');
    expect(signed).toMatch(/\nReferences: \nSig: test-1:/);
  });

  test('is repaired when it was stored without the space', () => {
    const broken = noReferences.replace('References: \n', 'References:\n') + 'Sig: test-1:AAAA\n';
    expect(repairEmptyFields(broken)).toBe(`${noReferences}Sig: test-1:AAAA\n`);
  });

  test('is left alone when it is already right', () => {
    const fine = `${noReferences}Sig: test-1:AAAA\n`;
    expect(repairEmptyFields(fine)).toBe(fine);
    const withRefs = fine.replace('References: \n', 'References: abc-a def-b\n');
    expect(repairEmptyFields(withRefs)).toBe(withRefs);
  });

  test('is published repaired', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'narinfo-'));
    const narinfoDir = path.join(dir, 'narinfo');
    const outputDir = path.join(dir, 'out');
    await fsp.mkdir(narinfoDir);
    const broken = noReferences.replace('References: \n', 'References:\n') + 'Sig: test-1:AAAA\n';
    await fsp.writeFile(path.join(narinfoDir, 'abc.narinfo'), broken);
    await generateStaticSite({
      narinfoDirPath: narinfoDir, outputDir,
      githubOwner: 'o', githubRepo: 'r', githubReleaseTag: 'nix-cache',
    });
    const out = await fsp.readFile(path.join(outputDir, 'abc.narinfo'), 'utf8');
    expect(out).toContain('\nReferences: \nSig: test-1:AAAA\n');
    await fsp.rm(dir, { recursive: true });
  });
});
