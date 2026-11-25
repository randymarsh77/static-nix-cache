'use strict';

// Garbage collection for a bucket cache: the cache's own nix-collect-garbage.
//
// Store paths never change, so nothing in a cache goes bad; paths only stop being used, when
// what was built from them is rebuilt with different inputs. Telling which those are takes
// roots, as in a Nix store. Each publish can record one: the closure of what it built, as it
// was in the store that built it (so it includes paths the cache does not hold, such as ones
// an upstream cache serves or ones left out as local-only). A root is a text file of store
// path hashes under roots/<name>/ in the bucket.
//
// Collection then keeps every path some kept root names, and deletes every other narinfo and
// every NAR no kept narinfo points to. Roots are kept while they are recent, and the newest
// few of each name are kept however old they are, so a cache nothing has published to for a
// while still serves what was last published.
//
// Anything written within a grace period is kept whatever the roots say: a publish writes its
// root only after its paths, so a path being published has no root yet.

const ROOTS_PREFIX = 'roots/';
const HASH = /^[0-9a-df-np-sv-z]{32}$/;

/** The hash part of a store path, or of a store path's base name, or null. */
function storeHash(p) {
  const base = String(p).trim().split('/').pop();
  const hash = base.slice(0, 32);
  return HASH.test(hash) && (base.length === 32 || base[32] === '-') ? hash : null;
}

/** The store path hashes a root file lists, one store path or base name per line. */
function parseRoot(text) {
  const hashes = new Set();
  for (const line of String(text).split('\n')) {
    const h = storeHash(line);
    if (h) hashes.add(h);
  }
  return hashes;
}

/** A root's name, safe to use as part of an object key. */
function rootName(name) {
  const safe = String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  if (!safe) throw new Error('A root needs a name');
  return safe;
}

/** The key a new root is written to: newer roots of a name sort after older ones. */
function rootKey(name, now = new Date(), id = '') {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${ROOTS_PREFIX}${rootName(name)}/${stamp}${id ? `-${rootName(id)}` : ''}.txt`;
}

/**
 * Which roots to keep: every root written in the last `keepDays` days, and the `keepLast`
 * newest of each name.
 * @param {{key: string, lastModified: Date}[]} roots
 * @returns {{kept: string[], dropped: string[]}}
 */
function selectRoots(roots, { keepDays, keepLast, now = new Date() }) {
  const cutoff = now.getTime() - keepDays * 24 * 3600 * 1000;
  const byName = new Map();
  for (const r of roots) {
    const name = r.key.slice(ROOTS_PREFIX.length).split('/')[0];
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(r);
  }
  const kept = [];
  const dropped = [];
  for (const list of byName.values()) {
    list.sort((a, b) => b.lastModified - a.lastModified || (a.key < b.key ? 1 : -1));
    list.forEach((r, i) => (i < keepLast || r.lastModified.getTime() >= cutoff ? kept : dropped).push(r.key));
  }
  return { kept, dropped };
}

/** The NAR a narinfo points to, as its key in the bucket (nar/<file>), or null. */
function narKey(narinfo) {
  const m = /^URL:\s*(\S+)\s*$/m.exec(String(narinfo));
  if (!m) return null;
  const url = m[1].replace(/^\.?\//, '');
  return url.startsWith('nar/') ? url : null;
}

/** The narinfo hash in a key, for either layout (<hash>.narinfo, narinfo/<hash>.narinfo). */
function narinfoHash(key, layout) {
  const m = (layout === 'nix' ? /^([^/]+)\.narinfo$/ : /^narinfo\/([^/]+)\.narinfo$/).exec(key);
  return m && HASH.test(m[1]) ? m[1] : null;
}

/**
 * What to delete. `live` is every store path hash a kept root names; `narOf` maps each kept
 * narinfo's key to the NAR it points to (null when it could not be read: its NAR is then
 * unknown, so no NAR is deleted).
 * @returns {{narinfos: string[], nars: string[], keptNarinfos: string[], unknownNars: boolean}}
 */
function planSweep({ objects, layout, live, narOf, graceMs, now = new Date() }) {
  const recent = o => now.getTime() - o.lastModified.getTime() < graceMs;
  const narinfos = [];
  const keptNarinfos = [];
  for (const o of objects) {
    const hash = narinfoHash(o.key, layout);
    if (!hash) continue;
    (live.has(hash) || recent(o) ? keptNarinfos : narinfos).push(o.key);
  }
  const used = new Set();
  let unknownNars = false;
  if (narOf) {
    for (const k of keptNarinfos) {
      const nar = narOf.get(k);
      if (nar === undefined || nar === null) unknownNars = true;
      else used.add(nar);
    }
  }
  const nars = unknownNars || !narOf ? [] : objects
    .filter(o => o.key.startsWith('nar/') && !used.has(o.key) && !recent(o))
    .map(o => o.key);
  return { narinfos, nars, keptNarinfos, unknownNars };
}

module.exports = {
  ROOTS_PREFIX, storeHash, parseRoot, rootName, rootKey, selectRoots, narKey, narinfoHash, planSweep,
};
