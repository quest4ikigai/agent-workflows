import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { detectNodeVersion, detectPackageManager, inspectRepository, parseGitHubRemote, selectValidationScripts } from '../lib/inspect.mjs';
import { cleanupTemp, fakeExec, fixtureRepo } from './helpers.mjs';

after(cleanupTemp);

const files = (map) => ({ has: (p) => p in map, read: (p) => map[p] ?? null });

test('parses GitHub remotes in every common form', () => {
  const expected = { owner: 'acme', name: 'widget', slug: 'acme/widget' };
  for (const url of [
    'git@github.com:acme/widget.git',
    'git@github.com:acme/widget',
    'https://github.com/acme/widget.git',
    'https://github.com/acme/widget',
    'https://token@github.com/acme/widget.git',
    'ssh://git@github.com/acme/widget.git',
  ]) {
    assert.deepEqual(parseGitHubRemote(url), expected, url);
  }
  assert.equal(parseGitHubRemote('git@gitlab.com:acme/widget.git'), null);
});

test('package manager detection: packageManager field wins over lockfiles', () => {
  const { has, read } = files({ 'package-lock.json': '{}' });
  assert.equal(detectPackageManager({ packageManager: 'pnpm@9.1.0' }, has, read).name, 'pnpm');
  assert.equal(detectPackageManager({}, has, read).name, 'npm');
});

test('package manager detection: lockfiles and yarn flavours', () => {
  const cases = [
    [{ 'pnpm-lock.yaml': '' }, {}, 'pnpm', false],
    [{ 'yarn.lock': '# yarn lockfile v1' }, {}, 'yarn', false],
    [{ 'yarn.lock': '__metadata:\n  version: 8' }, {}, 'yarn', true],
    [{ 'yarn.lock': '', '.yarnrc.yml': '' }, {}, 'yarn', true],
    [{ 'yarn.lock': '' }, { packageManager: 'yarn@4.5.0' }, 'yarn', true],
    [{ 'yarn.lock': '' }, { packageManager: 'yarn@1.22.22+sha512.x' }, 'yarn', false],
    [{ 'bun.lockb': '' }, {}, 'bun', false],
    [{}, {}, 'npm', false],
  ];
  for (const [map, pkg, name, berry] of cases) {
    const { has, read } = files(map);
    const pm = detectPackageManager(pkg, has, read);
    assert.equal(pm.name, name, JSON.stringify(map));
    assert.equal(pm.yarnBerry, berry, JSON.stringify(map));
  }
});

test('node version detection order', () => {
  assert.deepEqual(detectNodeVersion({ engines: { node: '>=20' } }, files({ '.nvmrc': 'v22.3.0\n' }).read), { version: '22.3.0', source: '.nvmrc' });
  assert.deepEqual(detectNodeVersion({ engines: { node: '>=20' } }, files({ '.node-version': 'lts/iron' }).read), { version: 'lts/iron', source: '.node-version' });
  assert.equal(detectNodeVersion({ volta: { node: '22.1.0' } }, files({}).read).version, '22.1.0');
  assert.equal(detectNodeVersion({ engines: { node: '>=22.12.0' } }, files({}).read).version, '22');
  assert.equal(detectNodeVersion({ engines: { node: '^20.11 || >=22' } }, files({}).read).version, '20');
  assert.equal(detectNodeVersion({}, files({}).read).version, null);
});

test('validation scripts: only existing scripts, in a stable order', () => {
  const { commands, skipped } = selectValidationScripts({
    build: 'tsc',
    test: 'vitest run',
    'test:watch': 'vitest',
    lint: 'eslint .',
    'gen:docs:check': 'node gen --check',
    'api:check': 'node api --check',
    typecheck: 'tsc --noEmit',
    dev: 'vite',
    check: 'astro check',
  });
  assert.deepEqual(commands, ['typecheck', 'lint', 'check', 'api:check', 'gen:docs:check', 'test', 'build']);
  assert.deepEqual(skipped, []);
});

test('validation scripts: skips npm placeholder tests and watch mode', () => {
  const { commands, skipped } = selectValidationScripts({
    test: 'echo "Error: no test specified" && exit 1',
    build: 'vite build --watch',
    lint: 'eslint .',
  });
  assert.deepEqual(commands, ['lint']);
  assert.deepEqual(skipped.map((s) => s.name), ['test', 'build']);
});

test('inspects the yarn/TypeScript fixture (Mealie-like)', () => {
  const dir = fixtureRepo('yarn-typescript', { defaultBranch: 'agent-main' });
  const r = inspectRepository(dir, { exec: fakeExec(), useGh: false });
  assert.equal(r.isGitRepo, true);
  assert.deepEqual(r.remote, { owner: 'acme', name: 'widget', slug: 'acme/widget' });
  assert.equal(r.defaultBranch, 'agent-main');
  assert.equal(r.defaultBranchSource, 'origin/HEAD');
  assert.equal(r.node.packageManager, 'yarn');
  assert.equal(r.node.packageManagerSource, 'package.json packageManager (yarn@1.22.22)');
  assert.deepEqual(r.node.installCommands, ['corepack enable', 'yarn install --frozen-lockfile']);
  assert.equal(r.node.nodeVersion, '22');
  assert.deepEqual(r.node.validationScripts, ['typecheck', 'lint', 'gen:docs:check', 'test', 'build']);
  assert.deepEqual(r.contextDocs, ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md']);
  assert.deepEqual(r.workflows, ['ci.yml']);
  assert.deepEqual(r.ecosystems, ['node']);
});

test('inspects the npm/Astro fixture (Curious Workbench-like)', () => {
  const r = inspectRepository(fixtureRepo('npm-astro'), { exec: fakeExec(), useGh: false });
  assert.equal(r.node.packageManager, 'npm');
  assert.deepEqual(r.node.installCommands, ['npm ci']);
  assert.equal(r.node.nodeVersion, '22');
  assert.deepEqual(r.node.validationScripts, ['build']);
  assert.equal(r.node.runPrefix, 'npm run');
});

test('detects legacy agent files and existing agent configuration', () => {
  const r = inspectRepository(fixtureRepo('existing-workflows'), { exec: fakeExec(), useGh: false });
  assert.deepEqual(r.legacy, ['.github/workflows/agent-remediate.yml', '.github/scripts/agent-review-state.sh']);
  assert.equal(r.agentFiles.validate, true);
  assert.equal(r.agentFiles.config, false);
  assert.equal(r.node.packageManager, 'pnpm');
  assert.equal(r.node.nodeVersion, '22.11.0');
});

test('uses gh for the authoritative default branch and owner type', () => {
  const exec = fakeExec({ 'api repos/acme/widget': { code: 0, stdout: '{"default_branch":"trunk","owner_type":"Organization"}' } });
  const r = inspectRepository(fixtureRepo('minimal', { defaultBranch: 'main' }), { exec });
  assert.equal(r.defaultBranch, 'trunk');
  assert.equal(r.defaultBranchSource, 'github');
  assert.equal(r.ownerType, 'Organization');
  assert.equal(r.node, null);
});

test('degrades gracefully without git metadata or gh', () => {
  const dir = fixtureRepo('minimal', { remote: null, defaultBranch: null });
  const r = inspectRepository(dir, { exec: fakeExec({}, { ghInstalled: false }) });
  assert.equal(r.remote, null);
  assert.equal(r.defaultBranch, null);
  assert.equal(r.gh.available, false);
});

test('rejects a path that is not a directory', () => {
  assert.throws(() => inspectRepository('/definitely/not/here'), /not a directory/);
});
