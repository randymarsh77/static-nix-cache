'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { execFileSync } = require('child_process');
const {
  GetObjectCommand, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const S3Storage = require('../src/storage/s3');
const gc = require('../src/gc');
const { prune, writeRoot } = require('../src/gc-storage');

const H = c => c.repeat(32);
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(H);
const DAY = 24 * 3600 * 1000;
const NOW = new Date('2026-11-24T12:00:00Z');
const ago = days => new Date(NOW.getTime() - days * DAY);

/**
 * An in-memory bucket that lists in pages of `page` and records deletions. Its roots began
 * `since` (by default long enough ago to cover the time kept; null for none noted).
 */
function fakeBucket({ page = 1000, since = ago(100) } = {}) {
  const objects = new Map();
  const deleted = [];
  const notFound = () => Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  const client = {
    async send(command) {
      const input = command.input;
      if (command instanceof PutObjectCommand) {
        objects.set(input.Key, { body: Buffer.from(input.Body), lastModified: NOW });
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        const keys = [...objects.keys()].filter(k => k.startsWith(input.Prefix || '')).sort();
        const start = Number(input.ContinuationToken || 0);
        const slice = keys.slice(start, start + page);
        return {
          Contents: slice.map(Key => ({ Key, LastModified: objects.get(Key).lastModified, Size: objects.get(Key).body.length })),
          IsTruncated: start + page < keys.length,
          NextContinuationToken: String(start + page),
        };
      }
      if (command instanceof DeleteObjectsCommand) {
        for (const { Key } of input.Delete.Objects) {
          objects.delete(Key);
          deleted.push(Key);
        }
        return {};
      }
      if (!objects.has(input.Key)) throw notFound();
      if (command instanceof HeadObjectCommand) return {};
      if (command instanceof GetObjectCommand) return { Body: Readable.from([objects.get(input.Key).body]) };
      throw new Error('unexpected command');
    },
  };
  const put = (key, body, lastModified) => objects.set(key, { body: Buffer.from(body), lastModified });
  const storage = new S3Storage({ bucket: 'b', client, layout: 'nix' });
  if (since) put(gc.SINCE_KEY, `${since.toISOString()}\n`, since);
  return { storage, objects, deleted, put };
}

/** A path published `days` ago: its narinfo, and its NAR. */
function publish(bucket, hash, days, nar = `nar/${hash}.nar.xz`) {
  bucket.put(`${hash}.narinfo`, `StorePath: /nix/store/${hash}-pkg\nURL: ${nar}\nCompression: xz\n`, ago(days));
  bucket.put(nar, 'x'.repeat(100), ago(days));
}

describe('the rules', () => {
  test('store hashes, from paths and base names', () => {
    expect(gc.storeHash(`/nix/store/${A}-bash-5.3`)).toBe(A);
    expect(gc.storeHash(`${A}-bash`)).toBe(A);
    expect(gc.storeHash(A)).toBe(A);
    expect(gc.storeHash('/nix/store/short-bash')).toBeNull();
    // e, o, u and t are not in Nix's base 32.
    expect(gc.storeHash('e'.repeat(32))).toBeNull();
    expect(gc.parseRoot(`${A}-x\n/nix/store/${B}-y\n\njunk\n${A}-x\n`)).toEqual(new Set([A, B]));
  });

  test('root keys sort by time, and names are made safe', () => {
    expect(gc.rootKey('me/nix-Build Darwin', NOW, '12-1')).toBe('roots/me-nix-Build-Darwin/2026-11-24T12-00-00-000Z-12-1.txt');
    expect(() => gc.rootName('//')).toThrow();
  });

  test('roots kept: recent ones, and the newest few of each name', () => {
    const roots = [
      { key: 'roots/a/1.txt', lastModified: ago(90) },
      { key: 'roots/a/2.txt', lastModified: ago(60) },
      { key: 'roots/a/3.txt', lastModified: ago(40) },
      { key: 'roots/b/1.txt', lastModified: ago(50) },
      { key: 'roots/b/2.txt', lastModified: ago(5) },
      { key: 'roots/b/3.txt', lastModified: ago(1) },
    ];
    const { kept, dropped } = gc.selectRoots(roots, { keepDays: 30, keepLast: 2, now: NOW });
    expect(kept.sort()).toEqual(['roots/a/2.txt', 'roots/a/3.txt', 'roots/b/2.txt', 'roots/b/3.txt']);
    expect(dropped.sort()).toEqual(['roots/a/1.txt', 'roots/b/1.txt']);
  });

  test('a narinfo names its NAR', () => {
    expect(gc.narKey('StorePath: /nix/store/x\nURL: nar/abc.nar.xz\n')).toBe('nar/abc.nar.xz');
    expect(gc.narKey('URL: https://elsewhere/nar/abc.nar.xz\n')).toBeNull();
    expect(gc.narinfoHash(`${A}.narinfo`, 'nix')).toBe(A);
    expect(gc.narinfoHash(`narinfo/${A}.narinfo`, 'legacy')).toBe(A);
    expect(gc.narinfoHash(`narinfo/${A}.narinfo`, 'nix')).toBeNull();
    expect(gc.narinfoHash('nix-cache-info', 'nix')).toBeNull();
  });
});

describe('pruning a bucket', () => {
  const quiet = () => {};

  test('deletes what no kept root names, keeps what one does and what is recent', async () => {
    const bucket = fakeBucket({ page: 2 });
    publish(bucket, A, 10); // named by the root
    publish(bucket, B, 10); // named by nothing
    publish(bucket, C, 0.5); // named by nothing, but written in the grace period
    bucket.put('nix-cache-info', 'StoreDir: /nix/store\n', ago(100));
    bucket.put('roots/sys/1.txt', `${A}-pkg\n${D}-not-in-the-cache\n`, ago(2));

    const result = await prune(bucket.storage, { now: NOW, log: quiet });
    expect(bucket.deleted.sort()).toEqual([`${B}.narinfo`, `nar/${B}.nar.xz`]);
    expect(result.bytes).toBe(100);
    expect([...bucket.objects.keys()].sort()).toEqual([
      `${A}.narinfo`, `${C}.narinfo`, 'gc/roots-since.txt', `nar/${A}.nar.xz`, `nar/${C}.nar.xz`, 'nix-cache-info', 'roots/sys/1.txt',
    ]);
  });

  test('a NAR a kept narinfo shares with a deleted one stays', async () => {
    const bucket = fakeBucket();
    publish(bucket, A, 10, 'nar/same.nar.xz');
    publish(bucket, B, 10, 'nar/same.nar.xz');
    bucket.put('roots/sys/1.txt', `${A}-pkg\n`, ago(2));
    await prune(bucket.storage, { now: NOW, log: quiet });
    expect(bucket.deleted).toEqual([`${B}.narinfo`]);
  });

  test('old roots are dropped, after what only they kept', async () => {
    const bucket = fakeBucket();
    publish(bucket, A, 100);
    publish(bucket, B, 10);
    bucket.put('roots/sys/1.txt', `${A}-pkg\n`, ago(100));
    bucket.put('roots/sys/2.txt', `${B}-pkg\n`, ago(10));
    await prune(bucket.storage, { now: NOW, keepLast: 1, log: quiet });
    expect(bucket.deleted).toEqual([`${A}.narinfo`, `nar/${A}.nar.xz`, 'roots/sys/1.txt']);
  });

  test('a dry run deletes nothing, and names what it would', async () => {
    const bucket = fakeBucket();
    publish(bucket, A, 10);
    bucket.put('roots/sys/1.txt', `${B}-pkg\n`, ago(2));
    const lines = [];
    const result = await prune(bucket.storage, { now: NOW, dryRun: true, log: l => lines.push(l) });
    expect(bucket.deleted).toEqual([]);
    expect(result.narinfos).toEqual([`${A}.narinfo`]);
    expect(lines).toContain(`  would delete: /nix/store/${A}-pkg`);
  });

  test('with no roots nothing is deleted', async () => {
    const bucket = fakeBucket();
    publish(bucket, A, 10);
    await expect(prune(bucket.storage, { now: NOW, log: quiet })).rejects.toThrow(/no roots/);
    await expect(prune(bucket.storage, { now: NOW, keepLast: 0, log: quiet })).rejects.toThrow(/at least 1/);
    expect(bucket.deleted).toEqual([]);
  });

  test('no NAR is deleted when a kept narinfo cannot be read', async () => {
    const bucket = fakeBucket();
    publish(bucket, A, 10);
    publish(bucket, B, 10);
    bucket.put(`${A}.narinfo`, 'StorePath: /nix/store/x\n', ago(10)); // no URL
    bucket.put('roots/sys/1.txt', `${A}-pkg\n`, ago(2));
    await prune(bucket.storage, { now: NOW, log: quiet });
    expect(bucket.deleted).toEqual([`${B}.narinfo`]);
  });

  test('a NAR that a narinfo written during pruning points to stays', async () => {
    const bucket = fakeBucket();
    publish(bucket, A, 10);
    bucket.put('roots/sys/1.txt', `${B}-pkg\n`, ago(2));
    // A publish writes a new narinfo for the same NAR as soon as the old narinfo is gone.
    const del = bucket.storage.deleteObjects.bind(bucket.storage);
    bucket.storage.deleteObjects = async keys => {
      await del(keys);
      if (keys.includes(`${A}.narinfo`)) {
        bucket.put(`${C}.narinfo`, `StorePath: /nix/store/${C}-pkg\nURL: nar/${A}.nar.xz\n`, NOW);
      }
    };
    await prune(bucket.storage, { now: NOW, log: quiet });
    expect(bucket.deleted).toEqual([`${A}.narinfo`]);
    expect(bucket.objects.has(`nar/${A}.nar.xz`)).toBe(true);
  });

  test('a root is written with the base names of its paths', async () => {
    const bucket = fakeBucket({ since: null });
    const { key, count } = await writeRoot(bucket.storage, {
      name: 'sys', id: '1', now: NOW, paths: [`/nix/store/${B}-b`, `/nix/store/${A}-a`, `/nix/store/${A}-a`, 'junk'],
    });
    expect(count).toBe(2);
    expect(bucket.objects.get(key).body.toString()).toBe(`${A}-a\n${B}-b\n`);
    await expect(writeRoot(bucket.storage, { name: 'sys', paths: [] })).rejects.toThrow();
    // The first root notes when roots began; later ones leave that alone.
    expect(bucket.objects.get(gc.SINCE_KEY).body.toString()).toBe(`${NOW.toISOString()}\n`);
    await writeRoot(bucket.storage, { name: 'sys', id: '2', now: new Date(NOW.getTime() + DAY), paths: [`/nix/store/${A}-a`] });
    expect(bucket.objects.get(gc.SINCE_KEY).body.toString()).toBe(`${NOW.toISOString()}\n`);
  });

  test('nothing is deleted until roots cover the time kept', async () => {
    const bucket = fakeBucket({ since: ago(10) });
    publish(bucket, A, 40); // used by a publish from before roots, which no root names
    publish(bucket, B, 5);
    bucket.put('roots/sys/1.txt', `${B}-pkg\n`, ago(5));
    const lines = [];
    const result = await prune(bucket.storage, { now: NOW, keepDays: 30, log: l => lines.push(l) });
    expect(bucket.deleted).toEqual([]);
    expect(result.deleted).toBe(false);
    expect(result.until).toEqual(new Date(ago(10).getTime() + 30 * DAY));
    expect(result.narinfos).toEqual([`${A}.narinfo`]);
    expect(lines.join('\n')).toMatch(/do not yet cover the 30 day\(s\) kept/);
    expect(lines).toContain(`  would delete: /nix/store/${A}-pkg`);

    // Once they do, it goes.
    await prune(bucket.storage, { now: new Date(ago(10).getTime() + 30 * DAY), keepDays: 30, log: () => {} });
    expect(bucket.deleted).toEqual([`${A}.narinfo`, `nar/${A}.nar.xz`]);
  });

  test('a cache with roots but no note of when they began dates them from its oldest root', async () => {
    const bucket = fakeBucket({ since: null });
    publish(bucket, A, 40);
    bucket.put('roots/sys/1.txt', `${B}-pkg\n`, ago(3));
    bucket.put('roots/sys/2.txt', `${B}-pkg\n`, ago(1));
    // A dry run notes nothing.
    await prune(bucket.storage, { now: NOW, dryRun: true, log: () => {} });
    expect(bucket.objects.has(gc.SINCE_KEY)).toBe(false);
    const result = await prune(bucket.storage, { now: NOW, log: () => {} });
    expect(result.until).toEqual(new Date(ago(3).getTime() + 30 * DAY));
    expect(bucket.deleted).toEqual([]);
    expect(bucket.objects.get(gc.SINCE_KEY).body.toString()).toBe(`${ago(3).toISOString()}\n`);
  });
});

describe('record-root.js', () => {
  test('records the closure of the paths and of links to them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-root-'));
    const bin = path.join(dir, 'nix');
    const args = path.join(dir, 'args');
    // The fake nix prints a closure, and records what it was asked.
    fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > "${args}"\nprintf '/nix/store/${A}-sys\\n/nix/store/${B}-lib\\n'\n`, { mode: 0o755 });
    const file = path.join(dir, 'paths');
    fs.writeFileSync(file, `/nix/store/${A}-sys/sw/bin\n`);
    // With no reachable bucket the write fails, after the closure is read.
    let failed;
    try {
      execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/record-root.js'), file], {
        env: { PATH: process.env.PATH, NIX_BIN: bin, ROOT_NAME: 'sys', STORAGE_BACKEND: 'local' },
        encoding: 'utf8',
      });
    } catch (err) {
      failed = err;
    }
    expect(fs.readFileSync(args, 'utf8').trim()).toBe(`path-info --recursive /nix/store/${A}-sys`);
    expect(failed.stdout).toMatch(/::error::.*need the r2 or s3 backend/);
  });
});
