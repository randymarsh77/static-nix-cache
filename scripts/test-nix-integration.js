#!/usr/bin/env node
'use strict';

// Real Nix protocol/signature test, with only temporary local HTTP services.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const assert = require('assert/strict');
const { createApp } = require('../src/server');
const run = promisify(execFile);

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-nix-integration-'));
  const servers = [];
  const env = { ...process.env, XDG_CACHE_HOME: path.join(dir, 'client-cache') };
  async function cmd(bin, args) { return (await run(bin, args, { env })).stdout.trim(); }
  async function start(localStoragePath, extra = {}) {
    const app = createApp({ storageBackend: 'local', localStoragePath, ...extra });
    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  try {
    const keyFile = path.join(dir, 'private');
    const pubFile = path.join(dir, 'public');
    await cmd('nix-store', ['--generate-binary-cache-key', 'integration-1', keyFile, pubFile]);
    const signingKey = await fsp.readFile(keyFile, 'utf8');
    const pubKey = (await fsp.readFile(pubFile, 'utf8')).trim();
    const dep = await cmd('nix-build', ['--no-out-link', '--option', 'sandbox', 'false', '--expr',
      'builtins.derivation { name = "cache-integration-dependency"; system = builtins.currentSystem; builder = "/bin/sh"; args = ["-c" "echo dependency > $out"]; }']);
    const root = await cmd('nix-build', ['--no-out-link', '--option', 'sandbox', 'false', '--expr',
      `let dep = builtins.storePath "${dep}"; in builtins.derivation { name = "cache-integration-root"; system = builtins.currentSystem; builder = "/bin/sh"; args = ["-c" ("echo " + dep + " > $out")]; }`]);
    const upstreamDir = path.join(dir, 'upstream');
    const targetDir = path.join(dir, 'target');
    const upstream = await start(upstreamDir, { signingKey });
    const target = await start(targetDir, { signingKey, upstreamCaches: [upstream] });
    await cmd('nix', ['copy', '--to', `${upstream}?compression=xz`, dep]);
    await cmd('nix', ['copy', '--to', `${target}?compression=xz`, root]);
    const rootHash = path.basename(root).split('-')[0];
    const depHash = path.basename(dep).split('-')[0];
    assert(fs.existsSync(path.join(targetDir, 'narinfo', `${rootHash}.narinfo`)));
    assert(!fs.existsSync(path.join(targetDir, 'narinfo', `${depHash}.narinfo`)), 'Upstream dependency must not be mirrored');
    const metadata = await (await fetch(`${target}/${rootHash}.narinfo`)).text();
    assert(metadata.includes('Compression: xz'));
    assert(metadata.includes(`References: ${path.basename(dep)}`));
    // Use a fresh client metadata cache: Nix caches pre-signing upload metadata.
    env.XDG_CACHE_HOME = path.join(dir, 'verify-cache');
    await cmd('nix', ['store', 'verify', '--store', target, '--sigs-needed', '1',
      '--trusted-public-keys', pubKey, '--recursive', root]);
    console.log('PASS: recursive copy skips upstream dependencies and Nix verifies signed compressed NARs with references');
  } finally {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err.stderr || err); process.exitCode = 1; });
