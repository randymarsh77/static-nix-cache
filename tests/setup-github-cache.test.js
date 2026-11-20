'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SetupError, UsageError, environmentBody, paginated, parseArguments, patternMatches, prepareKey,
  publicKey, setup, system,
} = require('../scripts/setup-github-cache');

const REPO = 'example-owner/example-project';
const PROTECTED_ONLY = { protected_branches: true, custom_branch_policies: false };
const CUSTOM = { protected_branches: false, custom_branch_policies: true };

// A repository as the GitHub API shows it, recording what is read from and written to it.
class FakeGitHub {
  constructor() {
    this.pages = null;
    this.environment = null;
    this.public = null;
    this.secretNames = new Set();
    this.admin = true;
    this.autoEnvironment = false;
    this.workflowState = 'active';
    this.policies = [];
    this.writes = [];
    this.reads = [];
    this.commands = [];
    this.branches = [
      { name: 'main', protected: true },
      { name: 'topic', protected: false },
    ];
  }

  command(args) {
    this.commands.push(args);
    if (args.slice(0, 3).join(' ') === 'git remote get-url') return `git@github.com:${REPO}.git`;
    if (args.includes('generate-secret')) return 'test-secret';
    if (args.includes('convert-secret-to-public')) return 'test-public';
    if (args.slice(0, 3).join(' ') === 'gh secret set') this.secretNames.add(args[3]);
    return '';
  }

  api(route, method = 'GET', body) {
    const prefix = `repos/${REPO}`;
    const full = route.split('?')[0];
    if (!full.startsWith(prefix)) throw new Error(`Unexpected destination: ${route}`);
    const rest = full.slice(prefix.length);
    if (method !== 'GET') {
      this.writes.push([rest, method, body]);
      if (rest === '/actions/variables') {
        this.public = body.value;
      } else if (rest === '/pages') {
        this.pages = { html_url: 'https://example-owner.github.io/example-project/', ...body };
        if (this.autoEnvironment) {
          this.environment = { deployment_branch_policy: CUSTOM, protection_rules: [] };
          this.policies.push({ name: 'main', type: 'branch' });
        }
        return method === 'POST' ? this.pages : null;
      } else if (rest.endsWith('/deployment-branch-policies')) {
        this.policies.push(body);
      } else if (rest.startsWith('/environments/')) {
        this.environment = { protection_rules: [], ...body };
      } else {
        throw new Error(`Unexpected write: ${route}`);
      }
      return body;
    }
    this.reads.push(rest);
    if (!rest) return { permissions: { admin: this.admin }, default_branch: 'main' };
    if (rest.startsWith('/actions/workflows/')) {
      return { state: this.workflowState, path: '.github/workflows/publish.yml' };
    }
    if (rest.startsWith('/contents/')) return {};
    if (rest === '/pages') return this.pages;
    if (rest.endsWith('/deployment-branch-policies')) return { branch_policies: this.policies };
    if (rest.startsWith('/environments/')) return this.environment;
    if (rest.startsWith('/actions/variables/')) return this.public ? { value: this.public } : null;
    if (rest === '/actions/secrets') {
      return { secrets: [...this.secretNames].map(name => ({ name })) };
    }
    if (rest === '/branches') return this.branches;
    throw new Error(`Unexpected read: ${route}`);
  }
}

let directory;
let keyFile;
let dataHome;
let github;
let output;
let io;

const options = (...argv) => parseArguments(['--key-file', keyFile, ...argv]);
const run = (...argv) => setup(options(...argv), io);
const environmentWrites = () => github.writes.filter(([route]) => route.startsWith('/environments/'));
const journal = () =>
  path.join(dataHome, 'static-nix-cache', REPO, 'github-pages.migration.json');
const writeKey = (mode = 0o600) => {
  fs.writeFileSync(keyFile, 'test-secret\n');
  fs.chmodSync(keyFile, mode);
};

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-github-'));
  keyFile = path.join(directory, 'backup.key');
  dataHome = path.join(directory, 'data');
  github = new FakeGitHub();
  output = [];
  io = {
    env: { XDG_DATA_HOME: dataHome },
    home: directory,
    log: message => output.push(message),
    which: () => true,
    command: (...args) => github.command(...args),
    api: (...args) => github.api(...args),
  };
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('a repository with nothing set up', () => {
  test('is provisioned from the origin remote, with the key backed up', () => {
    run();
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('test-secret\n');
    expect(github.secretNames).toContain('NIX_CACHE_SIGNING_KEY');
    expect(github.public).toBe('test-public');
    expect(github.pages.build_type).toBe('workflow');
    expect(github.policies).toContainEqual({ name: 'main', type: 'branch' });
    expect(output.join('\n')).not.toContain('test-secret');
    expect(github.commands.some(args => args.includes('workflow'))).toBe(false);
    expect(github.reads.some(route => route.includes('workflows'))).toBe(false);
  });

  test('gets its key backup under the data directory by default', () => {
    setup(parseArguments([]), io);
    const backup = path.join(dataHome, 'static-nix-cache', `${REPO}.key`);
    expect(fs.readFileSync(backup, 'utf8')).toBe('test-secret\n');
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
  });

  test('is not asked of git when the repository is given', () => {
    run('--repo', REPO);
    expect(github.commands.some(args => args[0] === 'git')).toBe(false);
  });

  test('keeps the environment and policy that creating Pages gave it', () => {
    github.autoEnvironment = true;
    run();
    expect(github.policies).toEqual([{ name: 'main', type: 'branch' }]);
    expect(environmentWrites().filter(([route]) => route === '/environments/github-pages')).toEqual([]);
  });

  test('takes other names for the environment, secret and variable', () => {
    run(
      '--secret-name', 'PROJECT_SIGNING_KEY',
      '--public-key-variable', 'PROJECT_PUBLIC_KEY',
      '--environment', 'cache-production',
      '--cache-path', 'cache'
    );
    expect(github.secretNames).toContain('PROJECT_SIGNING_KEY');
    expect(github.writes.some(([route]) => route === '/environments/cache-production')).toBe(true);
    const variable = github.writes.find(([route]) => route === '/actions/variables')[2];
    expect(variable.name).toBe('PROJECT_PUBLIC_KEY');
    expect(output).toContain('extra-substituters = https://example-owner.github.io/example-project/cache');
  });
});

describe('running it again', () => {
  test('changes nothing and asks for no flag', () => {
    run();
    github.commands.length = 0;
    github.writes.length = 0;
    run();
    expect(github.writes).toEqual([]);
    expect(github.commands.some(args => args.includes('generate-secret'))).toBe(false);
    expect(github.commands.some(args => args.includes('secret'))).toBe(false);
  });
});

describe('where the repository is', () => {
  test('an origin that is not on GitHub is refused before any request', () => {
    github.command = () => 'https://notgithub.com/owner/repo.git';
    expect(() => run()).toThrow(/Cannot determine/);
    expect(github.reads).toEqual([]);
    expect(github.writes).toEqual([]);
  });

  test.each(['owner', 'owner/..', '../repo', 'owner/repo/extra', 'owner/re po'])(
    'the name %j is refused before any request',
    name => {
      expect(() => run('--repo', name)).toThrow(/OWNER\/REPO/);
      expect(github.reads).toEqual([]);
    }
  );

  test('someone who does not administer it can change nothing', () => {
    github.admin = false;
    expect(() => run()).toThrow(/administrator/);
    expect(github.writes).toEqual([]);
  });
});

describe('signing keys', () => {
  test('a secret and variable already there are kept, with no backup needed', () => {
    github.secretNames.add('NIX_CACHE_SIGNING_KEY');
    github.public = 'test-public';
    run();
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(github.commands.some(args => args[0] === 'nix')).toBe(false);
  });

  test('a secret is recognized whatever the case it was asked for in', () => {
    github.secretNames.add('PROJECT_SIGNING_KEY');
    github.public = 'test-public';
    run('--secret-name', 'Project_Signing_Key');
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(github.commands.some(args => args[0] === 'nix')).toBe(false);
    expect(github.commands.some(args => args.includes('secret'))).toBe(false);
  });

  test.each(['NIX_CACHE_SIGNING_KEY', 'nix_cache_signing_key'])(
    'a secret alone, asked for as %s, is not replaced by a new key',
    name => {
      github.secretNames.add('NIX_CACHE_SIGNING_KEY');
      expect(() => run('--secret-name', name)).toThrow(/Incomplete signing/);
      expect(fs.existsSync(keyFile)).toBe(false);
      expect(github.writes).toEqual([]);
      expect(github.commands.some(args => args.includes('secret'))).toBe(false);
    }
  );

  test('a variable alone is not replaced by a new key', () => {
    github.public = 'test-public';
    expect(() => run()).toThrow(/Incomplete signing/);
    expect(github.writes).toEqual([]);
  });

  test('a secret alone is not overwritten from a key file unless that is asked for', () => {
    writeKey();
    github.secretNames.add('NIX_CACHE_SIGNING_KEY');
    expect(() => run()).toThrow(/--replace-secret/);
    expect(github.writes).toEqual([]);
    expect(github.commands.some(args => args.includes('secret'))).toBe(false);
  });

  test('a secret alone is stored again from the key file when that is asked for', () => {
    writeKey();
    github.secretNames.add('NIX_CACHE_SIGNING_KEY');
    run('--replace-secret');
    expect(github.public).toBe('test-public');
    expect(github.commands.some(args => args.includes('generate-secret'))).toBe(false);
    expect(github.commands).toContainEqual(['gh', 'secret', 'set', 'NIX_CACHE_SIGNING_KEY', '--repo', REPO]);
  });

  test('a variable alone is completed from the matching key file', () => {
    writeKey();
    github.public = 'test-public';
    run();
    expect(github.secretNames).toContain('NIX_CACHE_SIGNING_KEY');
    expect(github.writes.some(([route]) => route === '/actions/variables')).toBe(false);
  });

  test('a key file that does not match the variable changes nothing', () => {
    writeKey();
    github.public = 'different-public-key';
    expect(() => run()).toThrow(/refusing rotation/);
    expect(github.writes).toEqual([]);
  });

  test('a key file others can read is refused', () => {
    writeKey(0o644);
    expect(() => run()).toThrow(/owner-only/);
    expect(github.writes).toEqual([]);
  });

  test('a key file that is a symlink is refused', () => {
    const target = path.join(directory, 'elsewhere.key');
    fs.writeFileSync(target, 'test-secret\n', { mode: 0o600 });
    fs.symlinkSync(target, keyFile);
    expect(() => run()).toThrow(/owner-only/);
    expect(github.writes).toEqual([]);
  });
});

describe('an existing Pages site', () => {
  test('published from a branch is left alone unless switching it is asked for', () => {
    github.pages = { build_type: 'legacy' };
    expect(() => run()).toThrow(/--use-existing-pages/);
    expect(github.writes).toEqual([]);
  });

  test('published from a branch is switched when that is asked for', () => {
    github.pages = { build_type: 'legacy' };
    run('--use-existing-pages');
    expect(github.writes).toContainEqual(['/pages', 'PUT', { build_type: 'workflow' }]);
  });

  test('published by Actions already is used as it is', () => {
    github.pages = { build_type: 'workflow', html_url: 'https://cache.example.org/' };
    run();
    expect(github.writes.some(([route]) => route === '/pages')).toBe(false);
    expect(output).toContain('extra-substituters = https://cache.example.org');
  });
});

describe('an environment restricted to protected branches', () => {
  beforeEach(() => {
    github.environment = { deployment_branch_policy: PROTECTED_ONLY };
  });

  test('is left as it is when no tags are asked for', () => {
    run();
    expect(environmentWrites()).toEqual([]);
  });

  test('is left as it is when no branch is protected, which lets every branch deploy', () => {
    github.branches = [{ name: 'main', protected: false }];
    run();
    expect(environmentWrites()).toEqual([]);
  });

  test('stops setup when it would keep the default branch from deploying', () => {
    github.branches = [
      { name: 'main', protected: false },
      { name: 'release/1', protected: true },
    ];
    expect(() => run()).toThrow(/default branch is not protected/);
    expect(github.writes).toEqual([]);
  });

  test('is not opened to tags unless the conversion is asked for', () => {
    expect(() => run('--tag-pattern', 'v*')).toThrow(/--allow-release-tags/);
    expect(github.writes).toEqual([]);
  });

  test('keeps its reviewers, timer, bypass setting and branches when converted', () => {
    github.environment.can_admins_bypass = false;
    github.environment.protection_rules = [
      { type: 'wait_timer', wait_timer: 15 },
      {
        type: 'required_reviewers',
        prevent_self_review: true,
        reviewers: [{ type: 'Team', reviewer: { id: 42 } }],
      },
    ];
    run('--tag-pattern', 'v*', '--allow-release-tags');
    const body = environmentWrites().find(([route]) => route === '/environments/github-pages')[2];
    expect(body).toEqual({
      deployment_branch_policy: CUSTOM,
      can_admins_bypass: false,
      wait_timer: 15,
      prevent_self_review: true,
      reviewers: [{ type: 'Team', id: 42 }],
    });
    expect(github.policies).toEqual([
      { name: 'main', type: 'branch' },
      { name: 'v*', type: 'tag' },
    ]);
  });

  test('does not let in an unprotected default branch when converted', () => {
    github.branches = [
      { name: 'main', protected: false },
      { name: 'release/1', protected: true },
    ];
    run('--tag-pattern', 'v*', '--allow-release-tags');
    expect(github.policies).toEqual([
      { name: 'release/1', type: 'branch' },
      { name: 'v*', type: 'tag' },
    ]);
  });

  test('is not converted when it has a rule this does not know how to keep', () => {
    github.environment.protection_rules = [{ type: 'custom-rule' }];
    expect(() => run('--tag-pattern', 'v*', '--allow-release-tags')).toThrow(/Unrecognized/);
    expect(github.writes).toEqual([]);
  });

  test('gets every policy it was owed when a conversion is interrupted and run again', () => {
    github.branches = [
      { name: 'main', protected: false },
      { name: 'release/1', protected: true },
      { name: 'release/2', protected: true },
    ];
    io.api = (route, method, body) => {
      if (method === 'POST' && body.name === 'release/2') throw new SetupError('Interrupted');
      return github.api(route, method, body);
    };
    expect(() => run('--tag-pattern', 'v*', '--allow-release-tags')).toThrow(/Interrupted/);
    expect(fs.statSync(journal()).mode & 0o777).toBe(0o600);

    // The second run can no longer tell which branches were protected, and is not told the tags.
    io.api = (...args) => github.api(...args);
    github.branches = [{ name: 'main', protected: false }];
    run();
    expect(github.policies).toEqual([
      { name: 'release/1', type: 'branch' },
      { name: 'release/2', type: 'branch' },
      { name: 'v*', type: 'tag' },
    ]);
    expect(fs.existsSync(journal())).toBe(false);
  });

  test('is not converted when the journal of the conversion cannot be written', () => {
    fs.mkdirSync(dataHome);
    fs.chmodSync(dataHome, 0o500);
    try {
      expect(() => run('--tag-pattern', 'v*', '--allow-release-tags')).toThrow(/EACCES/);
    } finally {
      fs.chmodSync(dataHome, 0o700);
    }
    expect(github.environment.deployment_branch_policy.protected_branches).toBe(true);
    expect(environmentWrites()).toEqual([]);
  });
});

describe('a conversion journal that cannot be trusted', () => {
  test.each(['{', '[["main", "invalid"]]', '[["main"]]', '{"main": "branch"}'])(
    '%s stops setup before anything is written',
    content => {
      fs.mkdirSync(path.dirname(journal()), { recursive: true });
      fs.writeFileSync(journal(), content);
      expect(() => run()).toThrow(/migration journal/);
      expect(github.writes).toEqual([]);
    }
  );
});

describe('an existing environment with its own branch and tag patterns', () => {
  beforeEach(() => {
    github.environment = { deployment_branch_policy: CUSTOM, protection_rules: [] };
    github.policies = [{ name: 'release/*', type: 'branch' }];
  });

  test('is not opened to the default branch unless that is asked for', () => {
    run('--tag-pattern', 'v*');
    expect(github.policies).toEqual([
      { name: 'release/*', type: 'branch' },
      { name: 'v*', type: 'tag' },
    ]);
    expect(output.join('\n')).toMatch(/--allow-default-branch/);
    expect(environmentWrites().filter(([, method]) => method === 'PUT')).toEqual([]);
  });

  test('is opened to the default branch when that is asked for', () => {
    run('--allow-default-branch');
    expect(github.policies).toContainEqual({ name: 'main', type: 'branch' });
  });

  test('needs nothing when a pattern already covers the default branch', () => {
    github.policies = [{ name: 'ma*', type: 'branch' }];
    run();
    expect(github.policies).toEqual([{ name: 'ma*', type: 'branch' }]);
    expect(output.join('\n')).not.toMatch(/--allow-default-branch/);
  });

  test('is not covered by a tag pattern of the same name', () => {
    github.policies = [{ name: 'main', type: 'tag' }];
    run();
    expect(github.policies).toEqual([{ name: 'main', type: 'tag' }]);
    expect(output.join('\n')).toMatch(/--allow-default-branch/);
  });

  test('gets each tag pattern once', () => {
    run('--tag-pattern', 'v*', '--tag-pattern', 'v*');
    expect(github.policies.filter(item => item.type === 'tag')).toEqual([{ name: 'v*', type: 'tag' }]);
  });
});

test('an environment open to every branch is left open', () => {
  github.environment = { deployment_branch_policy: null, protection_rules: [] };
  run('--tag-pattern', 'v*');
  expect(environmentWrites()).toEqual([]);
});

describe('deployment policy patterns', () => {
  test.each([
    ['main', 'main', true],
    ['main', 'maintenance', false],
    ['ma*', 'main', true],
    ['*', 'main', true],
    ['*', 'release/1', false],
    ['release/*', 'release/1', true],
    ['release/*', 'release/1/hotfix', false],
    ['**', 'release/1/hotfix', true],
    ['v?', 'v1', true],
    ['v?', 'v10', false],
    ['v1.0', 'v1x0', false],
    ['a+b', 'a+b', true],
  ])('%s against %s', (pattern, name, expected) => {
    expect(patternMatches(pattern, name)).toBe(expected);
  });
});

describe('a workflow', () => {
  test('is dispatched on the default branch with its inputs passed literally', () => {
    run(
      '--workflow', 'publish.yml', '--dispatch',
      '--input', 'release_tag=v0.10.0',
      '--input', 'description=@literal-file-name'
    );
    expect(github.reads).toContain('/contents/.github/workflows/publish.yml');
    expect(github.commands[github.commands.length - 1]).toEqual([
      'gh', 'workflow', 'run', 'publish.yml', '--repo', REPO, '--ref', 'main',
      '--raw-field', 'release_tag=v0.10.0',
      '--raw-field', 'description=@literal-file-name',
    ]);
  });

  test('that is disabled stops setup before anything is written', () => {
    github.workflowState = 'disabled_manually';
    expect(() => run('--workflow', 'publish.yml')).toThrow(/active/);
    expect(github.writes).toEqual([]);
  });
});

describe('talking to GitHub', () => {
  const answer = (status, stdout, stderr) =>
    jest.spyOn(childProcess, 'spawnSync').mockReturnValue({ status, stdout, stderr });

  test('a missing resource is null only where one may be missing', () => {
    answer(1, '', 'gh: Not Found (HTTP 404)');
    expect(system.api(`repos/${REPO}/pages`, 'GET', undefined, true)).toBeNull();
    expect(() => system.api(`repos/${REPO}/pages`)).toThrow(SetupError);
  });

  test('a refusal is never taken for a missing resource', () => {
    answer(1, '', 'gh: Forbidden (HTTP 403)');
    expect(() => system.api(`repos/${REPO}/pages`, 'GET', undefined, true)).toThrow(/403/);
  });

  test('a body is sent on stdin and an empty answer is null', () => {
    const spawn = answer(0, '', '');
    expect(system.api(`repos/${REPO}/pages`, 'PUT', { build_type: 'workflow' })).toBeNull();
    expect(spawn).toHaveBeenCalledWith(
      'gh',
      ['api', `repos/${REPO}/pages`, '--method', 'PUT', '--input', '-'],
      { input: '{"build_type":"workflow"}', encoding: 'utf8' }
    );
  });

  test('a failing command reports its error but not what it was given on stdin', () => {
    answer(1, '', 'no such secret store');
    expect(() => system.command(['gh', 'secret', 'set', 'NAME'], 'private-key')).toThrow(
      'gh secret failed: no such secret store'
    );
  });

  test('lists are read to their last page', () => {
    const first = Array.from({ length: 100 }, (_, index) => index);
    const pages = [{ secrets: first }, { secrets: [100] }];
    const routes = [];
    const lister = { api: route => (routes.push(route), pages.shift()) };
    expect(paginated(lister, `repos/${REPO}/actions/secrets`, 'secrets')).toEqual([...first, 100]);
    expect(routes).toEqual([
      `repos/${REPO}/actions/secrets?per_page=100&page=1`,
      `repos/${REPO}/actions/secrets?per_page=100&page=2`,
    ]);
  });
});

describe('the command line', () => {
  test.each([
    [['--dispatch']],
    [['--input', 'release=v1']],
    [['--workflow', 'cache.yml', '--dispatch', '--input', 'missing-equals']],
    [['--workflow', 'cache.yml', '--dispatch', '--input', '=value']],
    [['--secret-name', 'GITHUB_RESERVED']],
    [['--public-key-variable', 'invalid/name']],
    [['--environment', '']],
    [['--no-such-option']],
    [['stray']],
  ])('%j is refused', argv => {
    expect(() => parseArguments(argv)).toThrow(UsageError);
  });

  test('--help asks for nothing else', () => {
    expect(parseArguments(['--help'])).toBeNull();
  });

  test('a new environment has only the branch policy to set', () => {
    expect(environmentBody(null)).toEqual({ deployment_branch_policy: CUSTOM });
  });
});

// These use the real Nix, to show that the keys written and read are the ones Nix makes.
const nix = system.which('nix') ? describe : describe.skip;
nix('with Nix itself', () => {
  const real = { ...system, log: () => {} };

  test('a key made by nix-store --generate-binary-cache-key is accepted', () => {
    const privateFile = path.join(directory, 'private.key');
    const publicFile = path.join(directory, 'public.key');
    childProcess.execFileSync('nix-store', [
      '--generate-binary-cache-key', 'test-cache-1', privateFile, publicFile,
    ]);
    expect(publicKey(real, fs.readFileSync(privateFile, 'utf8'))).toBe(
      fs.readFileSync(publicFile, 'utf8').trim()
    );
  });

  test('a key is made, backed up and read back', () => {
    const made = prepareKey(real, { repo: REPO, keyFile, storedPublic: null, hasSecret: false });
    const again = prepareKey(real, { repo: REPO, keyFile, storedPublic: made.public, hasSecret: true });
    expect(again).toEqual(made);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(made.public).toMatch(/^example-owner-example-project-cache-1:/);
  });
});
