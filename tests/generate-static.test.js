'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { generateStaticSite } = require('../src/generate-static');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'static-nix-cache-static-test-'));
}

describe('generateStaticSite', () => {
  let tmpDir;
  let narinfoDir;
  let outputDir;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    narinfoDir = path.join(tmpDir, 'narinfo');
    outputDir = path.join(tmpDir, 'output');
    await fsp.mkdir(narinfoDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('generates nix-cache-info', async () => {
    const result = await generateStaticSite({
      narinfoDirPath: narinfoDir,
      outputDir,
      storeDir: '/nix/store',
      priority: 40,
      githubOwner: 'testowner',
      githubRepo: 'testrepo',
      githubReleaseTag: 'v1',
    });

    const cacheInfo = await fsp.readFile(path.join(outputDir, 'nix-cache-info'), 'utf8');
    expect(cacheInfo).toContain('StoreDir: /nix/store');
    expect(cacheInfo).toContain('WantMassQuery: 1');
    expect(cacheInfo).toContain('Priority: 40');
    expect(result.narinfoCount).toBe(0);
  });

  test('copies narinfo files to output directory', async () => {
    const narinfo1 = 'StorePath: /nix/store/abc-pkg\nNarHash: sha256:abc\nNarSize: 100\nURL: nar/abc.nar.xz\n';
    const narinfo2 = 'StorePath: /nix/store/def-pkg\nNarHash: sha256:def\nNarSize: 200\nURL: nar/def.nar.xz\n';
    await fsp.writeFile(path.join(narinfoDir, 'abc.narinfo'), narinfo1);
    await fsp.writeFile(path.join(narinfoDir, 'def.narinfo'), narinfo2);

    const result = await generateStaticSite({
      narinfoDirPath: narinfoDir,
      outputDir,
      githubOwner: 'testowner',
      githubRepo: 'testrepo',
      githubReleaseTag: 'nix-cache',
    });

    expect(result.narinfoCount).toBe(2);

    const out1 = await fsp.readFile(path.join(outputDir, 'abc.narinfo'), 'utf8');
    expect(out1).toBe(narinfo1.replace('nar/abc.nar.xz', 'https://github.com/testowner/testrepo/releases/download/nix-cache/abc.nar.xz'));

    const out2 = await fsp.readFile(path.join(outputDir, 'def.narinfo'), 'utf8');
    expect(out2).toBe(narinfo2.replace('nar/def.nar.xz', 'https://github.com/testowner/testrepo/releases/download/nix-cache/def.nar.xz'));
  });

  test('generates _redirects file for Cloudflare Pages', async () => {
    await generateStaticSite({
      narinfoDirPath: narinfoDir,
      outputDir,
      githubOwner: 'myorg',
      githubRepo: 'myproject',
      githubReleaseTag: 'cache-v2',
    });

    const redirects = await fsp.readFile(path.join(outputDir, '_redirects'), 'utf8');
    expect(redirects).toContain('/nar/:filename');
    expect(redirects).toContain('https://github.com/myorg/myproject/releases/download/cache-v2/:filename');
    expect(redirects).toContain('302');
  });

  test('uses default storeDir and priority when not specified', async () => {
    await generateStaticSite({
      narinfoDirPath: narinfoDir,
      outputDir,
      githubOwner: 'owner',
      githubRepo: 'repo',
      githubReleaseTag: 'tag',
    });

    const cacheInfo = await fsp.readFile(path.join(outputDir, 'nix-cache-info'), 'utf8');
    expect(cacheInfo).toContain('StoreDir: /nix/store');
    expect(cacheInfo).toContain('Priority: 30');
  });

  test('returns narBaseUrl in result', async () => {
    const result = await generateStaticSite({
      narinfoDirPath: narinfoDir,
      outputDir,
      githubOwner: 'testowner',
      githubRepo: 'testrepo',
      githubReleaseTag: 'v1',
    });

    expect(result.narBaseUrl).toBe('https://github.com/testowner/testrepo/releases/download/v1');
    expect(result.outputDir).toBe(outputDir);
  });

  test('handles empty narinfo directory gracefully', async () => {
    const result = await generateStaticSite({
      narinfoDirPath: path.join(tmpDir, 'nonexistent'),
      outputDir,
      githubOwner: 'owner',
      githubRepo: 'repo',
      githubReleaseTag: 'tag',
    });

    expect(result.narinfoCount).toBe(0);
    // Should still generate nix-cache-info and _redirects
    expect(fs.existsSync(path.join(outputDir, 'nix-cache-info'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, '_redirects'))).toBe(true);
  });
});

test('preserves sharded URLs and signatures on Pages', async () => {
  const dir = makeTempDir();
  try {
    const content = 'URL: https://github.com/o/r/releases/download/nix-cache-000002/file.nar.xz\nSig: test:signature\n';
    fs.writeFileSync(path.join(dir, 'abc.narinfo'), content);
    const outputDir = path.join(dir, 'site');
    await generateStaticSite({ narinfoDirPath: dir, outputDir, githubOwner: 'o', githubRepo: 'r', githubReleaseTag: 'nix-cache' });
    expect(fs.readFileSync(path.join(outputDir, 'abc.narinfo'), 'utf8')).toBe(content);
    expect(fs.existsSync(path.join(outputDir, '.nojekyll'))).toBe(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
