'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

// Mock fetch globally before requiring the module
const mockFetch = jest.fn();
global.fetch = mockFetch;

const GitHubReleasesStorage = require('../src/storage/github-releases');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencache-gh-test-'));
}

describe('GitHubReleasesStorage', () => {
  let tmpDir;
  let storage;

  const releaseResponse = { id: 42, tag_name: 'nix-cache' };

  beforeEach(() => {
    tmpDir = makeTempDir();
    storage = new GitHubReleasesStorage({
      token: 'ghp_testtoken',
      owner: 'testowner',
      repo: 'testrepo',
      releaseTag: 'nix-cache',
      localPath: tmpDir,
    });
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── narinfo (local) ────────────────────────────────────────────────────────

  test('hasNarinfo returns false for missing entry', async () => {
    expect(await storage.hasNarinfo('deadbeef')).toBe(false);
  });

  test('putNarinfo and getNarinfo round-trip', async () => {
    const content = 'StorePath: /nix/store/deadbeef-example\n';
    await storage.putNarinfo('deadbeef', content);
    expect(await storage.hasNarinfo('deadbeef')).toBe(true);
    expect(await storage.getNarinfo('deadbeef')).toBe(content);
  });

  test('getNarinfo returns null for missing entry', async () => {
    expect(await storage.getNarinfo('missing')).toBeNull();
  });

  // ── NAR (GitHub Releases) ─────────────────────────────────────────────────

  test('hasNar returns false when asset not found', async () => {
    // Mock: get release by tag
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => releaseResponse })
      // Mock: list assets returns empty
      .mockResolvedValueOnce({ ok: true, json: async () => [] });

    expect(await storage.hasNar('test.nar')).toBe(false);
  });

  test('hasNar returns true when asset exists', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => releaseResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: 'test.nar', id: 1, url: 'https://api.github.com/...' }],
      });

    expect(await storage.hasNar('test.nar')).toBe(true);
  });

  test('putNarStream uploads asset to GitHub Release', async () => {
    const data = Buffer.from('fake NAR data');
    const readable = Readable.from(data);

    mockFetch
      // Get release by tag
      .mockResolvedValueOnce({ ok: true, json: async () => releaseResponse })
      // List assets (check existing) - empty
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      // Upload asset
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 2, name: 'test.nar' }) });

    await storage.putNarStream('test.nar', readable);

    // Verify upload was called
    const uploadCall = mockFetch.mock.calls[2];
    expect(uploadCall[0]).toContain('uploads.github.com');
    expect(uploadCall[0]).toContain('name=test.nar');
    expect(uploadCall[1].method).toBe('POST');
  });

  test('putNarStream deletes existing asset before uploading', async () => {
    const data = Buffer.from('updated NAR data');
    const readable = Readable.from(data);

    mockFetch
      // Get release by tag
      .mockResolvedValueOnce({ ok: true, json: async () => releaseResponse })
      // List assets - existing asset found
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: 'test.nar', id: 99, url: 'https://api.github.com/...' }],
      })
      // Delete existing asset
      .mockResolvedValueOnce({ ok: true })
      // Upload new asset
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 100, name: 'test.nar' }) });

    await storage.putNarStream('test.nar', readable);

    // Verify delete was called for the existing asset
    const deleteCall = mockFetch.mock.calls[2];
    expect(deleteCall[0]).toContain('/releases/assets/99');
    expect(deleteCall[1].method).toBe('DELETE');
  });

  test('creates release if it does not exist', async () => {
    mockFetch
      // Get release by tag - 404
      .mockResolvedValueOnce({ ok: false, status: 404 })
      // Create release
      .mockResolvedValueOnce({ ok: true, json: async () => releaseResponse })
      // List assets
      .mockResolvedValueOnce({ ok: true, json: async () => [] });

    expect(await storage.hasNar('test.nar')).toBe(false);

    // Verify release creation was called
    const createCall = mockFetch.mock.calls[1];
    expect(createCall[0]).toContain('/releases');
    expect(createCall[1].method).toBe('POST');
    const body = JSON.parse(createCall[1].body);
    expect(body.tag_name).toBe('nix-cache');
  });

  test('narDownloadUrl returns correct public URL', () => {
    const url = storage.narDownloadUrl('abc123.nar.xz');
    expect(url).toBe('https://github.com/testowner/testrepo/releases/download/nix-cache/abc123.nar.xz');
  });

  test('authorization headers include token', () => {
    const headers = storage._headers();
    expect(headers.Authorization).toBe('token ghp_testtoken');
  });

  // ── Pruning ───────────────────────────────────────────────────────────────

  test('pruneAssets deletes orphaned assets', async () => {
    // Write a narinfo referencing only "referenced.nar.xz"
    const narinfo = 'StorePath: /nix/store/abc-example\nURL: nar/referenced.nar.xz\nNarHash: sha256:abc\nNarSize: 100\n';
    await storage.putNarinfo('abc', narinfo);

    const now = new Date().toISOString();

    mockFetch
      // Get release by tag
      .mockResolvedValueOnce({ ok: true, json: async () => releaseResponse })
      // List assets (page 1)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { name: 'referenced.nar.xz', id: 10, created_at: now },
          { name: 'orphaned.nar.xz', id: 11, created_at: now },
        ],
      })
      // Delete orphaned asset
      .mockResolvedValueOnce({ ok: true });

    const result = await storage.pruneAssets();

    expect(result.deleted).toEqual(['orphaned.nar.xz']);
    expect(result.referenced).toEqual(['referenced.nar.xz']);
    expect(result.kept).toEqual([]);

    // Verify the correct asset was deleted
    const deleteCall = mockFetch.mock.calls[2];
    expect(deleteCall[0]).toContain('/releases/assets/11');
    expect(deleteCall[1].method).toBe('DELETE');
  });

  test('pruneAssets respects retentionDays', async () => {
    // No narinfo files → all assets are orphaned
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const recentDate = new Date().toISOString();

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => releaseResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { name: 'old-orphan.nar.xz', id: 20, created_at: oldDate },
          { name: 'recent-orphan.nar.xz', id: 21, created_at: recentDate },
        ],
      })
      // Delete old orphan
      .mockResolvedValueOnce({ ok: true });

    const result = await storage.pruneAssets({ retentionDays: 7 });

    // Old orphan should be deleted, recent should be kept
    expect(result.deleted).toEqual(['old-orphan.nar.xz']);
    expect(result.kept).toEqual(['recent-orphan.nar.xz']);
    expect(result.referenced).toEqual([]);
  });

  test('pruneAssets with no orphaned assets deletes nothing', async () => {
    const narinfo = 'StorePath: /nix/store/abc-example\nURL: nar/only.nar.xz\nNarHash: sha256:abc\nNarSize: 100\n';
    await storage.putNarinfo('abc', narinfo);

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => releaseResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: 'only.nar.xz', id: 30, created_at: new Date().toISOString() }],
      });

    const result = await storage.pruneAssets();

    expect(result.deleted).toEqual([]);
    expect(result.referenced).toEqual(['only.nar.xz']);
    expect(result.kept).toEqual([]);
    // Only 2 fetch calls (get release + list assets), no deletes
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('pruneAssets with empty release returns empty results', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => releaseResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });

    const result = await storage.pruneAssets();

    expect(result.deleted).toEqual([]);
    expect(result.referenced).toEqual([]);
    expect(result.kept).toEqual([]);
  });
});
