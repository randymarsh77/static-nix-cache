'use strict';

// Roots and collection against a bucket (src/gc.js has the rules). Only the S3 backend, R2
// included, can list and delete what it holds, so only it has roots.

const { createStorage } = require('./storage');
const gc = require('./gc');

const CONCURRENCY = 32;

/** The configured storage, if it is one that can be collected. */
function bucketStorage(config) {
  const storage = createStorage(config);
  if (typeof storage.listObjects !== 'function' || typeof storage.deleteObjects !== 'function') {
    throw new Error(`Roots and pruning need the r2 or s3 backend, not '${config.storageBackend}'`);
  }
  return storage;
}

async function mapLimit(items, fn, limit = CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** When the cache's roots began, as SINCE_KEY says, or null. */
async function rootsSince(storage) {
  return gc.parseSince(await storage.getText(gc.SINCE_KEY));
}

/** Writes a root: the base names of the store paths a publish needs. */
async function writeRoot(storage, { name, id, paths, now = new Date() }) {
  const names = [...new Set(paths.map(p => String(p).split('/').pop()).filter(b => gc.storeHash(b)))].sort();
  if (!names.length) throw new Error('A root needs at least one store path');
  const key = gc.rootKey(name, now, id);
  await storage.putText(key, names.map(n => `${n}\n`).join(''));
  // The first root starts the time roots cover.
  if (!(await rootsSince(storage))) await storage.putText(gc.SINCE_KEY, `${now.toISOString()}\n`);
  return { key, count: names.length };
}

/** The NAR each narinfo points to (null when it could not be read). */
async function narsOf(storage, keys) {
  const nars = await mapLimit(keys, async k => {
    try {
      const text = await storage.getText(k);
      return text === null ? null : gc.narKey(text);
    } catch {
      return null;
    }
  });
  return new Map(keys.map((k, i) => [k, nars[i]]));
}

const MB = n => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Collects the bucket. Returns what was (or, on a dry run, would be) deleted.
 */
async function prune(storage, { keepDays = 30, keepLast = 3, graceHours = 24, dryRun = false, now = new Date(), log = console.log } = {}) {
  if (keepLast < 1) throw new Error('keepLast must be at least 1, so that a cache keeps what was last published');
  const roots = await storage.listObjects(gc.ROOTS_PREFIX);
  if (!roots.length) {
    throw new Error('The cache has no roots, so every path in it would be deleted. Record roots (record-roots on deploy) before pruning.');
  }
  // Caches whose roots began before SINCE_KEY was kept: their oldest root says when.
  let since = await rootsSince(storage);
  if (!since) {
    since = new Date(Math.min(...roots.map(r => r.lastModified.getTime())));
    if (!dryRun) await storage.putText(gc.SINCE_KEY, `${since.toISOString()}\n`);
  }
  const { covered, from } = gc.rootsCover({ since, keepDays, now });
  const dry = dryRun || !covered;
  const { kept, dropped } = gc.selectRoots(roots, { keepDays, keepLast, now });
  const live = new Set();
  for (const key of kept) {
    const text = await storage.getText(key);
    if (text === null) throw new Error(`Root ${key} could not be read; nothing is deleted`);
    for (const h of gc.parseRoot(text)) live.add(h);
  }
  if (!covered) {
    log(`Roots were first recorded ${since.toISOString()}, so they do not yet cover the ${keepDays} day(s) kept: what older publishes used could still be wanted. Nothing is deleted until ${from.toISOString()}; until then, this is what would be.`);
  }
  log(`Keeping ${kept.length} root(s) naming ${live.size} store path(s); dropping ${dropped.length} root(s)`);

  const objects = await storage.listObjects('');
  const layout = storage.layout;
  const graceMs = graceHours * 3600 * 1000;
  const first = gc.planSweep({ objects, layout, live, narOf: null, graceMs, now });
  const narOf = await narsOf(storage, first.keptNarinfos);
  const plan = gc.planSweep({ objects, layout, live, narOf, graceMs, now });
  if (plan.unknownNars) {
    log('::warning::Some kept narinfos could not be read, so no NAR is deleted this time.');
  }
  const size = new Map(objects.map(o => [o.key, o.size]));
  const bytes = keys => keys.reduce((n, k) => n + (size.get(k) || 0), 0);
  const total = objects.reduce((n, o) => n + o.size, 0);
  log(`Bucket: ${objects.length} object(s), ${MB(total)}`);
  log(`${dry ? 'Would delete' : 'Deleting'} ${plan.narinfos.length} narinfo(s) and ${plan.nars.length} NAR(s), ${MB(bytes(plan.nars))}; keeping ${plan.keptNarinfos.length} narinfo(s)`);
  // Name what goes, by store path: the narinfos say.
  const named = await mapLimit(plan.narinfos, async k => {
    const text = await storage.getText(k).catch(() => null);
    const m = text && /^StorePath:\s*(\S+)/m.exec(text);
    return m ? m[1] : k;
  });
  for (const p of named.sort()) log(`  ${dry ? 'would delete' : 'deleting'}: ${p}`);
  if (dry) return { ...plan, roots: dropped, bytes: bytes(plan.nars), deleted: false, until: covered ? null : from };

  await storage.deleteObjects(plan.narinfos);

  // A publish that ran meanwhile may have written a narinfo that points to a NAR this run
  // found unused (one that was uploaded before, for an identical path). Keep those NARs.
  let nars = plan.nars;
  if (nars.length) {
    const before = new Set(objects.map(o => o.key));
    const added = (await storage.listObjects(''))
      .filter(o => !before.has(o.key) && gc.narinfoHash(o.key, layout))
      .map(o => o.key);
    const addedNars = await narsOf(storage, added);
    if ([...addedNars.values()].some(n => n === null)) {
      log('::warning::A narinfo written during pruning could not be read, so no NAR is deleted this time.');
      nars = [];
    } else {
      const used = new Set(addedNars.values());
      nars = nars.filter(k => !used.has(k));
    }
  }
  await storage.deleteObjects(nars);
  await storage.deleteObjects(dropped);
  log(`Deleted ${plan.narinfos.length} narinfo(s), ${nars.length} NAR(s) (${MB(bytes(nars))}) and ${dropped.length} root(s)`);
  return { ...plan, nars, roots: dropped, bytes: bytes(nars), deleted: true, until: null };
}

module.exports = { bucketStorage, writeRoot, rootsSince, prune, mapLimit };
