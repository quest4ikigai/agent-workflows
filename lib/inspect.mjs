// Read-only inspection of a target repository.
//
// Everything here is inference from files and (optionally) git/gh metadata.
// Nothing is written and nothing is invented: validation commands are only
// suggested when a matching package.json script actually exists.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const CONTEXT_CANDIDATES = [
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'ARCHITECTURE.md',
  'docs/ARCHITECTURE.md',
  'docs/architecture.md',
];

export const LEGACY_FILES = [
  '.github/workflows/agent-remediate.yml',
  '.github/scripts/agent-review-state.sh',
];

export function defaultExec(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { code: 127, stdout: '', stderr: String(r.error.message) };
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Inspect `dir`. Options:
 *   exec   – (cmd, args, {cwd}) => {code, stdout, stderr}; injectable for tests
 *   useGh  – query GitHub through the gh CLI (default true)
 */
export function inspectRepository(dir, { exec = defaultExec, useGh = true } = {}) {
  const root = path.resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }
  const has = (p) => existsSync(path.join(root, p));
  const read = (p) => (has(p) ? readFileSync(path.join(root, p), 'utf8') : null);

  const result = {
    root,
    isGitRepo: has('.git'),
    remote: null,
    defaultBranch: null,
    defaultBranchSource: null,
    ownerType: null,
    gh: { available: false, authenticated: false },
    node: null,
    python: null,
    ecosystems: [],
    contextDocs: CONTEXT_CANDIDATES.filter(has),
    workflows: listWorkflows(root),
    agentFiles: {
      config: has('.github/agent/config.yml'),
      setup: has('.github/agent/setup.sh'),
      validate: has('.github/agent/validate.sh'),
    },
    legacy: LEGACY_FILES.filter(has),
  };

  if (result.isGitRepo) {
    const url = git(exec, root, ['remote', 'get-url', 'origin']);
    result.remote = url ? parseGitHubRemote(url) : null;
    const head = git(exec, root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (head && head.startsWith('origin/')) {
      result.defaultBranch = head.slice('origin/'.length);
      result.defaultBranchSource = 'origin/HEAD';
    }
  }

  if (useGh && result.remote) {
    const status = exec('gh', ['auth', 'status'], { cwd: root });
    result.gh.available = status.code !== 127;
    result.gh.authenticated = status.code === 0;
    if (result.gh.authenticated) {
      const view = exec('gh', ['api', `repos/${result.remote.slug}`, '--jq', '{default_branch, owner_type: .owner.type}'], { cwd: root });
      if (view.code === 0) {
        try {
          const info = JSON.parse(view.stdout);
          if (info.default_branch) {
            result.defaultBranch = info.default_branch;
            result.defaultBranchSource = 'github';
          }
          result.ownerType = info.owner_type ?? null;
        } catch {
          // fall back to local information
        }
      }
    }
  }

  const pkgText = read('package.json');
  if (pkgText !== null) {
    result.ecosystems.push('node');
    result.node = inspectNode(root, pkgText, has, read);
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('uv.lock') || has('poetry.lock')) {
    result.ecosystems.push('python');
    result.python = inspectPython(has, read);
  }
  if (has('go.mod')) result.ecosystems.push('go');
  if (has('Cargo.toml')) result.ecosystems.push('rust');

  return result;
}

function git(exec, cwd, args) {
  const r = exec('git', args, { cwd });
  return r.code === 0 ? r.stdout.trim() : null;
}

export function parseGitHubRemote(url) {
  const m =
    url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/) ||
    url.match(/^ssh:\/\/git@github\.com(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?\/?$/) ||
    url.match(/^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1], name: m[2], slug: `${m[1]}/${m[2]}` };
}

function listWorkflows(root) {
  const dir = path.join(root, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

// Node.js ------------------------------------------------------------------------

const VALIDATION_BUCKETS = [
  ['typecheck', 'type-check', 'check-types', 'check:types'],
  ['lint'],
  ['format:check', 'fmt:check', 'prettier:check'],
  ['check'],
  // any remaining "*:check" scripts are inserted here
  ['test'],
  ['build'],
];

const NPM_PLACEHOLDER_TEST = /no test specified/;

function inspectNode(root, pkgText, has, read) {
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch (err) {
    return { error: `package.json is not valid JSON: ${err.message}`, scripts: {} };
  }
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const pm = detectPackageManager(pkg, has, read);
  const nodeVersion = detectNodeVersion(pkg, read);
  const { commands, skipped } = selectValidationScripts(scripts);
  return {
    packageManager: pm.name,
    packageManagerSource: pm.source,
    yarnBerry: pm.yarnBerry,
    lockfile: pm.lockfile,
    nodeVersion: nodeVersion.version,
    nodeVersionSource: nodeVersion.source,
    scripts,
    validationScripts: commands,
    skippedScripts: skipped,
    installCommands: installCommands(pm),
    runPrefix: runPrefix(pm.name),
  };
}

export function detectPackageManager(pkg, has, read) {
  const lockfile =
    ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json'].find(has) ?? null;
  let name = null;
  let source = null;
  let major = null;
  if (typeof pkg.packageManager === 'string') {
    const m = pkg.packageManager.match(/^(npm|yarn|pnpm|bun)@(\d+)/);
    if (m) {
      name = m[1];
      major = Number(m[2]);
      source = `package.json packageManager (${m[1]}@${pkg.packageManager.slice(m[1].length + 1).split('+')[0]})`;
    }
  }
  if (!name && lockfile) {
    name = { 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun' }[lockfile] ?? 'npm';
    source = lockfile;
  }
  if (!name) {
    name = 'npm';
    source = 'package.json (no lockfile)';
  }
  let yarnBerry = false;
  if (name === 'yarn') {
    yarnBerry = major !== null ? major >= 2 : has('.yarnrc.yml') || /__metadata:/.test(read('yarn.lock') ?? '');
  }
  // A packageManager pin is honoured through corepack.
  return { name, source, yarnBerry, lockfile, corepack: major !== null && name !== 'npm' };
}

function installCommands(pm) {
  switch (pm.name) {
    case 'npm':
      return pm.lockfile ? ['npm ci'] : ['npm install'];
    case 'yarn':
      if (pm.yarnBerry) return ['corepack enable', 'yarn install --immutable'];
      return pm.corepack ? ['corepack enable', 'yarn install --frozen-lockfile'] : ['yarn install --frozen-lockfile'];
    case 'pnpm':
      return ['corepack enable', 'pnpm install --frozen-lockfile'];
    case 'bun':
      return ['bun install --frozen-lockfile'];
    default:
      return [];
  }
}

function runPrefix(pm) {
  return { npm: 'npm run', yarn: 'yarn', pnpm: 'pnpm run', bun: 'bun run' }[pm] ?? 'npm run';
}

export function selectValidationScripts(scripts) {
  const names = Object.keys(scripts);
  const commands = [];
  const skipped = [];
  const used = new Set();
  const consider = (name) => {
    if (used.has(name) || !names.includes(name)) return;
    used.add(name);
    const body = String(scripts[name]);
    if (name === 'test' && NPM_PLACEHOLDER_TEST.test(body)) {
      skipped.push({ name, reason: 'npm placeholder test script' });
      return;
    }
    if (/(^|\s)--watch(\s|$)/.test(body)) {
      skipped.push({ name, reason: 'runs in watch mode' });
      return;
    }
    commands.push(name);
  };
  for (const bucket of VALIDATION_BUCKETS) {
    if (bucket[0] === 'test') {
      names
        .filter((n) => n.endsWith(':check'))
        .sort()
        .forEach(consider);
    }
    bucket.forEach(consider);
  }
  return { commands, skipped };
}

export function detectNodeVersion(pkg, read) {
  for (const file of ['.nvmrc', '.node-version']) {
    const v = read(file);
    if (v && v.trim()) return { version: v.trim().replace(/^v(?=\d)/, ''), source: file };
  }
  if (pkg.volta && typeof pkg.volta.node === 'string') {
    return { version: pkg.volta.node, source: 'package.json volta.node' };
  }
  const engines = pkg.engines && typeof pkg.engines.node === 'string' ? pkg.engines.node : null;
  if (engines) {
    const m = engines.match(/(\d+)/);
    if (m) return { version: m[1], source: `package.json engines.node (${engines})` };
  }
  return { version: null, source: null };
}

// Python -----------------------------------------------------------------------

function inspectPython(has, read) {
  const v = read('.python-version');
  let installCommands = [];
  let source = null;
  if (has('uv.lock')) {
    installCommands = ['python -m pip install uv', 'uv sync --frozen'];
    source = 'uv.lock';
  } else if (has('poetry.lock')) {
    installCommands = ['pipx install poetry', 'poetry install --no-interaction'];
    source = 'poetry.lock';
  } else if (has('requirements.txt')) {
    installCommands = ['python -m pip install -r requirements.txt'];
    source = 'requirements.txt';
  }
  return {
    pythonVersion: v && v.trim() ? v.trim() : null,
    pythonVersionSource: v && v.trim() ? '.python-version' : null,
    installCommands,
    installSource: source,
  };
}
