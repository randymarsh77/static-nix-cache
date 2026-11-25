#!/usr/bin/env node
'use strict';

// Deletes from a bucket cache every path no recent root needs (src/gc.js).
//
//   node scripts/prune.js
//
// PRUNE_KEEP_DAYS (30): keep every root this recent.
// PRUNE_KEEP_LAST (3): and the newest this many of each name, however old.
// PRUNE_GRACE_HOURS (24): never delete anything written this recently.
// PRUNE_DRY_RUN (false): only say what would be deleted.
// The storage is configured as for the server (STORAGE_BACKEND=r2, R2_BUCKET, ...).

const config = require('../src/config');
const { bucketStorage, prune } = require('../src/gc-storage');

function number(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of at least 0, not '${raw}'`);
  return n;
}

async function main() {
  await prune(bucketStorage(config), {
    keepDays: number('PRUNE_KEEP_DAYS', 30),
    keepLast: number('PRUNE_KEEP_LAST', 3),
    graceHours: number('PRUNE_GRACE_HOURS', 24),
    dryRun: process.env.PRUNE_DRY_RUN === 'true',
  });
}

main().catch(err => {
  console.log(`::error::${err.message}`);
  process.exit(1);
});
