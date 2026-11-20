#!/usr/bin/env node
'use strict';

// Provisions a signed GitHub Releases / Pages cache for a repository.
//
//   nix run github:randymarsh77/static-nix-cache#setup-github -- --repo OWNER/REPO
//   node scripts/setup-github-cache.js --repo OWNER/REPO
//
// It needs gh (authenticated as an administrator of the repository), nix and, when --repo
// is not given, git. The flake app supplies all three.
//
// Nothing is replaced or widened without being asked: an existing signing key is reused,
// an existing secret is overwritten only with --replace-secret, a branch-published Pages
// site is switched only with --use-existing-pages, and an existing environment gains the
// default branch only with --allow-default-branch and tags only with --tag-pattern.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { parseArgs } = require('util');

const HELP = `Usage: static-nix-cache-setup-github [options]

Provision a signed GitHub Releases / Pages cache for a repository: an
Actions-backed Pages site, a deployment environment, a signing-key secret and
a public-key variable. Run it as an administrator of the repository, logged in
with: gh auth login

Classic tokens need repo scope. Fine-grained tokens need administration,
environments, Pages, secrets and variables write permissions, plus Actions
write for --dispatch. Organization authorization may also be required.

Options:
  --repo OWNER/REPO            Destination (default: the checkout's origin remote)
  --key-file PATH              Private-key backup to create or import (mode 0600)
  --environment NAME           Deployment environment (default: github-pages)
  --secret-name NAME           Signing-secret name (default: NIX_CACHE_SIGNING_KEY)
  --public-key-variable NAME   Public-key variable (default: NIX_CACHE_PUBLIC_KEY)
  --cache-path PATH            Cache subdirectory on Pages (for example cache)
  --use-existing-pages         Switch a branch-published Pages site to GitHub Actions
  --tag-pattern PATTERN        Allow a release-tag pattern (repeatable; for example 'v*')
  --allow-release-tags         Convert a protected-branches-only environment to
                               explicit branch and tag patterns
  --allow-default-branch       Let the default branch deploy to an existing
                               environment that does not allow it yet
  --replace-secret             Overwrite an existing signing secret with the key
                               in the key file
  --workflow FILE              Existing workflow to validate (for example cache.yml)
  --dispatch                   Dispatch --workflow after provisioning
  --input NAME=VALUE           Workflow input for --dispatch (repeatable, literal)
  -h, --help                   Show this help

New private keys are backed up with mode 0600 at
$XDG_DATA_HOME/static-nix-cache/OWNER/REPO.key (default ~/.local/share).
GitHub cannot return a stored secret, so keep that backup.
`;

const OPTIONS = {
  repo: { type: 'string' },
  'key-file': { type: 'string' },
  environment: { type: 'string', default: 'github-pages' },
  'secret-name': { type: 'string', default: 'NIX_CACHE_SIGNING_KEY' },
  'public-key-variable': { type: 'string', default: 'NIX_CACHE_PUBLIC_KEY' },
  'cache-path': { type: 'string', default: '' },
  'use-existing-pages': { type: 'boolean', default: false },
  'tag-pattern': { type: 'string', multiple: true, default: [] },
  'allow-release-tags': { type: 'boolean', default: false },
  'allow-default-branch': { type: 'boolean', default: false },
  'replace-secret': { type: 'boolean', default: false },
  workflow: { type: 'string' },
  dispatch: { type: 'boolean', default: false },
  input: { type: 'string', multiple: true, default: [] },
  help: { type: 'boolean', short: 'h', default: false },
};

class SetupError extends Error {}
class UsageError extends Error {}

const NIX = ['nix', '--extra-experimental-features', 'nix-command'];

// Everything that reaches outside the process, so that tests can replace it.
const system = {
  env: process.env,
  home: os.homedir(),
  log: message => console.log(message),

  which(tool) {
    return (process.env.PATH || '').split(path.delimiter).some(dir => {
      try {
        fs.accessSync(path.join(dir, tool), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  },

  // `input` goes to stdin and is never echoed: it may be the private signing key.
  command(args, input) {
    const result = childProcess.spawnSync(args[0], args.slice(1), { input, encoding: 'utf8' });
    if (result.error) throw new SetupError(`${args[0]} could not be run: ${result.error.message}`);
    if (result.status !== 0) {
      throw new SetupError(`${args[0]} ${args[1]} failed: ${(result.stderr || '').trim()}`);
    }
    return result.stdout.trim();
  },

  // With `optional`, a missing resource is null; any other failure is still an error.
  api(route, method = 'GET', body, optional = false) {
    const args = ['api', route, '--method', method];
    if (body !== undefined) args.push('--input', '-');
    const result = childProcess.spawnSync('gh', args, {
      input: body !== undefined ? JSON.stringify(body) : undefined,
      encoding: 'utf8',
    });
    if (result.error) throw new SetupError(`gh could not be run: ${result.error.message}`);
    if (result.status !== 0) {
      const stderr = result.stderr || '';
      if (optional && stderr.includes('(HTTP 404)')) return null;
      throw new SetupError(`GitHub ${method} ${route}: ${stderr.trim()}`);
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  },
};

function paginated(io, route, field) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const data = io.api(`${route}?per_page=100&page=${page}`);
    const batch = field ? data[field] : data;
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

function publicKey(io, secret) {
  return io.command([...NIX, 'key', 'convert-secret-to-public'], secret);
}

// lstat, so that a symlink is seen as one rather than as whatever it points to.
function lstat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Returns the private key to store (null when the repository's own is kept) and its public
// key. Throws before anything has been written when the pieces at hand do not fit together.
function prepareKey(io, { repo, keyFile, storedPublic, hasSecret, secretName, replaceSecret }) {
  const existing = lstat(keyFile);
  if (hasSecret && storedPublic && !existing) {
    io.log("Reusing the repository's existing signing key.");
    return { secret: null, public: storedPublic };
  }
  let secret;
  if (existing) {
    if (!existing.isFile() || existing.mode & 0o077) {
      throw new SetupError(`Private key must be a regular, owner-only file: ${keyFile}`);
    }
    secret = fs.readFileSync(keyFile, 'utf8').trim();
  } else if (hasSecret) {
    throw new SetupError(
      `Incomplete signing configuration: the secret ${secretName} exists without its ` +
        'public-key variable, and GitHub cannot return a stored secret. Supply its private ' +
        'key with --key-file and pass --replace-secret to store that key again.'
    );
  } else if (storedPublic) {
    throw new SetupError(
      'Incomplete signing configuration: the public-key variable exists without the secret. ' +
        'Supply the matching private key with --key-file; existing keys will not be replaced.'
    );
  } else {
    secret = io.command([...NIX, 'key', 'generate-secret', '--key-name', `${repo.replace('/', '-')}-cache-1`]);
  }
  const derived = publicKey(io, secret);
  if (storedPublic && derived !== storedPublic) {
    throw new SetupError('Backup key does not match the public-key variable; refusing rotation.');
  }
  // The stored secret cannot be compared with the key file, so storing the file's key may
  // replace a different one. That is the user's decision to make.
  if (hasSecret && !storedPublic && !replaceSecret) {
    throw new SetupError(
      `The secret ${secretName} exists without its public-key variable, and GitHub cannot ` +
        `return it for comparison with ${keyFile}. Pass --replace-secret to overwrite it ` +
        'with the key in that file.'
    );
  }
  if (!existing) {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    // 'wx' fails rather than overwrite a file that appeared in the meantime.
    fs.writeFileSync(keyFile, `${secret}\n`, { flag: 'wx', mode: 0o600 });
    io.log(`Private signing-key backup: ${keyFile} (keep this secure).`);
  }
  return { secret, public: derived };
}

// The body that switches an environment to explicit branch and tag patterns. The update
// replaces the whole environment, so the settings it already has are carried over.
function environmentBody(environment) {
  const body = {
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  if (!environment) return body;
  if (typeof environment.can_admins_bypass === 'boolean') {
    body.can_admins_bypass = environment.can_admins_bypass;
  }
  for (const rule of environment.protection_rules || []) {
    if (rule.type === 'wait_timer') {
      body.wait_timer = rule.wait_timer;
    } else if (rule.type === 'required_reviewers') {
      body.prevent_self_review = rule.prevent_self_review || false;
      body.reviewers = rule.reviewers.map(item => ({ type: item.type, id: item.reviewer.id }));
    } else if (rule.type !== 'branch_policy') {
      throw new SetupError('Unrecognized environment protection rule; refusing to alter it.');
    }
  }
  return body;
}

// The journal of an environment conversion: the branch and tag patterns the environment
// must end up with. Written atomically, before the conversion, so a rerun can finish it.
function saveMigration(file, desired) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.migration-${crypto.randomBytes(8).toString('hex')}`);
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeSync(descriptor, JSON.stringify(desired));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function loadMigration(file) {
  if (!lstat(file)) return null;
  let migration;
  try {
    migration = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new SetupError(`Cannot read migration journal: ${file}`);
  }
  const valid =
    Array.isArray(migration) &&
    migration.every(
      item =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === 'string' &&
        (item[1] === 'branch' || item[1] === 'tag')
    );
  if (!valid) throw new SetupError(`Invalid migration journal: ${file}`);
  return migration;
}

// Whether a deployment policy pattern allows a ref name. As in GitHub's matching, `*` and
// `?` stop at a slash and `**` does not.
function patternMatches(pattern, name) {
  const source = pattern
    .split(/(\*\*|\*|\?)/)
    .map(part => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`).test(name);
}

function resolveRepository(io, explicit) {
  let repo = explicit;
  if (!repo) {
    const remote = io.command(['git', 'remote', 'get-url', 'origin']);
    const match = remote.match(
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/
    );
    if (!match) {
      throw new SetupError('Cannot determine a GitHub repository from origin; use --repo OWNER/REPO.');
    }
    repo = match[1];
  }
  // The name becomes part of API routes and of file paths under the data directory.
  const valid = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/.test(repo);
  if (!valid || ['.', '..'].includes(repo.split('/')[1])) {
    throw new SetupError('Repository must have the form OWNER/REPO.');
  }
  return repo;
}

function expandHome(io, file) {
  if (file === '~') return io.home;
  return file.startsWith('~/') ? path.join(io.home, file.slice(2)) : file;
}

function setup(args, io = system) {
  for (const tool of ['gh', 'nix']) {
    if (!io.which(tool)) throw new SetupError(`Required executable not found: ${tool}`);
  }
  const repo = resolveRepository(io, args.repo);
  const root = `repos/${repo}`;
  const metadata = io.api(root);
  if (!(metadata.permissions && metadata.permissions.admin)) {
    throw new SetupError(`Repository administrator access is required for ${repo}.`);
  }
  const branch = metadata.default_branch;

  // Read everything and settle every refusal first; the writes start further down.
  if (args.workflow) {
    const workflow = io.api(`${root}/actions/workflows/${encodeURIComponent(args.workflow)}`);
    if (workflow.state !== 'active') {
      throw new SetupError('The selected workflow must be active on the default branch.');
    }
    io.api(`${root}/contents/${workflow.path}?ref=${encodeURIComponent(branch)}`);
  }
  let pages = io.api(`${root}/pages`, 'GET', undefined, true);
  if (pages && pages.build_type !== 'workflow' && !args.useExistingPages) {
    throw new SetupError(
      'This repository already publishes a Pages site from a branch. Use --use-existing-pages ' +
        'to switch that site to GitHub Actions publishing.'
    );
  }

  const dataHome = io.env.XDG_DATA_HOME || path.join(io.home, '.local/share');
  const dataDirectory = path.join(dataHome, 'static-nix-cache');
  const environmentPath = `${root}/environments/${encodeURIComponent(args.environment)}`;
  const policiesPath = `${environmentPath}/deployment-branch-policies`;
  const migrationPath = path.join(
    dataDirectory,
    repo,
    `${encodeURIComponent(args.environment)}.migration.json`
  );
  let migration = loadMigration(migrationPath);

  let environment = io.api(environmentPath, 'GET', undefined, true);
  const preexisting = Boolean(environment);
  let policy = environment ? environment.deployment_branch_policy : null;
  const protectedOnly = Boolean(policy && policy.protected_branches);
  const changePolicy = protectedOnly && (args.tagPattern.length > 0 || migration !== null);
  if (changePolicy && !args.allowReleaseTags) {
    throw new SetupError(
      'The environment permits protected branches only. Use --allow-release-tags to authorize tag deployments.'
    );
  }
  const conversion = changePolicy ? environmentBody(environment) : null;
  if (protectedOnly) {
    const branches = paginated(io, `${root}/branches`);
    const protectedNames = branches.filter(item => item.protected).map(item => item.name);
    if (changePolicy && migration === null) {
      // Only what could deploy before, plus the tags asked for: an unprotected default
      // branch is not let in by a flag that is about tags.
      migration = [
        ...protectedNames.map(name => [name, 'branch']),
        ...args.tagPattern.map(name => [name, 'tag']),
      ];
    }
    // With no protected branch at all, GitHub lets every branch deploy.
    if (!changePolicy && protectedNames.length > 0 && !protectedNames.includes(branch)) {
      throw new SetupError(
        'The environment permits protected branches, but the default branch is not protected.'
      );
    }
  }
  let policies =
    policy && policy.custom_branch_policies ? paginated(io, policiesPath, 'branch_policies') : [];

  const stored = io.api(`${root}/actions/variables/${args.publicKeyVariable}`, 'GET', undefined, true);
  const secrets = paginated(io, `${root}/actions/secrets`, 'secrets');
  // GitHub stores secret names in upper case.
  const hasSecret = secrets.some(item => item.name.toUpperCase() === args.secretName.toUpperCase());
  const keyFile = args.keyFile
    ? path.resolve(expandHome(io, args.keyFile))
    : path.join(dataDirectory, `${repo}.key`);
  const key = prepareKey(io, {
    repo,
    keyFile,
    storedPublic: stored ? stored.value : null,
    hasSecret,
    secretName: args.secretName,
    replaceSecret: args.replaceSecret,
  });

  io.log(`Configuring cache for ${repo} (default branch: ${branch}).`);
  if (key.secret && (!hasSecret || !stored)) {
    io.command(['gh', 'secret', 'set', args.secretName, '--repo', repo], key.secret);
  }
  if (!stored) {
    io.api(`${root}/actions/variables`, 'POST', { name: args.publicKeyVariable, value: key.public });
  }

  if (!pages) {
    pages = io.api(`${root}/pages`, 'POST', { build_type: 'workflow' });
  } else if (pages.build_type !== 'workflow') {
    // The update answers 204 with no body, unlike creation.
    io.api(`${root}/pages`, 'PUT', { build_type: 'workflow' });
    pages = io.api(`${root}/pages`);
  }

  // Creating the Pages site can create the environment and its default-branch policy.
  // Look again, so as not to duplicate a policy or overwrite what GitHub set up.
  if (!environment) {
    environment = io.api(environmentPath, 'GET', undefined, true);
    policy = environment ? environment.deployment_branch_policy : null;
    if (policy && policy.protected_branches) {
      throw new SetupError('Environment changed during setup; rerun to inspect its policy.');
    }
    if (policy && policy.custom_branch_policies) {
      policies = paginated(io, policiesPath, 'branch_policies');
    }
  }
  if (!environment || changePolicy) {
    if (changePolicy) saveMigration(migrationPath, migration);
    io.api(environmentPath, 'PUT', conversion || environmentBody(null));
  }
  if (!environment || changePolicy || (policy && policy.custom_branch_policies)) {
    const desired = migration !== null ? [...migration] : [];
    if (migration === null) {
      const allowed = policies.some(item => item.type === 'branch' && patternMatches(item.name, branch));
      if (!allowed && (!preexisting || args.allowDefaultBranch)) {
        desired.push([branch, 'branch']);
      } else if (!allowed) {
        io.log(
          `Note: the environment ${args.environment} does not allow deployments from the ` +
            `default branch (${branch}). Pass --allow-default-branch to add it.`
        );
      }
    }
    desired.push(...args.tagPattern.map(name => [name, 'tag']));
    const requested = new Set();
    for (const [name, type] of desired) {
      const id = `${type}:${name}`;
      if (requested.has(id)) continue;
      requested.add(id);
      if (!policies.some(item => item.name === name && item.type === type)) {
        io.api(policiesPath, 'POST', { name, type });
      }
    }
    if (migration !== null) fs.rmSync(migrationPath, { force: true });
  }

  let url = pages.html_url.replace(/\/+$/, '');
  const cachePath = args.cachePath.replace(/^\/+|\/+$/g, '');
  if (cachePath) url += `/${cachePath}`;
  io.log(`Pages: ${pages.html_url}`);
  io.log(`Public signing key: ${key.public}`);
  io.log(`extra-substituters = ${url}`);
  io.log(`extra-trusted-public-keys = ${key.public}`);

  if (args.dispatch) {
    const invocation = ['gh', 'workflow', 'run', args.workflow, '--repo', repo, '--ref', branch];
    // --raw-field passes the value as it is, without gh reading @file or typed values.
    for (const value of args.input) invocation.push('--raw-field', value);
    io.command(invocation);
    io.log(
      `Started workflow: https://github.com/${repo}/actions/workflows/${encodeURIComponent(args.workflow)}`
    );
  } else {
    io.log("Setup complete. The project's publishing workflow can now use this configuration.");
  }
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
  if (values.dispatch && !values.workflow) throw new UsageError('--dispatch requires --workflow');
  if (values.input.length > 0 && !values.dispatch) throw new UsageError('--input requires --dispatch');
  if (values.input.some(value => value.indexOf('=') < 1)) {
    throw new UsageError('--input must have the form NAME=VALUE');
  }
  for (const name of [values['secret-name'], values['public-key-variable']]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.toUpperCase().startsWith('GITHUB_')) {
      throw new UsageError('Secret/variable names must be identifiers without the GITHUB_ prefix');
    }
  }
  if (!values.environment) throw new UsageError('--environment must not be empty');
  return {
    repo: values.repo,
    keyFile: values['key-file'],
    environment: values.environment,
    secretName: values['secret-name'],
    publicKeyVariable: values['public-key-variable'],
    cachePath: values['cache-path'],
    useExistingPages: values['use-existing-pages'],
    tagPattern: values['tag-pattern'],
    allowReleaseTags: values['allow-release-tags'],
    allowDefaultBranch: values['allow-default-branch'],
    replaceSecret: values['replace-secret'],
    workflow: values.workflow,
    dispatch: values.dispatch,
    input: values.input,
  };
}

function main(argv) {
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
    setup(args);
  } catch (error) {
    // A file-system failure carries a code; anything else unexpected is a bug to surface.
    if (!(error instanceof SetupError) && !error.code) throw error;
    console.error(`Setup failed: ${error.message}`);
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  SetupError,
  UsageError,
  environmentBody,
  paginated,
  parseArguments,
  patternMatches,
  prepareKey,
  publicKey,
  setup,
  system,
};
