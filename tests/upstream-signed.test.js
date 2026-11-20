'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { signNarinfo } = require('../src/signing');
const {
  WELL_KNOWN_KEYS, nixBase32, narHashForFingerprint, upstreamKeys, parsePathInfo, signedBy, partition,
} = require('../src/upstream-signed');

// A real path from cache.nixos.org, as `nix path-info --json` reports it, with the
// signature cache.nixos.org gave it.
const ZSTD = '/nix/store/00dp9q2diqb3qvmyyl0rw28dxip6k7mv-zstd-1.5.7-bin';
const real = {
  [ZSTD]: {
    narHash: 'sha256-Dj/csXAFAUSdcMLxP+rk4xWd722XI04KzoX3KYJEWiA=',
    narSize: 351832,
    references: [
      '/nix/store/00dp9q2diqb3qvmyyl0rw28dxip6k7mv-zstd-1.5.7-bin',
      '/nix/store/1f27cg7wimnj4q3zhzcpav9j39m1cfz1-zstd-1.5.7',
      '/nix/store/hqlmh6qmh2qx3wg4yw41fclr4vgp0p8w-bash-5.3p9',
      '/nix/store/qy3p3aisfxyknwk0szqqmlzyxjvzfnc2-gnugrep-3.12',
    ],
    signatures: ['cache.nixos.org-1:f8MkYV0JN3tkQG21bwe5PgRyvXLpz/3qE4RhKg1MjjGkc9Y+5+H2iW/V6cRrrS3kcCJEetdMcZwyo0iTeCNxAA=='],
    ultimate: false,
  },
};
const NIXOS = WELL_KNOWN_KEYS['https://cache.nixos.org'];
const BUILT = '/nix/store/1k38946v5mslgvklqg0kcwvmpf4h9zxl-terraform-1.15.3';

describe('hashes as a signature covers them', () => {
  test("Nix's base-32", () => {
    // sha256 of the empty string, as `nix hash convert --to nix32` prints it.
    const empty = Buffer.from('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'hex');
    expect(nixBase32(empty)).toBe('0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73');
  });

  test('every spelling Nix uses becomes the same one', () => {
    const base32 = 'sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73';
    expect(narHashForFingerprint('sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=')).toBe(base32);
    expect(narHashForFingerprint('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(base32);
    expect(narHashForFingerprint(base32)).toBe(base32);
    expect(narHashForFingerprint('sha512-abc')).toBeNull();
    expect(narHashForFingerprint(undefined)).toBeNull();
  });
});

describe('which keys count', () => {
  test('cache.nixos.org is known; others are given', () => {
    expect(upstreamKeys(['https://cache.nixos.org/'])).toEqual([NIXOS]);
    expect(upstreamKeys(['https://example.org'], ['mine-1:AAAA'])).toEqual(['mine-1:AAAA']);
    expect(upstreamKeys([], [])).toEqual([]);
  });
});

describe('a signature is verified, not taken at its word', () => {
  const infos = parsePathInfo(real);

  test('a real cache.nixos.org signature verifies', () => {
    expect(signedBy(infos.get(ZSTD), [NIXOS])).toBe(true);
  });

  test('not with another key of the same name', () => {
    const other = 'cache.nixos.org-1:AAAAdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=';
    expect(signedBy(infos.get(ZSTD), [other])).toBe(false);
  });

  test('not when what was signed has changed', () => {
    expect(signedBy({ ...infos.get(ZSTD), narSize: 351833 }, [NIXOS])).toBe(false);
    expect(signedBy({ ...infos.get(ZSTD), references: [] }, [NIXOS])).toBe(false);
  });

  test('not a path with no signature, or one that cannot be read', () => {
    expect(signedBy({ ...infos.get(ZSTD), signatures: [] }, [NIXOS])).toBe(false);
    expect(signedBy({ ...infos.get(ZSTD), signatures: ['cache.nixos.org-1:not base64!'] }, [NIXOS])).toBe(false);
    expect(signedBy(undefined, [NIXOS])).toBe(false);
  });
});

describe("what Nix says of paths, in each version's shape", () => {
  test('an object keyed by path, with a path Nix does not have', () => {
    const infos = parsePathInfo(JSON.stringify({ ...real, '/nix/store/aaaa-missing': null }));
    expect([...infos.keys()]).toEqual([ZSTD]);
  });

  test('a list of objects that name their path, with bare names for references', () => {
    const { references, ...rest } = real[ZSTD];
    const infos = parsePathInfo([{ path: path.basename(ZSTD), references: references.map(r => path.basename(r)), ...rest }]);
    expect(signedBy(infos.get(ZSTD), [NIXOS])).toBe(true);
  });
});

describe('what is left to publish', () => {
  test('signed paths are skipped; unsigned, locally built and unknown ones are kept', () => {
    const infos = parsePathInfo({ ...real, [BUILT]: { narHash: real[ZSTD].narHash, narSize: 1, references: [], signatures: [], ultimate: true } });
    expect(partition([ZSTD, BUILT, '/nix/store/aaaa-unknown'], infos, [NIXOS])).toEqual({
      signed: [ZSTD],
      rest: [BUILT, '/nix/store/aaaa-unknown'],
    });
  });
});

describe('the script deploy runs', () => {
  const script = path.resolve(__dirname, '../scripts/skip-upstream-signed.js');
  // Stands in for Nix: answers `nix path-info --json` with what is in NIX_FAKE_JSON.
  function fakeNix(dir, body) {
    const bin = path.join(dir, 'nix');
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return bin;
  }
  function runScript(paths, env, body = 'cat "$NIX_FAKE_JSON"') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-signed-'));
    const file = path.join(dir, 'paths.txt');
    const json = path.join(dir, 'info.json');
    fs.writeFileSync(file, paths.map(p => `${p}\n`).join(''));
    fs.writeFileSync(json, JSON.stringify(real));
    const out = execFileSync(process.execPath, [script, file], {
      env: { PATH: process.env.PATH, NIX_BIN: fakeNix(dir, body), NIX_FAKE_JSON: json, ...env },
      encoding: 'utf8',
    });
    return { out, left: fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) };
  }

  test('drops what cache.nixos.org signed and keeps the rest', () => {
    const { out, left } = runScript([ZSTD, BUILT], { UPSTREAM_CACHES: 'https://cache.nixos.org' });
    expect(left).toEqual([BUILT]);
    expect(out).toContain('Skipped 1 store path(s)');
  });

  test('with no upstream cache it changes nothing', () => {
    expect(runScript([ZSTD, BUILT], {}).left).toEqual([ZSTD, BUILT]);
  });

  test('when Nix cannot be asked, every path stays', () => {
    const { out, left } = runScript([ZSTD, BUILT], { UPSTREAM_CACHES: 'https://cache.nixos.org' }, 'echo broken >&2; exit 1');
    expect(left).toEqual([ZSTD, BUILT]);
    expect(out).toContain('::warning::');
  });

  test('a key deploy was given works like a known one', () => {
    const secret = 'mine-1:' + Buffer.concat([Buffer.alloc(32, 7), Buffer.alloc(32)]).toString('base64');
    const info = { storePath: BUILT, narHash: 'sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73', narSize: 5, references: [] };
    const sig = signNarinfo(info, secret);
    const crypto = require('crypto');
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]);
    const pub = crypto.createPublicKey(crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }))
      .export({ format: 'der', type: 'spki' }).subarray(-32);
    const infos = parsePathInfo({ [BUILT]: { narHash: info.narHash, narSize: 5, references: [], signatures: [sig] } });
    expect(partition([BUILT], infos, upstreamKeys([], [`mine-1:${pub.toString('base64')}`])).signed).toEqual([BUILT]);
  });
});
