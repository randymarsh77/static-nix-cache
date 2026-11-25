'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { scanBuffer, customRules, allowMatcher, globRegExp } = require('../src/secrets');

// Secrets in the shapes services issue, put together at run time so that this file holds none.
const j = (...parts) => parts.join('');
const FAKE = {
  op: j('ops', '_eyJ', 'a'.repeat(60)),
  awsId: j('AK', 'IA', 'Q7RZ'.repeat(4)),
  awsSecret: j('aws_secret', '_access_key = ', 'Ab3/'.repeat(10)),
  github: j('gh', 'p_', 'aB3d'.repeat(9)),
  githubPat: j('github', '_pat_', 'a1'.repeat(41)),
  slack: j('xo', 'xb-', '1234567890', '-', 'abcdefghijKLMN'),
  pem: j('-----BEGIN ', 'RSA PRIVATE', ' KEY-----\n', 'MIIE'.repeat(20), '\n-----END RSA PRIVATE KEY-----\n'),
  nixKey: j('cache.example.org-1', ':', 'A'.repeat(86), '=='),
};
const rules = found => found.map(f => f.rule);

describe('what counts as a secret', () => {
  test.each([
    ['1password-service-account-token', FAKE.op],
    ['aws-access-key-id', FAKE.awsId],
    ['aws-secret-access-key', FAKE.awsSecret],
    ['github-token', FAKE.github],
    ['github-fine-grained-token', FAKE.githubPat],
    ['slack-token', FAKE.slack],
    ['private-key', FAKE.pem],
    ['nix-signing-key', FAKE.nixKey],
  ])('%s', (rule, secret) => {
    expect(rules(scanBuffer(Buffer.from(`prefix ${secret} suffix`)))).toContain(rule);
  });

  test('found inside binary data too, at its offset', () => {
    const buf = Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(FAKE.github), Buffer.from([0])]);
    expect(scanBuffer(buf)).toEqual([{ rule: 'github-token', offset: 4 }]);
  });

  test('not what only looks like one', () => {
    const benign = [
      // A parser's header, with no key after it.
      j('const HEADER = "-----BEGIN ', 'RSA PRIVATE KEY-----";\nconst x = 1;\n'),
      // A Nix public key, and SRI and Nix hashes.
      j('cache.nixos.org-1:', 'A'.repeat(43), '='),
      j('sha512', ':', 'A'.repeat(86), '=='),
      j('"integrity": "sha512-', 'A'.repeat(86), '=="'),
      // AWS's documented examples.
      j('AKIA', 'IOSFODNN7EXAMPLE'),
      j('aws_secret_access_key = ', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'),
      // Too short to be a token.
      j('gh', 'p_short'),
    ].join('\n');
    expect(scanBuffer(Buffer.from(benign))).toEqual([]);
  });

  test('custom patterns, and a bad one', () => {
    expect(rules(scanBuffer(Buffer.from('ACME-KEY-123456'), customRules(['ACME-KEY-\\d{6}'])))).toEqual(['custom-1']);
    expect(() => customRules(['('])).toThrow(/secret pattern 1/);
  });

  test('allow globs, over the name and the file', () => {
    expect(globRegExp('a-*/lib/**').test('a-1.0/lib/x/y.py')).toBe(true);
    expect(globRegExp('a-*/lib/*').test('a-1.0/lib/x/y.py')).toBe(false);
    const allowed = allowMatcher(['python3-cryptography-*/lib/**/tests/**', 'openssl-3.0.15']);
    expect(allowed('python3-cryptography-44.0/lib', 'lib/python3/tests/fixtures_rsa.py')).toBe(true);
    expect(allowed('openssl-3.0.15', 'etc/ssl/key.pem')).toBe(true);
    expect(allowed('other-1.0', 'etc/ssl/key.pem')).toBe(false);
  });
});

describe('the script save and deploy run', () => {
  const script = path.resolve(__dirname, '../scripts/scan-secrets.js');

  /** A fake store under a temporary directory, and a nix that reports its closure. */
  function store(contents, env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-secrets-'));
    const paths = {};
    const infos = {};
    for (const [name, files] of Object.entries(contents)) {
      const p = path.join(dir, `${String(Object.keys(paths).length).padStart(32, 'a')}-${name}`);
      paths[name] = p;
      for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(p, rel)), { recursive: true });
        fs.writeFileSync(path.join(p, rel), body);
      }
      infos[p] = { narHash: 'sha256-hdHlSGUQbG/9Ay1k8jS4b/muSueuCXh0oiPRu6n80zk=', narSize: 1, references: [], signatures: [] };
    }
    fs.symlinkSync('/etc/passwd', path.join(Object.values(paths)[0], 'link'));
    const json = path.join(dir, 'info.json');
    fs.writeFileSync(json, JSON.stringify(infos));
    const bin = path.join(dir, 'nix');
    fs.writeFileSync(bin, `#!/bin/sh\ncat "${json}"\n`, { mode: 0o755 });
    const list = path.join(dir, 'paths');
    fs.writeFileSync(list, `${Object.values(paths)[0]}\n`);
    try {
      return { status: 0, out: execFileSync(process.execPath, [script, list], { env: { PATH: process.env.PATH, NIX_BIN: bin, ...env }, encoding: 'utf8' }) };
    } catch (err) {
      return { status: err.status, out: err.stdout };
    }
  }

  test('passes a clean closure', () => {
    const { status, out } = store({ app: { 'bin/app': '#!/bin/sh\necho hi\n' }, lib: { 'lib/x.so': 'nothing' } });
    expect(status).toBe(0);
    expect(out).toMatch(/Scanned 2 file\(s\) in 2 store path\(s\)/);
  });

  test('fails on a secret anywhere in the closure, and names where without the secret', () => {
    const { status, out } = store({ app: { 'bin/app': 'ok' }, lib: { 'etc/config': `token=${FAKE.github}\n` } });
    expect(status).toBe(1);
    expect(out).toMatch(/::error::Possible secret \(github-token\) in .*-lib\/etc\/config, at byte 6/);
    expect(out).not.toContain(FAKE.github);
  });

  test('an allowed file passes, and large files are not read', () => {
    const allowed = store({ app: { 'share/tests/key.pem': FAKE.pem } }, { SECRET_ALLOW: 'app/share/tests/**' });
    expect(allowed.status).toBe(0);
    const large = store({ app: { 'big.bin': FAKE.github } }, { SECRET_MAX_FILE_BYTES: '10' });
    expect(large.status).toBe(0);
    expect(large.out).toMatch(/1 over 10 bytes, not read/);
  });

  test('fails closed when Nix cannot be asked', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-secrets-'));
    const list = path.join(dir, 'paths');
    fs.writeFileSync(list, '/nix/store/aaaa-x\n');
    let err;
    try {
      execFileSync(process.execPath, [script, list], { env: { PATH: process.env.PATH, NIX_BIN: '/nonexistent/nix' }, encoding: 'utf8' });
    } catch (e) {
      err = e;
    }
    expect(err.status).toBe(1);
    expect(err.stdout).toMatch(/::error::Scanning for secrets failed/);
  });
});
