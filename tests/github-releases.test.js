'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const Storage = require('../src/storage/github-releases');

// Stateful API fixture: persist releases/assets across independent writers,
// paginate listings, consume actual streaming request bodies, and enforce caps.
describe('GitHub release cache', () => {
  let dir, storage, releases, assets, nextId, originalFetch;
  const response = (value, status = 200) => ({ ok: status >= 200 && status < 300,
    status, headers: new Headers(), json: async () => value,
    text: async () => typeof value === 'string' ? value : JSON.stringify(value) });
  function makeStorage(extra = {}) {
    return new Storage({ token: 'test-token', owner: 'owner', repo: 'repo',
      releaseTag: 'nix-cache', localPath: dir,
      requestIntervalMs: 0, writeIntervalMs: 0, sleep: jest.fn(), ...extra });
  }
  function release(tag = 'nix-cache') {
    const r = { id: nextId++, tag_name: tag };
    releases.push(r);
    return r;
  }
  function asset(r, name, content = 'data') {
    const a = { id: nextId++, name, releaseId: r.id, content, state: 'uploaded',
      created_at: new Date().toISOString() };
    a.url = `https://api.github.com/repos/owner/repo/releases/assets/${a.id}`;
    assets.push(a);
    return a;
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
    nextId = 1; releases = []; assets = [];
    originalFetch = global.fetch;
    global.fetch = jest.fn(async (url, options = {}) => {
      const u = new URL(url);
      const method = options.method || 'GET';
      if (u.hostname === 'uploads.github.com') {
        const id = Number(u.pathname.match(/releases\/(\d+)/)[1]);
        const r = releases.find(r => r.id === id);
        const name = u.searchParams.get('name');
        if (assets.filter(a => a.releaseId === id).length >= 1000) return response('full', 422);
        if (assets.some(a => a.releaseId === id && a.name === name)) return response('duplicate', 422);
        const chunks = [];
        if (options.body instanceof Readable) {
          for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
        } else chunks.push(Buffer.from(options.body));
        const body = Buffer.concat(chunks);
        expect(Number(options.headers['Content-Length'])).toBe(body.length);
        return response(asset(r, name, body.toString()));
      }
      if (/\/releases\/assets\/\d+$/.test(u.pathname)) {
        const id = Number(u.pathname.split('/').pop());
        const a = assets.find(a => a.id === id);
        if (method === 'DELETE') { assets = assets.filter(a => a.id !== id); return response({}); }
        return a ? response(a.content) : response('missing', 404);
      }
      if (u.pathname.endsWith('/releases') && method === 'POST') {
        return response(release(JSON.parse(options.body).tag_name));
      }
      const start = (Number(u.searchParams.get('page')) - 1) * 100;
      if (u.pathname.endsWith('/releases')) return response(releases.slice(start, start + 100));
      const id = Number(u.pathname.match(/releases\/(\d+)\/assets/)[1]);
      return response(assets.filter(a => a.releaseId === id).slice(start, start + 100));
    });
    storage = makeStorage();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('read-only lookup does not create a release', async () => {
    expect(await storage.hasNar('missing.nar')).toBe(false);
    expect(await storage.hasNarinfo('missing')).toBe(false);
    expect(releases).toHaveLength(0);
  });

  test('streams NAR data and publishes durable metadata with absolute URL', async () => {
    await storage.putNarStream('abc.nar.xz', Readable.from('NAR contents'));
    await storage.putNarinfo('abc', 'URL: nar/abc.nar.xz\nSig: key:signature\n');
    const content = await storage.getNarinfo('abc');
    expect(content).toContain('URL: https://github.com/owner/repo/releases/download/nix-cache/abc.nar.xz');
    expect(content).toContain('Sig: key:signature');
    expect(assets.find(a => a.name === 'abc.nar.xz').content).toBe('NAR contents');
    expect(assets.find(a => a.name === 'abc.narinfo').content).toBe(content);
  });

  test('rolls over at capacity, even between NAR and metadata', async () => {
    storage = makeStorage({ maxAssets: 1 });
    await storage.putNarStream('abc.nar', Readable.from('data'));
    await storage.putNarinfo('abc', 'URL: nar/abc.nar\n');
    await storage.putNarStream('def.nar', Readable.from('data2'));
    await storage.putNarinfo('def', 'URL: nar/def.nar\n');
    expect(releases.map(r => r.tag_name)).toEqual([
      'nix-cache', 'nix-cache-000001', 'nix-cache-000002', 'nix-cache-000003']);
    expect(await storage.getNarinfo('def')).toContain('/nix-cache-000002/def.nar');
    // A fresh job reconstructs the complete index across both architectures/runs.
    fs.rmSync(path.join(dir, 'narinfo'), { recursive: true });
    storage = makeStorage();
    expect(await storage.fetchAllNarinfo()).toBe(2);
    expect(await storage.getNarinfo('abc')).toContain('/nix-cache/abc.nar');
    expect(await storage.getNarinfo('def')).toContain('/nix-cache-000002/def.nar');
  });

  test('legacy base release and paginated assets are indexed once', async () => {
    const r = release();
    for (let i = 0; i < 205; i++) asset(r, `${i}.nar`);
    expect(await storage.hasNar('204.nar')).toBe(true);
    expect(await storage.hasNar('0.nar')).toBe(true);
    expect(await storage.hasNar('missing.nar')).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(4); // releases + 3 asset pages
  });

  test('ignores unrelated releases', async () => {
    asset(release('nix-cache-not-a-shard'), 'unrelated.nar');
    expect(await storage.hasNar('unrelated.nar')).toBe(false);
  });

  test('repeated and concurrent writes preserve immutable assets', async () => {
    await Promise.all(Array.from({ length: 4 }, () =>
      storage.putNarStream('abc.nar', Readable.from('data'))));
    expect(assets).toHaveLength(1);
    expect(releases).toHaveLength(1);
    expect(global.fetch.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false);
  });

  test('metadata is not exposed if its upload fails', async () => {
    await storage.putNarStream('abc.nar', Readable.from('data'));
    global.fetch.mockResolvedValueOnce(response('forbidden', 403));
    await expect(storage.putNarinfo('abc', 'URL: nar/abc.nar\n')).rejects.toThrow('403');
    expect(fs.existsSync(path.join(dir, 'narinfo', 'abc.narinfo'))).toBe(false);
  });

  test('refuses metadata pointing to a missing NAR', async () => {
    await expect(storage.putNarinfo('abc', 'URL: nar/missing.nar\n')).rejects.toThrow('Missing NAR');
    expect(assets).toHaveLength(0);
  });

  test('failed listing is fatal instead of publishing a partial index', async () => {
    global.fetch.mockResolvedValueOnce(response('forbidden', 403));
    await expect(storage.fetchAllNarinfo()).rejects.toThrow('403');
    expect(releases).toHaveLength(0);
  });

  test('failed metadata download is fatal', async () => {
    asset(release(), 'abc.narinfo', 'URL: https://example.org/file.nar\n');
    await storage._init();
    global.fetch.mockResolvedValueOnce(response('missing', 404));
    await expect(storage.fetchAllNarinfo()).rejects.toThrow('404');
  });

  test('rejects an oversized asset before issuing API calls', async () => {
    await expect(storage._upload('big.nar', 2 * 1024 ** 3,
      () => { throw new Error('must not read'); }, 'application/octet-stream')).rejects.toThrow('under 2 GiB');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('retry honors Retry-After', async () => {
    const limited = response('rate limited', 429);
    limited.headers.set('retry-after', '2');
    global.fetch.mockResolvedValueOnce(limited);
    expect(await storage.hasNar('missing')).toBe(false);
    expect(storage.sleep).toHaveBeenCalledWith(2000);
  });

  test('retries reopen the upload stream', async () => {
    await storage._init();
    await storage._writableShard();
    const limited = response('rate limited', 429);
    global.fetch.mockResolvedValueOnce(limited);
    await storage.putNarStream('abc.nar', Readable.from('complete data'));
    expect(assets[0].content).toBe('complete data');
  });

  test('recovers a completed upload after a server error and duplicate retry', async () => {
    await storage._init();
    const shard = await storage._writableShard();
    global.fetch.mockImplementationOnce(async () => {
      asset(releases.find(r => r.id === shard.id), 'abc.nar', 'data');
      return response('lost response', 502);
    });
    await storage.putNarStream('abc.nar', Readable.from('data'));
    expect(await storage.hasNar('abc.nar')).toBe(true);
    expect(assets).toHaveLength(1);
  });

  test('a full legacy release rolls into a new shard', async () => {
    const r = release();
    for (let i = 0; i < 1000; i++) asset(r, `${i}.nar`);
    await storage.putNarStream('new.nar', Readable.from('new'));
    expect(releases[1].tag_name).toBe('nix-cache-000001');
    expect(assets.filter(a => a.releaseId === r.id)).toHaveLength(1000);
    expect(storage.narDownloadUrl('new.nar')).toContain('/nix-cache-000001/');
  });

  test('pruning retains absolute references from all release shards', async () => {
    const r = release();
    asset(r, 'abc.nar');
    asset(r, 'orphan.nar');
    asset(release('nix-cache-000001'), 'abc.narinfo',
      'URL: https://github.com/owner/repo/releases/download/nix-cache/abc.nar\n');
    const result = await storage.pruneAssets();
    expect(result.deleted).toEqual(['orphan.nar']);
    expect(result.referenced).toEqual(['abc.nar']);
  });

  test('pruning respects a grace period', async () => {
    asset(release(), 'recent.nar');
    expect((await storage.pruneAssets({ retentionDays: 7 })).kept).toEqual(['recent.nar']);
  });
});
