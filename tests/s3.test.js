'use strict';

const { Readable } = require('stream');
const { GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const S3Storage = require('../src/storage/s3');
const { createStorage, r2Options } = require('../src/storage');

/** An in-memory stand-in for S3Client that records what it is sent. */
function fakeClient() {
  const objects = new Map();
  const sent = [];
  const notFound = name => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
  return {
    objects,
    sent,
    async send(command) {
      const { Key, Body, ContentLength } = command.input;
      sent.push(command);
      if (command instanceof PutObjectCommand) {
        const chunks = [];
        if (typeof Body === 'string') chunks.push(Buffer.from(Body));
        else for await (const chunk of Body) chunks.push(chunk);
        const data = Buffer.concat(chunks);
        if (ContentLength !== undefined && ContentLength !== data.length) {
          throw new Error(`ContentLength ${ContentLength} does not match body ${data.length}`);
        }
        objects.set(Key, data);
        return {};
      }
      if (!objects.has(Key)) throw notFound(command instanceof HeadObjectCommand ? 'NotFound' : 'NoSuchKey');
      if (command instanceof HeadObjectCommand) return {};
      if (command instanceof GetObjectCommand) return { Body: Readable.from([objects.get(Key)]) };
      throw new Error('unexpected command');
    },
  };
}

async function read(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

describe('S3Storage layouts', () => {
  test('legacy layout keeps narinfo under narinfo/ and writes no cache info', async () => {
    const client = fakeClient();
    const storage = new S3Storage({ bucket: 'b', client, cacheInfo: 'StoreDir: /nix/store\n' });
    await storage.putNarinfo('abc', 'StorePath: /nix/store/abc-x\n');
    expect([...client.objects.keys()]).toEqual(['narinfo/abc.narinfo']);
    expect(await storage.getNarinfo('abc')).toBe('StorePath: /nix/store/abc-x\n');
    expect(await storage.hasNarinfo('abc')).toBe(true);
  });

  test('nix layout puts narinfo at the bucket root, next to nix-cache-info', async () => {
    const client = fakeClient();
    const cacheInfo = 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 30\n';
    const storage = new S3Storage({ bucket: 'b', client, layout: 'nix', cacheInfo });
    await storage.putNarinfo('abc', 'one');
    await storage.putNarinfo('def', 'two');
    expect([...client.objects.keys()].sort()).toEqual(['abc.narinfo', 'def.narinfo', 'nix-cache-info']);
    expect(client.objects.get('nix-cache-info').toString()).toBe(cacheInfo);
    // Written once per run, not once per path.
    expect(client.sent.filter(c => c.input.Key === 'nix-cache-info')).toHaveLength(1);
    expect(await storage.getNarinfo('abc')).toBe('one');
    expect(await storage.hasNarinfo('missing')).toBe(false);
    expect(await storage.getNarinfo('missing')).toBeNull();
  });

  test('rejects an unknown layout', () => {
    expect(() => new S3Storage({ bucket: 'b', client: fakeClient(), layout: 'flat' })).toThrow(/Unknown S3 layout/);
  });
});

describe('S3Storage NARs', () => {
  test('uploads a stream with its Content-Length and reads it back', async () => {
    const client = fakeClient();
    const storage = new S3Storage({ bucket: 'b', client, layout: 'nix' });
    await storage.putNarStream('x.nar.xz', Readable.from([Buffer.from('hello '), Buffer.from('nar')]));
    const put = client.sent.find(c => c instanceof PutObjectCommand);
    expect(put.input).toMatchObject({ Key: 'nar/x.nar.xz', ContentLength: 9 });
    expect(await storage.hasNar('x.nar.xz')).toBe(true);
    expect(await read(await storage.getNarStream('x.nar.xz'))).toBe('hello nar');
    expect(await storage.getNarStream('missing.nar.xz')).toBeNull();
  });
});

describe('r2 backend', () => {
  const base = { storeDir: '/nix/store', priority: 40 };

  test('derives the account endpoint and uses the Nix layout', () => {
    const options = r2Options({ ...base, r2: { accountId: 'acct', bucket: 'cache', accessKeyId: 'k', secretAccessKey: 's' } });
    expect(options).toMatchObject({
      bucket: 'cache',
      region: 'auto',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      forcePathStyle: true,
      layout: 'nix',
      checksums: 'when-required',
      cacheInfo: 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n',
    });
  });

  test('honours an endpoint override', () => {
    const options = r2Options({ ...base, r2: { bucket: 'cache', endpoint: 'https://acct.eu.r2.cloudflarestorage.com' } });
    expect(options.endpoint).toBe('https://acct.eu.r2.cloudflarestorage.com');
  });

  test('requires a bucket and an account', () => {
    expect(() => r2Options({ ...base, r2: { accountId: 'acct' } })).toThrow(/R2_BUCKET/);
    expect(() => r2Options({ ...base, r2: { bucket: 'cache' } })).toThrow(/R2_ACCOUNT_ID/);
  });

  test('createStorage builds an S3Storage in the Nix layout', () => {
    const storage = createStorage({ ...base, storageBackend: 'r2', r2: { accountId: 'acct', bucket: 'cache' } });
    expect(storage).toBeInstanceOf(S3Storage);
    expect(storage.layout).toBe('nix');
  });
});
