#!/usr/bin/env node
'use strict';

// Fails if a store path about to be published holds a secret (src/secrets.js).
//
//   node scripts/scan-secrets.js <paths-file>
//
// It scans what publishing the listed paths uploads: their whole closure, since nix copy
// copies that, except paths an upstream cache has signed, which that cache already serves
// (UPSTREAM_CACHES and UPSTREAM_PUBLIC_KEYS, as for skip-upstream-signed).
//
// SECRET_PATTERNS: more regular expressions, one per line.
// SECRET_ALLOW: globs of files that may match, one per line (see allowMatcher).
// SECRET_MAX_FILE_BYTES (8 MiB): larger files are not read.
//
// It reads the local store, so it runs where the paths were built. Unlike the skip scripts,
// it fails closed: if it cannot tell, nothing is published.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { upstreamKeys, parsePathInfo, signedBy } = require('../src/upstream-signed');
const { RULES, customRules, scanBuffer, allowMatcher } = require('../src/secrets');

const run = promisify(execFile);
const BATCH = 200;
const words = value => (value || '').split(/\s+/).filter(Boolean);
const lines = value => (value || '').split('\n').map(s => s.trim()).filter(Boolean);

/** Every regular file under a store path, with its path relative to it. */
function* files(root, rel = '') {
  const here = path.join(root, rel);
  const st = fs.lstatSync(here);
  if (st.isSymbolicLink()) return;
  if (st.isFile()) {
    yield { file: here, rel: rel || '.', size: st.size };
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of fs.readdirSync(here).sort()) yield* files(root, rel ? `${rel}/${name}` : name);
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: scan-secrets.js <paths-file>');
  const paths = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (!paths.length) return;
  const nix = process.env.NIX_BIN || 'nix';
  const rules = [...RULES, ...customRules(lines(process.env.SECRET_PATTERNS))];
  const allowed = allowMatcher(lines(process.env.SECRET_ALLOW));
  const maxBytes = Number(process.env.SECRET_MAX_FILE_BYTES || 8 * 1024 * 1024);
  const keys = upstreamKeys(words(process.env.UPSTREAM_CACHES), words(process.env.UPSTREAM_PUBLIC_KEYS));

  const infos = new Map();
  for (let i = 0; i < paths.length; i += BATCH) {
    const { stdout } = await run(nix, ['path-info', '--json', '--recursive', ...paths.slice(i, i + BATCH)], { maxBuffer: 1024 * 1024 * 1024 });
    for (const [p, info] of parsePathInfo(stdout)) infos.set(p, info);
  }
  const scanned = [...infos.keys()].filter(p => !signedBy(infos.get(p), keys)).sort();

  let count = 0;
  let large = 0;
  const findings = [];
  for (const p of scanned) {
    const name = path.basename(p).slice(33);
    for (const f of files(p)) {
      if (f.size > maxBytes) {
        large++;
        continue;
      }
      count++;
      for (const hit of scanBuffer(fs.readFileSync(f.file), rules)) {
        if (!allowed(name, f.rel)) findings.push({ ...hit, path: p, rel: f.rel });
      }
    }
  }
  console.log(`Scanned ${count} file(s) in ${scanned.length} store path(s) for secrets (${infos.size - scanned.length} upstream-signed, ${large} over ${maxBytes} bytes, not read)`);
  if (!findings.length) return;
  for (const f of findings) {
    console.log(`::error::Possible secret (${f.rule}) in ${f.path}/${f.rel}, at byte ${f.offset}`);
  }
  console.log(`::error::${findings.length} possible secret(s) found, so nothing is published. If one is not a secret, allow it with secret-allow.`);
  process.exit(1);
}

main().catch(err => {
  // Publishing unscanned paths could leak what the scan is for, so a failure stops it.
  console.log(`::error::Scanning for secrets failed, so nothing is published. ${String(err.message).split('\n')[0]}`);
  process.exit(1);
});
