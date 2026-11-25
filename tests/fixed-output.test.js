'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { isFixedOutput, isNarAddressed, partitionFixedOutput, parsePathInfo } = require('../src/fixed-output');

// As `nix path-info --json` reports them: a fetchurl download, a flake source, a file from
// builtins.toFile and a built package.
const TARBALL = '/nix/store/0h57mfxkbknssam7vympjkaqwxysx2g3-tart.tar.gz';
const SOURCE = '/nix/store/001dbxcqzzvvd2r8jpycnh8v97j21y42-source';
const TEXT = '/nix/store/0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-builder.sh';
const BUILT = '/nix/store/9pdb06dd20llf44530wxr1a6wa759z8h-bash-5.3p3';
const info = ca => ({ ca, narHash: 'sha256-hdHlSGUQbG/9Ay1k8jS4b/muSueuCXh0oiPRu6n80zk=', narSize: 1, references: [], signatures: [] });
const real = {
  [TARBALL]: info('fixed:sha256:1s6780adxhrhw4xklnm3dkj2qlbcxjhv3216wjhrhr4asyw8lan7'),
  [SOURCE]: info('fixed:r:sha256:0bw9c20lg31w3vrgg2r7qpr831gj5hlbn3jgmqwhs1gpmf2mxwd6'),
  [TEXT]: info('text:sha256:0bw9c20lg31w3vrgg2r7qpr831gj5hlbn3jgmqwhs1gpmf2mxwd6'),
  [BUILT]: info(null),
};

describe('what counts as downloaded', () => {
  test('fixed-output content addresses, in either spelling', () => {
    expect(isFixedOutput('fixed:sha256:abc')).toBe(true);
    expect(isFixedOutput('fixed:r:sha256:abc')).toBe(true);
    expect(isFixedOutput({ method: 'flat', hash: 'sha256-abc' })).toBe(true);
    expect(isFixedOutput({ method: 'nar', hash: 'sha256-abc' })).toBe(true);
  });

  test('not a built path or a builtins.toFile one', () => {
    expect(isFixedOutput(null)).toBe(false);
    expect(isFixedOutput(undefined)).toBe(false);
    expect(isFixedOutput('text:sha256:abc')).toBe(false);
    expect(isFixedOutput({ method: 'text', hash: 'sha256-abc' })).toBe(false);
  });

  test('a flake source that lost its ca is known by its name in the store', () => {
    // Nix's own source, as a store that got it from a binary cache without a CA line has it.
    const nixSource = {
      storePath: '/nix/store/04n19whd1y6w2dk5pr3m99dhyfy4j8pw-source',
      narHash: 'sha256-mZiNGyjdUVlfEvllLQKVK0ZbkxWIAC42jjERazi+lfU=',
      narSize: 10617656,
      references: [],
      signatures: [],
      ca: null,
    };
    const [info] = parsePathInfo({ [nixSource.storePath]: nixSource }).values();
    expect(isNarAddressed(info)).toBe(true);
    expect(partitionFixedOutput([nixSource.storePath], parsePathInfo({ [nixSource.storePath]: nixSource })).fixed).toEqual([nixSource.storePath]);
    // The same contents under another name, or with another hash, are not.
    expect(isNarAddressed({ ...info, storePath: '/nix/store/04n19whd1y6w2dk5pr3m99dhyfy4j8pw-other' })).toBe(false);
    expect(isNarAddressed({ ...info, storePath: BUILT })).toBe(false);
    expect(isNarAddressed({ ...info, references: [BUILT] })).toBe(false);
    expect(isNarAddressed({ ...info, narHash: null })).toBe(false);
  });

  test('downloads are split off; built, text and unknown paths are kept', () => {
    const unknown = '/nix/store/aaaa-unknown';
    expect(partitionFixedOutput([TARBALL, SOURCE, TEXT, BUILT, unknown], parsePathInfo(real))).toEqual({
      fixed: [TARBALL, SOURCE],
      rest: [TEXT, BUILT, unknown],
    });
  });
});

describe('the script save and deploy run', () => {
  const script = path.resolve(__dirname, '../scripts/skip-fixed-output.js');
  function runScript(paths, env = {}, body = 'echo "$@" > "$NIX_FAKE_ARGS"; cat "$NIX_FAKE_JSON"') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-fixed-'));
    const file = path.join(dir, 'paths.txt');
    const json = path.join(dir, 'info.json');
    const args = path.join(dir, 'args');
    const bin = path.join(dir, 'nix');
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    fs.writeFileSync(file, paths.map(p => `${p}\n`).join(''));
    fs.writeFileSync(json, JSON.stringify(real));
    const out = execFileSync(process.execPath, [script, file], {
      env: { PATH: process.env.PATH, NIX_BIN: bin, NIX_FAKE_JSON: json, NIX_FAKE_ARGS: args, ...env },
      encoding: 'utf8',
    });
    return {
      out,
      left: fs.readFileSync(file, 'utf8').split('\n').filter(Boolean),
      args: fs.existsSync(args) ? fs.readFileSync(args, 'utf8').trim() : '',
    };
  }

  test('drops downloads and keeps what was built', () => {
    const { out, left } = runScript([TARBALL, BUILT]);
    expect(left).toEqual([BUILT]);
    expect(out).toContain(`skipped (fixed-output): ${TARBALL}`);
    expect(out).toContain('Skipped 1 fixed-output store path(s); 1 left');
  });

  test('asks the store it is given', () => {
    const { args } = runScript([BUILT], { NIX_STORE_URL: 'file:///tmp/export' });
    expect(args).toBe(`path-info --json --store file:///tmp/export ${BUILT}`);
  });

  test('when Nix cannot be asked, every path stays', () => {
    const { out, left } = runScript([TARBALL, BUILT], {}, 'echo broken >&2; exit 1');
    expect(left).toEqual([TARBALL, BUILT]);
    expect(out).toContain('::warning::');
  });
});
