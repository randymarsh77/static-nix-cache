'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { isLocalOnly, localOnlyOutputs, partitionLocalOnly } = require('../src/local-only');
const { parsePathInfo } = require('../src/upstream-signed');

// A system, the app list it holds, an app unpacked from a .dmg, and a library both use.
const SYSTEM = '/nix/store/0f485yhkng5325aifhjxhdrdpx52pcdg-darwin-system-26.05';
const APPS = '/nix/store/6khd6xfqdapyb69ryaq7pnkfzly920cy-system-applications';
const APP = '/nix/store/k557ppmj2nqf51983m0p2xm1fss2f4q4-Blender-5.3.0';
const LIB = '/nix/store/9pdb06dd20llf44530wxr1a6wa759z8h-bash-5.3p3';
const TOOL = '/nix/store/2a3762ca17a143a697d06a80c720431b-mcc-agent-1.0';
const drvOf = p => `${p.replace('/nix/store/', '/nix/store/d')}.drv`;
const info = (references, deriver) => ({
  narHash: 'sha256-hdHlSGUQbG/9Ay1k8jS4b/muSueuCXh0oiPRu6n80zk=', narSize: 1, references, signatures: [], ca: null, deriver,
});
const closure = {
  [SYSTEM]: info([SYSTEM, APPS, LIB], drvOf(SYSTEM)),
  [APPS]: info([APP], drvOf(APPS)),
  [APP]: info([], drvOf(APP)),
  [LIB]: info([], drvOf(LIB)),
  [TOOL]: info([LIB], drvOf(TOOL)),
};

describe('what counts as local-only', () => {
  test('allowSubstitutes = false, however Nix passes it', () => {
    expect(isLocalOnly({ env: { allowSubstitutes: '' } })).toBe(true);
    expect(isLocalOnly({ env: { allowSubstitutes: '0' } })).toBe(true);
    expect(isLocalOnly({ env: {}, structuredAttrs: { allowSubstitutes: false } })).toBe(true);
    expect(isLocalOnly({ env: { __json: '{"allowSubstitutes":false}' } })).toBe(true);
  });

  test('not a derivation that allows substitutes or does not say', () => {
    expect(isLocalOnly({ env: { allowSubstitutes: '1' } })).toBe(false);
    expect(isLocalOnly({ env: { preferLocalBuild: '1' } })).toBe(false);
    expect(isLocalOnly({ env: {}, structuredAttrs: { allowSubstitutes: true } })).toBe(false);
    expect(isLocalOnly({ env: { __json: 'not json' } })).toBe(false);
    expect(isLocalOnly(null)).toBe(false);
  });

  test('outputs, from format 4 and from older formats', () => {
    const v4 = {
      version: 4,
      derivations: {
        'dk557-Blender-5.3.0.drv': { env: { allowSubstitutes: '' }, outputs: { out: { path: 'k557ppmj2nqf51983m0p2xm1fss2f4q4-Blender-5.3.0' } } },
        'd9pdb-bash.drv': { env: {}, outputs: { out: { path: '9pdb06dd20llf44530wxr1a6wa759z8h-bash-5.3p3' } } },
      },
    };
    expect([...localOnlyOutputs(v4)]).toEqual([APP]);
    const old = { '/nix/store/dk557-Blender-5.3.0.drv': { env: { allowSubstitutes: '' }, outputs: { out: { path: APP } } } };
    expect([...localOnlyOutputs(JSON.stringify(old))]).toEqual([APP]);
  });
});

describe('what is held back', () => {
  test('a local-only path and everything that depends on it; the rest is kept', () => {
    const infos = parsePathInfo(closure);
    expect(partitionLocalOnly([SYSTEM, APPS, APP, LIB, TOOL], infos, new Set([APP]))).toEqual({
      held: [SYSTEM, APPS, APP],
      rest: [LIB, TOOL],
    });
  });

  test('a path that refers to itself, and one with no information, are kept', () => {
    const infos = parsePathInfo(closure);
    expect(partitionLocalOnly([SYSTEM, '/nix/store/aaaa-unknown'], infos, new Set())).toEqual({
      held: [],
      rest: [SYSTEM, '/nix/store/aaaa-unknown'],
    });
  });
});

describe('the script save and deploy run', () => {
  const script = path.resolve(__dirname, '../scripts/skip-local-only.js');
  function runScript(paths, { broken = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-local-'));
    const file = path.join(dir, 'paths.txt');
    const infoJson = path.join(dir, 'info.json');
    const drvJson = path.join(dir, 'drv.json');
    const drvList = path.join(dir, 'drvs');
    const bin = path.join(dir, 'nix');
    // The derivations "exist" as files under dir, so that the script can tell which are present.
    const local = p => path.join(dir, path.basename(drvOf(p)));
    const withLocalDrvs = Object.fromEntries(Object.entries(closure).map(([p, i]) => [p, { ...i, deriver: local(p) }]));
    for (const p of [SYSTEM, APPS, APP, TOOL]) fs.writeFileSync(local(p), '');
    const drvs = {};
    for (const p of [SYSTEM, APPS, APP, TOOL]) {
      drvs[local(p)] = { env: p === APP ? { allowSubstitutes: '' } : {}, outputs: { out: { path: p } } };
    }
    fs.writeFileSync(infoJson, JSON.stringify(withLocalDrvs));
    fs.writeFileSync(drvJson, JSON.stringify(drvs));
    fs.writeFileSync(bin, broken
      ? '#!/bin/sh\necho broken >&2; exit 1\n'
      : `#!/bin/sh\ncase "$1" in\n  path-info) cat "${infoJson}" ;;\n  derivation) shift 2; echo "$@" > "${drvList}"; cat "${drvJson}" ;;\nesac\n`,
    { mode: 0o755 });
    fs.writeFileSync(file, paths.map(p => `${p}\n`).join(''));
    const out = execFileSync(process.execPath, [script, file], {
      env: { PATH: process.env.PATH, NIX_BIN: bin },
      encoding: 'utf8',
    });
    return {
      out,
      left: fs.readFileSync(file, 'utf8').split('\n').filter(Boolean),
      asked: fs.existsSync(drvList) ? fs.readFileSync(drvList, 'utf8').trim().split(' ') : [],
    };
  }

  test('drops local-only paths and their dependents, and keeps what was built', () => {
    const { out, left, asked } = runScript([SYSTEM, APPS, APP, TOOL]);
    expect(left).toEqual([TOOL]);
    expect(out).toContain(`skipped (local-only): ${APP}`);
    expect(out).toContain(`skipped (depends on a local-only path): ${SYSTEM}`);
    expect(out).toContain('Skipped 3 local-only store path(s) and their dependents; 1 left');
    // LIB's derivation is not in the store (it came from a cache), so it is not asked about.
    expect(asked).toHaveLength(4);
  });

  test('when Nix cannot be asked, every path stays', () => {
    const { out, left } = runScript([SYSTEM, TOOL], { broken: true });
    expect(left).toEqual([SYSTEM, TOOL]);
    expect(out).toContain('::warning::');
  });
});
