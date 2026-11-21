'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SetupError, UsageError } = require('../scripts/setup-github-cache');
const {
  bucketResource, defaultBucket, endpointFor, parseArguments, s3Credentials, setup, tokenPlan,
} = require('../scripts/setup-r2-cache');

const REPO = 'example-owner/example-project';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const READ_GROUP = 'group-read';
const WRITE_GROUP = 'group-write';

/** GitHub, Cloudflare and 1Password as a run sees them, recording every write. */
class World {
  constructor(home) {
    this.home = home;
    this.env = { CLOUDFLARE_API_TOKEN: 'bootstrap-token', XDG_DATA_HOME: path.join(home, 'data') };
    this.logs = [];
    this.writes = [];
    this.admin = true;
    this.variables = {};
    this.secrets = new Map();
    this.buckets = new Map();
    this.tokens = [];
    this.nextToken = 1;
    this.items = new Map();
    this.failSecret = null;
  }

  which() {
    return true;
  }

  log(message) {
    this.logs.push(message);
  }

  command(args, input) {
    const line = args.slice(0, 3).join(' ');
    if (args.includes('generate-secret')) return 'test-secret';
    if (args.includes('convert-secret-to-public')) return input === 'test-secret' ? 'test-public' : `public-of-${input}`;
    if (line === 'gh secret set') {
      if (args[3] === this.failSecret) throw new SetupError('gh secret failed');
      this.writes.push(['secret', args[3]]);
      this.secrets.set(args[3], input);
      return '';
    }
    if (line === 'op read op://Private/Cloudflare/credential') return 'token-from-1password';
    if (line === 'op vault get') return '{}';
    if (line === 'op item get') {
      if (!this.items.has(args[3])) throw new SetupError(`op item failed: "${args[3]}" isn't an item.`);
      return '{}';
    }
    if (line === 'op item create') {
      const item = JSON.parse(fs.readFileSync(args[args.indexOf('--template') + 1], 'utf8'));
      this.writes.push(['op create', item.title]);
      this.items.set(item.title, item);
      return '';
    }
    if (line === 'op item delete') {
      this.writes.push(['op archive', args[3]]);
      this.items.delete(args[3]);
      return '';
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  }

  withTemplate(item, run) {
    const file = path.join(this.home, 'template.json');
    fs.writeFileSync(file, JSON.stringify(item));
    try {
      return run(file);
    } finally {
      fs.rmSync(file);
    }
  }

  api(route, method = 'GET', body) {
    const prefix = `repos/${REPO}`;
    const full = route.split('?')[0];
    if (!full.startsWith(prefix)) throw new Error(`Unexpected destination: ${route}`);
    const rest = full.slice(prefix.length);
    if (method !== 'GET') {
      if (rest !== '/actions/variables') throw new Error(`Unexpected write: ${route}`);
      this.writes.push(['variable', body.name]);
      this.variables[body.name] = body.value;
      return body;
    }
    if (!rest) return { permissions: { admin: this.admin }, default_branch: 'main' };
    if (rest.startsWith('/actions/variables/')) {
      const name = rest.split('/').pop();
      return name in this.variables ? { value: this.variables[name] } : null;
    }
    if (rest === '/actions/secrets') return { secrets: [...this.secrets.keys()].map(name => ({ name })) };
    throw new Error(`Unexpected read: ${route}`);
  }

  async cloudflare(token, method, route, body, headers) {
    if (token !== this.expectedToken()) return { status: 403, json: { success: false, errors: [{ code: 9109, message: 'Unauthorized' }] } };
    const base = `/accounts/${ACCOUNT}`;
    if (!route.startsWith(base)) throw new Error(`Unexpected Cloudflare route: ${route}`);
    const rest = route.slice(base.length).split('?')[0];
    const ok = result => ({ status: 200, json: { success: true, errors: [], result } });
    if (rest.startsWith('/r2/buckets/') && method === 'GET') {
      const bucket = this.buckets.get(decodeURIComponent(rest.split('/').pop()));
      return bucket ? ok(bucket) : { status: 404, json: { success: false, errors: [{ code: 10006, message: 'The specified bucket does not exist.' }] } };
    }
    if (rest === '/r2/buckets' && method === 'POST') {
      this.writes.push(['bucket', body.name, headers['cf-r2-jurisdiction'] || 'default', body.locationHint]);
      const bucket = { name: body.name, jurisdiction: headers['cf-r2-jurisdiction'] || 'default' };
      this.buckets.set(body.name, bucket);
      return ok(bucket);
    }
    if (rest === '/tokens' && method === 'GET') return ok(this.tokens.map(({ value, ...token }) => token));
    if (rest === '/tokens/permission_groups') {
      return ok([
        { id: WRITE_GROUP, name: 'Workers R2 Storage Bucket Item Write', is_selectable: true },
        { id: READ_GROUP, name: 'Workers R2 Storage Bucket Item Read', is_selectable: true },
      ]);
    }
    if (rest === '/tokens' && method === 'POST') {
      const token = { id: `token-${this.nextToken}`, value: `value-${this.nextToken}`, ...body };
      this.nextToken += 1;
      this.writes.push(['token', body.name, body.policies[0].permission_groups[0].id, Object.keys(body.policies[0].resources)[0]]);
      this.tokens.push(token);
      return ok(token);
    }
    if (rest.startsWith('/tokens/') && method === 'DELETE') {
      const id = rest.split('/').pop();
      this.writes.push(['delete token', id]);
      this.tokens = this.tokens.filter(token => token.id !== id);
      return ok({ id });
    }
    throw new Error(`Unexpected Cloudflare call: ${method} ${route}`);
  }

  expectedToken() {
    return this.usingOp ? 'token-from-1password' : this.env.CLOUDFLARE_API_TOKEN;
  }
}

function args(overrides = []) {
  return parseArguments(['--repo', REPO, '--account-id', ACCOUNT, ...overrides]);
}

let home;
let world;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'static-nix-cache-r2-'));
  world = new World(home);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const readerFile = () => path.join(home, 'data', 'static-nix-cache', `${REPO}.r2-reader`);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

describe('helpers', () => {
  test('S3 credentials are the token ID and the SHA-256 of its value', () => {
    expect(s3Credentials({ id: 'abc', value: 'secret' })).toEqual({ accessKeyId: 'abc', secretAccessKey: sha256('secret') });
  });

  test('endpoints and resources follow the jurisdiction', () => {
    expect(endpointFor(ACCOUNT, 'default')).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(endpointFor(ACCOUNT, 'eu')).toBe(`https://${ACCOUNT}.eu.r2.cloudflarestorage.com`);
    expect(bucketResource(ACCOUNT, 'default', 'b')).toBe(`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_b`);
  });

  test('default bucket names are valid R2 names', () => {
    expect(defaultBucket('Owner/My_Project.v2')).toBe('my-project-v2-nix-cache');
    expect(defaultBucket(`o/${'x'.repeat(80)}`)).toHaveLength(63);
  });

  test('a token is reused only with its credentials, and never guessed at', () => {
    const base = { label: 'CI', flag: '--replace-ci-token', replace: false };
    expect(tokenPlan({ ...base, tokens: [], stored: false })).toBe('create');
    expect(tokenPlan({ ...base, tokens: [{}], stored: true })).toBe('reuse');
    expect(tokenPlan({ ...base, tokens: [{}], stored: false, replace: true })).toBe('replace');
    expect(() => tokenPlan({ ...base, tokens: [{}], stored: false })).toThrow(/cannot return them.*--replace-ci-token/);
    expect(() => tokenPlan({ ...base, tokens: [], stored: true })).toThrow(/token is gone/);
    expect(() => tokenPlan({ ...base, tokens: [{}, {}], stored: true })).toThrow(/2 tokens share its name/);
  });
});

describe('parseArguments', () => {
  test('rejects what cannot be acted on', () => {
    expect(() => parseArguments(['--jurisdiction', 'mars'])).toThrow(UsageError);
    expect(() => parseArguments(['--api-token-ref', 'plain'])).toThrow(/op:\/\//);
    expect(() => parseArguments(['--profile', 'a b'])).toThrow(/--profile/);
    expect(() => parseArguments(['--secret-name', 'GITHUB_X'])).toThrow(UsageError);
    expect(parseArguments(['--help'])).toBeNull();
  });
});

describe('setup', () => {
  test('provisions bucket, tokens, secrets, variables and a reader file', async () => {
    await setup(args(['--location-hint', 'wnam']), world);

    const resource = bucketResource(ACCOUNT, 'default', 'example-project-nix-cache');
    expect(world.writes).toEqual([
      ['bucket', 'example-project-nix-cache', 'default', 'wnam'],
      ['secret', 'NIX_CACHE_SIGNING_KEY'],
      ['variable', 'NIX_CACHE_PUBLIC_KEY'],
      ['token', `static-nix-cache ${REPO} ci`, WRITE_GROUP, resource],
      ['secret', 'R2_ACCESS_KEY_ID'],
      ['secret', 'R2_SECRET_ACCESS_KEY'],
      ['token', `static-nix-cache ${REPO} reader`, READ_GROUP, resource],
      ['variable', 'R2_ACCOUNT_ID'],
      ['variable', 'R2_BUCKET'],
    ]);
    expect(world.secrets.get('R2_ACCESS_KEY_ID')).toBe('token-1');
    expect(world.secrets.get('R2_SECRET_ACCESS_KEY')).toBe(sha256('value-1'));
    expect(world.variables).toMatchObject({ R2_ACCOUNT_ID: ACCOUNT, R2_BUCKET: 'example-project-nix-cache' });
    expect(world.variables.R2_ENDPOINT).toBeUndefined();

    const stat = fs.statSync(readerFile());
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(readerFile(), 'utf8')).toBe(
      `[nix-cache]\naws_access_key_id = token-2\naws_secret_access_key = ${sha256('value-2')}\n`
    );
    expect(world.logs).toContain(
      `extra-substituters = s3://example-project-nix-cache?endpoint=${ACCOUNT}.r2.cloudflarestorage.com&region=auto&profile=nix-cache`
    );
    expect(world.logs).toContain('extra-trusted-public-keys = test-public');
    // No secret value reaches the output.
    expect(world.logs.join('\n')).not.toMatch(/value-|test-secret|bootstrap-token/);
  });

  test('a rerun changes nothing', async () => {
    await setup(args(), world);
    world.writes = [];
    await setup(args(), world);
    expect(world.writes).toEqual([]);
    expect(world.logs).toContain('Reusing bucket example-project-nix-cache.');
  });

  test('a lost reader file is replaced only when asked', async () => {
    await setup(args(), world);
    fs.rmSync(readerFile());
    world.writes = [];
    await expect(setup(args(), world)).rejects.toThrow(/reader token cannot be reused.*--replace-reader-token/);
    expect(world.writes).toEqual([]);

    await setup(args(['--replace-reader-token']), world);
    expect(world.writes).toEqual([
      ['delete token', 'token-2'],
      ['token', `static-nix-cache ${REPO} reader`, READ_GROUP, bucketResource(ACCOUNT, 'default', 'example-project-nix-cache')],
    ]);
    expect(fs.readFileSync(readerFile(), 'utf8')).toContain('token-3');
  });

  test('a token whose credentials could not be stored is deleted again', async () => {
    world.failSecret = 'R2_SECRET_ACCESS_KEY';
    await expect(setup(args(), world)).rejects.toThrow(/gh secret failed/);
    expect(world.tokens).toEqual([]);
    expect(world.writes.slice(-2)).toEqual([['secret', 'R2_ACCESS_KEY_ID'], ['delete token', 'token-1']]);
  });

  test('refuses a repository provisioned for a different bucket, before writing', async () => {
    world.variables.R2_BUCKET = 'other-bucket';
    await expect(setup(args(), world)).rejects.toThrow(/R2_BUCKET is other-bucket/);
    expect(world.writes).toEqual([]);
  });

  test('requires repository administrator access, an account ID and a token', async () => {
    world.admin = false;
    await expect(setup(args(), world)).rejects.toThrow(/administrator/);
    world.admin = true;
    await expect(setup(parseArguments(['--repo', REPO]), world)).rejects.toThrow(/account ID/);
    delete world.env.CLOUDFLARE_API_TOKEN;
    await expect(setup(args(), world)).rejects.toThrow(/API token is required/);
  });

  test('surfaces Cloudflare errors with their message', async () => {
    world.env.CLOUDFLARE_API_TOKEN = 'wrong';
    world.expectedToken = () => 'right';
    await expect(setup(args(), world)).rejects.toThrow(/Unauthorized \(9109\)/);
  });

  test('an EU bucket gets its jurisdiction, endpoint and variable', async () => {
    await setup(args(['--jurisdiction', 'eu', '--bucket', 'eu-cache']), world);
    expect(world.writes[0]).toEqual(['bucket', 'eu-cache', 'eu', undefined]);
    expect(world.variables.R2_ENDPOINT).toBe(`https://${ACCOUNT}.eu.r2.cloudflarestorage.com`);
    expect(world.writes).toContainEqual(['token', expect.any(String), READ_GROUP, bucketResource(ACCOUNT, 'eu', 'eu-cache')]);
  });

  test('with 1Password, keeps the reader credentials and signing key there', async () => {
    world.usingOp = true;
    delete world.env.CLOUDFLARE_API_TOKEN;
    await setup(args(['--op-vault', 'Private', '--api-token-ref', 'op://Private/Cloudflare/credential']), world);

    const reader = world.items.get(`static-nix-cache ${REPO} R2 reader`);
    const field = id => reader.fields.find(item => item.id === id).value;
    expect(reader.category).toBe('API_CREDENTIAL');
    expect(field('username')).toBe('token-2');
    expect(field('credential')).toBe(sha256('value-2'));
    expect(field('hostname')).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
    const signing = world.items.get(`static-nix-cache ${REPO} signing key`);
    expect(signing.fields.find(item => item.id === 'password').value).toBe('test-secret');
    expect(fs.existsSync(readerFile())).toBe(false);

    world.writes = [];
    await setup(args(['--op-vault', 'Private', '--api-token-ref', 'op://Private/Cloudflare/credential']), world);
    expect(world.writes).toEqual([]);

    await setup(args(['--op-vault', 'Private', '--api-token-ref', 'op://Private/Cloudflare/credential', '--replace-reader-token']), world);
    expect(world.writes.filter(([kind]) => kind.startsWith('op'))).toEqual([
      ['op archive', `static-nix-cache ${REPO} R2 reader`],
      ['op create', `static-nix-cache ${REPO} R2 reader`],
    ]);
  });

  test('reuses a signing key that setup-github already stored', async () => {
    world.secrets.set('NIX_CACHE_SIGNING_KEY', 'kept');
    world.variables.NIX_CACHE_PUBLIC_KEY = 'existing-public';
    await setup(args(), world);
    expect(world.writes).not.toContainEqual(['secret', 'NIX_CACHE_SIGNING_KEY']);
    expect(world.logs).toContain('extra-trusted-public-keys = existing-public');
  });
});

describe('r2System.cloudflare', () => {
  const { r2System } = require('../scripts/setup-r2-cache');
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('sends the bearer token and JSON body, and reads the envelope', async () => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push([url, init]);
      return { status: 200, text: async () => JSON.stringify({ success: true, result: { name: 'b' } }) };
    };
    const response = await r2System.cloudflare('tok', 'POST', '/accounts/a/r2/buckets', { name: 'b' }, { 'cf-r2-jurisdiction': 'eu' });
    expect(response).toEqual({ status: 200, json: { success: true, result: { name: 'b' } } });
    const [url, init] = calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/a/r2/buckets');
    expect(init.headers).toEqual({ Authorization: 'Bearer tok', 'Content-Type': 'application/json', 'cf-r2-jurisdiction': 'eu' });
    expect(init.body).toBe('{"name":"b"}');
  });

  test('tolerates a body that is not JSON', async () => {
    global.fetch = async () => ({ status: 502, text: async () => '<html>Bad gateway</html>' });
    expect(await r2System.cloudflare('tok', 'GET', '/x')).toEqual({ status: 502, json: null });
  });
});
