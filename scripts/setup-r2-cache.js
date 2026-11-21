#!/usr/bin/env node
'use strict';

// Provisions a private, signed Cloudflare R2 cache for a repository.
//
//   CLOUDFLARE_API_TOKEN=... nix run github:randymarsh77/static-nix-cache#setup-r2 -- \
//     --repo OWNER/REPO --account-id ACCOUNT_ID
//   node scripts/setup-r2-cache.js --repo OWNER/REPO --account-id ACCOUNT_ID
//
// It needs gh (authenticated as an administrator of the repository), nix, git when --repo
// is not given, and op (the 1Password CLI) for --op-vault or --api-token-ref.
//
// Nothing is replaced without being asked: an existing bucket, signing key and tokens are
// reused, and a token whose credentials cannot be found is replaced only with
// --replace-ci-token or --replace-reader-token.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const {
  SetupError, UsageError, expandHome, lstat, paginated, prepareKey, resolveRepository, system,
} = require('./setup-github-cache');

const HELP = `Usage: static-nix-cache-setup-r2 [options]

Provision a private, signed Cloudflare R2 cache for a repository: an R2 bucket,
a read-write token for CI stored as repository secrets, a read-only token for
the machines that use the cache, and a signing key.

Cloudflare: set CLOUDFLARE_API_TOKEN, or pass --api-token-ref to read it from
1Password. That token needs Account > Account API Tokens > Edit and
Account > Workers R2 Storage > Edit. GitHub: run as an administrator of the
repository, logged in with: gh auth login

Options:
  --repo OWNER/REPO            Destination (default: the checkout's origin remote)
  --account-id ID              Cloudflare account ID (default: $CLOUDFLARE_ACCOUNT_ID)
  --bucket NAME                R2 bucket (default: <repo>-nix-cache)
  --jurisdiction NAME          default, eu or fedramp (default: default)
  --location-hint HINT         Location hint for a new bucket (for example wnam)
  --api-token-ref REF          1Password reference for the Cloudflare token
                               (for example op://Private/Cloudflare/credential)
  --op-vault VAULT             Store the reader credentials and signing-key backup
                               in this 1Password vault
  --profile NAME               AWS profile name for the reader credentials
                               (default: nix-cache)
  --key-file PATH              Private-key backup to create or import (mode 0600)
  --secret-name NAME           Signing-secret name (default: NIX_CACHE_SIGNING_KEY)
  --public-key-variable NAME   Public-key variable (default: NIX_CACHE_PUBLIC_KEY)
  --replace-secret             Overwrite an existing signing secret with the key
                               in the key file
  --replace-ci-token           Replace the CI token and its repository secrets
  --replace-reader-token       Replace the reader token and its stored credentials
  -h, --help                   Show this help

Without --op-vault, the reader credentials are written with mode 0600 to
$XDG_DATA_HOME/static-nix-cache/OWNER/REPO.r2-reader (default ~/.local/share).
Neither Cloudflare nor GitHub can return a token's secret, so keep them.
`;

const OPTIONS = {
  repo: { type: 'string' },
  'account-id': { type: 'string' },
  bucket: { type: 'string' },
  jurisdiction: { type: 'string', default: 'default' },
  'location-hint': { type: 'string' },
  'api-token-ref': { type: 'string' },
  'op-vault': { type: 'string' },
  profile: { type: 'string', default: 'nix-cache' },
  'key-file': { type: 'string' },
  'secret-name': { type: 'string', default: 'NIX_CACHE_SIGNING_KEY' },
  'public-key-variable': { type: 'string', default: 'NIX_CACHE_PUBLIC_KEY' },
  'replace-secret': { type: 'boolean', default: false },
  'replace-ci-token': { type: 'boolean', default: false },
  'replace-reader-token': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const JURISDICTIONS = ['default', 'eu', 'fedramp'];
const CI_SECRETS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
// Looked up by name: Cloudflare says IDs, not names, are stable, so names are only matched.
const GROUPS = {
  write: 'Workers R2 Storage Bucket Item Write',
  read: 'Workers R2 Storage Bucket Item Read',
};

const r2System = {
  ...system,

  async cloudflare(token, method, route, body, headers = {}) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // An HTML error page; the status says enough.
    }
    return { status: response.status, json };
  },

  // Writes a 1Password item template to an owner-only file, so that secrets never appear
  // on a command line, and removes it however op exits.
  withTemplate(item, run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'static-nix-cache-op-'));
    const file = path.join(directory, 'item.json');
    try {
      fs.writeFileSync(file, JSON.stringify(item), { mode: 0o600 });
      return run(file);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
};

/** The S3 credentials of an R2 API token: its ID, and the SHA-256 of its value. */
function s3Credentials(token) {
  return {
    accessKeyId: token.id,
    secretAccessKey: crypto.createHash('sha256').update(token.value).digest('hex'),
  };
}

function endpointFor(accountId, jurisdiction) {
  return jurisdiction === 'default'
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`;
}

function bucketResource(accountId, jurisdiction, bucket) {
  return `com.cloudflare.edge.r2.bucket.${accountId}_${jurisdiction}_${bucket}`;
}

function defaultBucket(repo) {
  const name = repo.split('/')[1].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${name.slice(0, 53).replace(/-+$/, '')}-nix-cache`;
}

function credentialsFile({ profile, accessKeyId, secretAccessKey }) {
  return `[${profile}]\naws_access_key_id = ${accessKeyId}\naws_secret_access_key = ${secretAccessKey}\n`;
}

/** A Cloudflare API client bound to one token and account. */
function cloudflare(io, token, accountId) {
  async function call(method, route, { body, headers, optional } = {}) {
    const { status, json } = await io.cloudflare(token, method, route, body, headers);
    if (status >= 200 && status < 300 && json && json.success !== false) return json;
    // 10006: the R2 API's "bucket does not exist".
    const missing = status === 404 || (json && (json.errors || []).some(error => error.code === 10006));
    if (optional && missing) return null;
    const detail = json && json.errors && json.errors.length
      ? json.errors.map(error => `${error.message} (${error.code})`).join('; ')
      : `HTTP ${status}`;
    throw new SetupError(`Cloudflare ${method} ${route}: ${detail}`);
  }
  const account = `/accounts/${encodeURIComponent(accountId)}`;

  return {
    async bucket(name, jurisdiction) {
      const json = await call('GET', `${account}/r2/buckets/${encodeURIComponent(name)}`, {
        headers: jurisdictionHeader(jurisdiction),
        optional: true,
      });
      return json ? json.result : null;
    },
    async createBucket(name, jurisdiction, locationHint) {
      const body = { name, ...(locationHint ? { locationHint } : {}) };
      return (await call('POST', `${account}/r2/buckets`, { body, headers: jurisdictionHeader(jurisdiction) })).result;
    },
    async tokens() {
      const tokens = [];
      for (let page = 1; ; page += 1) {
        const json = await call('GET', `${account}/tokens?per_page=50&page=${page}`);
        tokens.push(...json.result);
        const info = json.result_info || {};
        if (json.result.length < 50 || (info.total_pages && page >= info.total_pages)) return tokens;
      }
    },
    async permissionGroups() {
      return (await call('GET', `${account}/tokens/permission_groups`)).result;
    },
    async createToken(body) {
      return (await call('POST', `${account}/tokens`, { body })).result;
    },
    async deleteToken(id) {
      await call('DELETE', `${account}/tokens/${encodeURIComponent(id)}`);
    },
  };
}

function jurisdictionHeader(jurisdiction) {
  return jurisdiction === 'default' ? {} : { 'cf-r2-jurisdiction': jurisdiction };
}

function permissionGroup(groups, name) {
  const group = groups.find(item => item.name === name && item.is_selectable !== false);
  if (!group) {
    throw new SetupError(`Cloudflare has no selectable permission group named "${name}".`);
  }
  return group.id;
}

/** 1Password items, through op. Titles identify them within the vault. */
function onePassword(io, vault) {
  function exists(title) {
    try {
      io.command(['op', 'item', 'get', title, '--vault', vault, '--format', 'json']);
      return true;
    } catch (error) {
      if (error instanceof SetupError && /isn't an item|not found|no item/i.test(error.message)) return false;
      throw error;
    }
  }
  return {
    exists,
    create(item) {
      io.withTemplate(item, file => io.command(['op', 'item', 'create', '--vault', vault, '--template', file]));
    },
    archive(title) {
      io.command(['op', 'item', 'delete', title, '--vault', vault, '--archive']);
    },
  };
}

function readerItem({ title, repo, profile, endpoint, bucket, accessKeyId, secretAccessKey }) {
  return {
    title,
    category: 'API_CREDENTIAL',
    fields: [
      { id: 'username', type: 'STRING', label: 'username', value: accessKeyId },
      { id: 'credential', type: 'CONCEALED', label: 'credential', value: secretAccessKey },
      { id: 'hostname', type: 'STRING', label: 'hostname', value: endpoint },
      { id: 'bucket', type: 'STRING', label: 'bucket', value: bucket },
      { id: 'profile', type: 'STRING', label: 'profile', value: profile },
      { id: 'notesPlain', type: 'STRING', purpose: 'NOTES', label: 'notesPlain',
        value: `Read-only R2 credentials for the ${repo} Nix cache (static-nix-cache).` },
    ],
  };
}

function signingItem({ title, repo, secret, publicKey }) {
  return {
    title,
    category: 'PASSWORD',
    fields: [
      { id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', label: 'password', value: secret },
      { id: 'public_key', type: 'STRING', label: 'public key', value: publicKey },
      { id: 'notesPlain', type: 'STRING', purpose: 'NOTES', label: 'notesPlain',
        value: `Nix signing key for the ${repo} cache (static-nix-cache).` },
    ],
  };
}

/**
 * What to do with one token: 'reuse' it, 'create' it, or 'replace' it. A token is reused
 * only when exactly one exists and its credentials are where they are kept.
 */
function tokenPlan({ label, tokens, stored, replace, flag }) {
  if (replace) return 'replace';
  if (tokens.length === 1 && stored) return 'reuse';
  if (tokens.length === 0 && !stored) return 'create';
  const state = tokens.length === 0
    ? 'its credentials are stored but the token is gone'
    : tokens.length > 1
      ? `${tokens.length} tokens share its name`
      : 'the token exists but its credentials are not stored, and Cloudflare cannot return them';
  throw new SetupError(`The ${label} token cannot be reused: ${state}. Pass ${flag} to replace it.`);
}

async function setup(args, io = r2System) {
  const tools = ['gh', 'nix', ...(args.opVault || args.apiTokenRef ? ['op'] : [])];
  for (const tool of tools) {
    if (!io.which(tool)) throw new SetupError(`Required executable not found: ${tool}`);
  }
  const accountId = args.accountId || io.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId || !/^[0-9a-f]{32}$/.test(accountId)) {
    throw new SetupError('A Cloudflare account ID (32 hex digits) is required: --account-id or CLOUDFLARE_ACCOUNT_ID.');
  }
  const apiToken = args.apiTokenRef
    ? io.command(['op', 'read', args.apiTokenRef])
    : io.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    throw new SetupError('A Cloudflare API token is required: CLOUDFLARE_API_TOKEN or --api-token-ref.');
  }
  const cf = cloudflare(io, apiToken, accountId);

  const repo = resolveRepository(io, args.repo);
  const root = `repos/${repo}`;
  const metadata = io.api(root);
  if (!(metadata.permissions && metadata.permissions.admin)) {
    throw new SetupError(`Repository administrator access is required for ${repo}.`);
  }
  const bucket = args.bucket || defaultBucket(repo);
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new SetupError(`Invalid R2 bucket name: ${bucket} (3-63 lowercase letters, digits and hyphens).`);
  }
  const { jurisdiction } = args;
  const endpoint = endpointFor(accountId, jurisdiction);
  const op = args.opVault ? onePassword(io, args.opVault) : null;
  if (op) io.command(['op', 'vault', 'get', args.opVault, '--format', 'json']);

  // Read everything and settle every refusal first; the writes start further down.
  const variables = {
    R2_ACCOUNT_ID: accountId,
    R2_BUCKET: bucket,
    ...(jurisdiction !== 'default' ? { R2_ENDPOINT: endpoint } : {}),
  };
  const missingVariables = [];
  for (const [name, value] of Object.entries(variables)) {
    const stored = io.api(`${root}/actions/variables/${name}`, 'GET', undefined, true);
    if (!stored) missingVariables.push(name);
    else if (stored.value !== value) {
      throw new SetupError(
        `The repository variable ${name} is ${stored.value}, not ${value}. Pass the values it ` +
          'was provisioned with, or delete the variable to provision a different cache.'
      );
    }
  }
  const secrets = paginated(io, `${root}/actions/secrets`, 'secrets');
  const hasSecret = name => secrets.some(item => item.name.toUpperCase() === name.toUpperCase());

  const existingBucket = await cf.bucket(bucket, jurisdiction);
  const tokens = await cf.tokens();
  const ciName = `static-nix-cache ${repo} ci`;
  const readerName = `static-nix-cache ${repo} reader`;
  const ciTokens = tokens.filter(token => token.name === ciName);
  const readerTokens = tokens.filter(token => token.name === readerName);

  const dataHome = io.env.XDG_DATA_HOME || path.join(io.home, '.local/share');
  const dataDirectory = path.join(dataHome, 'static-nix-cache');
  const readerFile = path.join(dataDirectory, `${repo}.r2-reader`);
  const readerTitle = `static-nix-cache ${repo} R2 reader`;
  const signingTitle = `static-nix-cache ${repo} signing key`;
  const readerStored = op ? op.exists(readerTitle) : Boolean(lstat(readerFile));

  const ciPlan = tokenPlan({
    label: 'CI', tokens: ciTokens, stored: CI_SECRETS.every(hasSecret),
    replace: args.replaceCiToken, flag: '--replace-ci-token',
  });
  const readerPlan = tokenPlan({
    label: 'reader', tokens: readerTokens, stored: readerStored,
    replace: args.replaceReaderToken, flag: '--replace-reader-token',
  });
  const groups = ciPlan === 'reuse' && readerPlan === 'reuse' ? [] : await cf.permissionGroups();
  const groupIds = {
    write: ciPlan === 'reuse' ? null : permissionGroup(groups, GROUPS.write),
    read: readerPlan === 'reuse' ? null : permissionGroup(groups, GROUPS.read),
  };

  const storedPublic = io.api(`${root}/actions/variables/${args.publicKeyVariable}`, 'GET', undefined, true);
  const hasSigningSecret = hasSecret(args.secretName);
  const keyFile = args.keyFile
    ? path.resolve(expandHome(io, args.keyFile))
    : path.join(dataDirectory, `${repo}.key`);
  const key = prepareKey(io, {
    repo,
    keyFile,
    storedPublic: storedPublic ? storedPublic.value : null,
    hasSecret: hasSigningSecret,
    secretName: args.secretName,
    replaceSecret: args.replaceSecret,
  });

  io.log(`Configuring R2 cache ${bucket} for ${repo}.`);
  if (!existingBucket) {
    await cf.createBucket(bucket, jurisdiction, args.locationHint);
    io.log(`Created bucket ${bucket}.`);
  } else {
    io.log(`Reusing bucket ${bucket}.`);
  }

  if (key.secret && (!hasSigningSecret || !storedPublic)) {
    io.command(['gh', 'secret', 'set', args.secretName, '--repo', repo], key.secret);
  }
  if (!storedPublic) {
    io.api(`${root}/actions/variables`, 'POST', { name: args.publicKeyVariable, value: key.public });
  }
  if (op && key.secret && !op.exists(signingTitle)) {
    op.create(signingItem({ title: signingTitle, repo, secret: key.secret, publicKey: key.public }));
    io.log(`Signing key saved to 1Password: ${args.opVault} / ${signingTitle}`);
  }

  const resource = bucketResource(accountId, jurisdiction, bucket);
  // Creates a token and hands its credentials to `store`; a token whose credentials could
  // not be stored is deleted again, so a rerun does not find it orphaned.
  async function provision(plan, name, groupId, existing, store) {
    if (plan === 'reuse') return false;
    for (const token of existing) await cf.deleteToken(token.id);
    const token = await cf.createToken({
      name,
      policies: [{ effect: 'allow', permission_groups: [{ id: groupId }], resources: { [resource]: '*' } }],
    });
    try {
      await store(s3Credentials(token));
    } catch (error) {
      await cf.deleteToken(token.id).catch(() => {});
      throw error;
    }
    return true;
  }

  if (await provision(ciPlan, ciName, groupIds.write, ciTokens, credentials => {
    io.command(['gh', 'secret', 'set', 'R2_ACCESS_KEY_ID', '--repo', repo], credentials.accessKeyId);
    io.command(['gh', 'secret', 'set', 'R2_SECRET_ACCESS_KEY', '--repo', repo], credentials.secretAccessKey);
  })) io.log('CI token stored as repository secrets R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');

  if (await provision(readerPlan, readerName, groupIds.read, readerTokens, credentials => {
    if (op) {
      if (readerStored) op.archive(readerTitle);
      op.create(readerItem({ title: readerTitle, repo, profile: args.profile, endpoint, bucket, ...credentials }));
    } else {
      fs.mkdirSync(path.dirname(readerFile), { recursive: true, mode: 0o700 });
      if (readerStored) fs.rmSync(readerFile);
      // 'wx' fails rather than overwrite a file that appeared in the meantime.
      fs.writeFileSync(readerFile, credentialsFile({ profile: args.profile, ...credentials }), { flag: 'wx', mode: 0o600 });
    }
  })) {
    io.log(op
      ? `Reader credentials saved to 1Password: ${args.opVault} / ${readerTitle}`
      : `Reader credentials: ${readerFile} (keep this secure).`);
  }

  for (const name of missingVariables) {
    io.api(`${root}/actions/variables`, 'POST', { name, value: variables[name] });
  }

  const host = endpoint.replace(/^https:\/\//, '');
  io.log(`Public signing key: ${key.public}`);
  io.log(`extra-substituters = s3://${bucket}?endpoint=${host}&region=auto&profile=${args.profile}`);
  io.log(`extra-trusted-public-keys = ${key.public}`);
  io.log(
    `Install the reader credentials as profile [${args.profile}] in root's AWS credentials ` +
      'file (/var/root/.aws/credentials on macOS, /root/.aws/credentials on Linux), mode 0600.'
  );
  io.log(
    'Deploy with backend: r2, r2-account-id: ${{ vars.R2_ACCOUNT_ID }}, r2-bucket: ${{ vars.R2_BUCKET }}, ' +
      'r2-access-key-id: ${{ secrets.R2_ACCESS_KEY_ID }}, r2-secret-access-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}' +
      (variables.R2_ENDPOINT ? ', r2-endpoint: ${{ vars.R2_ENDPOINT }}' : '') + '.'
  );
}

// Parses the command line. Returns null when help was asked for; throws UsageError for a
// command line that cannot be acted on, before anything is contacted.
function parseArguments(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.help) return null;
  if (!JURISDICTIONS.includes(values.jurisdiction)) {
    throw new UsageError(`--jurisdiction must be one of ${JURISDICTIONS.join(', ')}`);
  }
  for (const name of [values['secret-name'], values['public-key-variable']]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.toUpperCase().startsWith('GITHUB_')) {
      throw new UsageError('Secret/variable names must be identifiers without the GITHUB_ prefix');
    }
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(values.profile)) throw new UsageError('--profile must be a plain name');
  if (values['api-token-ref'] && !values['api-token-ref'].startsWith('op://')) {
    throw new UsageError('--api-token-ref must be a 1Password reference (op://...)');
  }
  if (values['op-vault'] === '') throw new UsageError('--op-vault must not be empty');
  return {
    repo: values.repo,
    accountId: values['account-id'],
    bucket: values.bucket,
    jurisdiction: values.jurisdiction,
    locationHint: values['location-hint'],
    apiTokenRef: values['api-token-ref'],
    opVault: values['op-vault'],
    profile: values.profile,
    keyFile: values['key-file'],
    secretName: values['secret-name'],
    publicKeyVariable: values['public-key-variable'],
    replaceSecret: values['replace-secret'],
    replaceCiToken: values['replace-ci-token'],
    replaceReaderToken: values['replace-reader-token'],
  };
}

async function main(argv) {
  let args;
  try {
    args = parseArguments(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\nRun with --help for the options.`);
    return 2;
  }
  if (!args) {
    console.log(HELP);
    return 0;
  }
  try {
    await setup(args);
  } catch (error) {
    // A file-system failure carries a code; anything else unexpected is a bug to surface.
    if (!(error instanceof SetupError) && !error.code) throw error;
    console.error(`Setup failed: ${error.message}`);
    return 1;
  }
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

module.exports = {
  bucketResource,
  readerItem,
  signingItem,
  credentialsFile,
  defaultBucket,
  endpointFor,
  parseArguments,
  r2System,
  s3Credentials,
  setup,
  tokenPlan,
};
