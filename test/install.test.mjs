import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { inspectRepository } from '../lib/inspect.mjs';
import { applyPlan, planInstall } from '../lib/install.mjs';
import { loadConfig } from '../lib/config.mjs';
import { parseWrapper } from '../lib/templates.mjs';
import { main } from '../lib/cli.mjs';
import { cleanupTemp, fakeExec, fixtureRepo } from './helpers.mjs';

after(cleanupTemp);

const read = (dir, p) => readFileSync(path.join(dir, p), 'utf8');
const actions = (plan) => Object.fromEntries(plan.files.map((f) => [f.path, f.action]));

function install(dir, options = {}, inspectOptions = {}) {
  const inspection = inspectRepository(dir, { exec: fakeExec(), useGh: false, ...inspectOptions });
  const plan = planInstall(inspection, options);
  applyPlan(dir, plan);
  return plan;
}

function capture() {
  const out = { text: '', write(s) { this.text += s; } };
  return out;
}

test('installs into a Mealie-like yarn/TypeScript repository', () => {
  const dir = fixtureRepo('yarn-typescript', { defaultBranch: 'agent-main' });
  const plan = install(dir, { trustedUsers: ['quest4ikigai'] });
  assert.deepEqual(actions(plan), {
    '.github/agent/config.yml': 'create',
    '.github/agent/setup.sh': 'create',
    '.github/agent/validate.sh': 'create',
    '.github/workflows/agent-implement.yml': 'create',
    '.github/workflows/agent-review.yml': 'create',
    '.github/workflows/agent-human-fix.yml': 'create',
  });
  const { config } = loadConfig(read(dir, '.github/agent/config.yml'));
  assert.equal(config.base_branch, 'agent-main');
  assert.deepEqual(config.trusted_users, ['quest4ikigai']);
  assert.equal(config.setup.node_version, '22');
  assert.deepEqual(config.context, ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md']);
  assert.match(read(dir, '.github/agent/setup.sh'), /corepack enable\nyarn install --frozen-lockfile\n$/);
  assert.match(read(dir, '.github/agent/validate.sh'), /yarn typecheck\nyarn lint\nyarn gen:docs:check\nyarn test\nyarn build\n$/);
  assert.ok(statSync(path.join(dir, '.github/agent/validate.sh')).mode & 0o100, 'validate.sh is executable');
  assert.equal(read(dir, '.github/workflows/ci.yml').includes('echo ci'), true, 'unrelated workflow untouched');
});

test('installs into a Curious-Workbench-like npm/Astro repository', () => {
  const dir = fixtureRepo('npm-astro');
  install(dir, { trustedUsers: ['quest4ikigai'] });
  assert.match(read(dir, '.github/agent/setup.sh'), /\nnpm ci\n$/);
  assert.match(read(dir, '.github/agent/validate.sh'), /\nnpm run build\n$/);
  const { config } = loadConfig(read(dir, '.github/agent/config.yml'));
  assert.equal(config.base_branch, 'main');
  assert.deepEqual(config.context, ['CLAUDE.md', 'AGENTS.md']);
});

test('minimal repository: no setup script, empty validation is explicit', () => {
  const dir = fixtureRepo('minimal');
  const plan = install(dir, { trustedUsers: ['alice'] });
  assert.equal(actions(plan)['.github/agent/setup.sh'], undefined);
  assert.equal(existsSync(path.join(dir, '.github/agent/setup.sh')), false);
  const { config } = loadConfig(read(dir, '.github/agent/config.yml'));
  assert.equal(config.setup.script, null);
  assert.equal(config.setup.node_version, null);
  assert.match(read(dir, '.github/agent/validate.sh'), /no validation commands detected/);
});

test('go repository gets commented suggestions, never invented commands', () => {
  const dir = fixtureRepo('go-service');
  install(dir, { trustedUsers: ['alice'] });
  const script = read(dir, '.github/agent/validate.sh');
  assert.match(script, /#   go test \.\/\.\.\./);
  assert.doesNotMatch(script, /^go test/m);
});

test('installation is idempotent', () => {
  const dir = fixtureRepo('npm-astro');
  install(dir, { trustedUsers: ['alice'] });
  const before = Object.fromEntries(['config.yml', 'setup.sh', 'validate.sh'].map((f) => [f, read(dir, `.github/agent/${f}`)]));
  const second = install(dir, { trustedUsers: ['someone-else'], baseBranch: 'other' });
  assert.deepEqual(actions(second), {
    '.github/agent/config.yml': 'keep',
    '.github/agent/setup.sh': 'keep',
    '.github/agent/validate.sh': 'keep',
    '.github/workflows/agent-implement.yml': 'unchanged',
    '.github/workflows/agent-review.yml': 'unchanged',
    '.github/workflows/agent-human-fix.yml': 'unchanged',
  });
  for (const [f, text] of Object.entries(before)) assert.equal(read(dir, `.github/agent/${f}`), text, `${f} preserved`);
});

test('dry run plans changes without writing', () => {
  const dir = fixtureRepo('npm-astro');
  const inspection = inspectRepository(dir, { exec: fakeExec(), useGh: false });
  const plan = planInstall(inspection, { trustedUsers: ['alice'] });
  assert.ok(plan.files.every((f) => f.action === 'create'));
  assert.equal(existsSync(path.join(dir, '.github')), false);
});

test('CLI --dry-run writes nothing and reports the plan', async () => {
  const dir = fixtureRepo('npm-astro');
  const stdout = capture();
  const code = await main(['install', dir, '--dry-run', '--offline', '--trusted-user', 'alice'], { stdout, stderr: capture(), exec: fakeExec() });
  assert.equal(code, 0);
  assert.match(stdout.text, /Plan \(dry run — nothing written\)/);
  assert.match(stdout.text, /create\s+\.github\/workflows\/agent-review\.yml/);
  assert.match(stdout.text, /validation\s+npm run build/);
  assert.equal(existsSync(path.join(dir, '.github')), false);
});

test('existing unmanaged wrappers and repository files are preserved; --force replaces wrappers only', () => {
  const dir = fixtureRepo('existing-workflows');
  const legacy = read(dir, '.github/workflows/agent-implement.yml');
  const customValidate = read(dir, '.github/agent/validate.sh');

  const plan = install(dir, { trustedUsers: ['alice'] });
  const a = actions(plan);
  assert.equal(a['.github/workflows/agent-implement.yml'], 'conflict');
  assert.equal(a['.github/workflows/agent-review.yml'], 'create');
  assert.equal(a['.github/agent/validate.sh'], 'keep');
  assert.equal(read(dir, '.github/workflows/agent-implement.yml'), legacy);
  assert.equal(read(dir, '.github/agent/validate.sh'), customValidate);
  assert.ok(plan.notes.some((n) => n.includes('agent-remediate.yml')));
  assert.ok(plan.notes.some((n) => n.includes('package.json script "test" not used')));
  assert.ok(plan.notes.some((n) => n.includes('runs in watch mode')));

  const forced = install(dir, { trustedUsers: ['alice'], force: true });
  assert.equal(actions(forced)['.github/workflows/agent-implement.yml'], 'overwrite');
  assert.equal(parseWrapper(read(dir, '.github/workflows/agent-implement.yml')).managed, true);
  assert.equal(read(dir, '.github/agent/validate.sh'), customValidate, '--force never touches repository-owned files');
  assert.equal(read(dir, '.github/workflows/ci.yml'), 'name: CI\non: [push]\njobs: {}\n');
  assert.ok(readdirSync(path.join(dir, '.github/workflows')).includes('agent-remediate.yml'), 'legacy files are reported, not deleted');
});

test('locally edited managed wrappers are left alone unless forced', () => {
  const dir = fixtureRepo('npm-astro');
  install(dir, { trustedUsers: ['alice'] });
  const file = path.join(dir, '.github/workflows/agent-review.yml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('name: Agent - Review', 'name: My Review'));
  assert.equal(actions(install(dir))['.github/workflows/agent-review.yml'], 'conflict');
  assert.match(readFileSync(file, 'utf8'), /My Review/);
  assert.equal(actions(install(dir, { force: true }))['.github/workflows/agent-review.yml'], 'overwrite');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /My Review/);
});

test('the pinned ref is preserved on rerun and changed only with --ref', () => {
  const dir = fixtureRepo('npm-astro');
  install(dir, { trustedUsers: ['alice'], ref: 'v1.0.0' });
  assert.equal(parseWrapper(read(dir, '.github/workflows/agent-implement.yml')).ref, 'v1.0.0');
  assert.equal(actions(install(dir))['.github/workflows/agent-implement.yml'], 'unchanged');
  const upgrade = install(dir, { ref: 'v1.1.0' });
  const f = upgrade.files.find((x) => x.path === '.github/workflows/agent-implement.yml');
  assert.equal(f.action, 'update');
  assert.equal(f.reason, 'ref v1.0.0 → v1.1.0');
  assert.equal(parseWrapper(read(dir, '.github/workflows/agent-implement.yml')).ref, 'v1.1.0');
});

test('a moving branch ref is flagged', () => {
  const dir = fixtureRepo('npm-astro');
  const plan = install(dir, { trustedUsers: ['alice'], ref: 'main' });
  assert.ok(plan.notes.some((n) => n.includes('moving branch')));
});

test('trusted users: personal owner inferred, organizations must be explicit', () => {
  const personal = fixtureRepo('minimal', { remote: 'git@github.com:alice/site.git' });
  const userExec = fakeExec({ 'api repos/alice/site': { code: 0, stdout: '{"default_branch":"main","owner_type":"User"}' } });
  const plan = planInstall(inspectRepository(personal, { exec: userExec }), {});
  assert.deepEqual(plan.values.trustedUsers, ['alice']);

  const org = fixtureRepo('minimal', { remote: 'git@github.com:acme/site.git' });
  const orgExec = fakeExec({ 'api repos/acme/site': { code: 0, stdout: '{"default_branch":"main","owner_type":"Organization"}' } });
  assert.throws(() => planInstall(inspectRepository(org, { exec: orgExec }), {}), /owned by an organization; pass --trusted-user/);
  assert.deepEqual(planInstall(inspectRepository(org, { exec: orgExec }), { trustedUsers: ['bob'] }).values.trustedUsers, ['bob']);
});

test('unknown owner type leaves trusted_users to the documented runtime default', () => {
  const dir = fixtureRepo('minimal');
  const plan = install(dir);
  assert.equal(plan.values.trustedUsers, null);
  assert.ok(plan.notes.some((n) => n.includes('trusted_users left to the runtime default')));
  assert.equal(loadConfig(read(dir, '.github/agent/config.yml')).config.trusted_users, null);
});

test('CLI reports conflicts with a non-zero exit code and refuses non-git directories', async () => {
  const dir = fixtureRepo('existing-workflows');
  const stderr = capture();
  assert.equal(await main(['install', dir, '--offline', '--trusted-user', 'alice'], { stdout: capture(), stderr, exec: fakeExec() }), 1);
  assert.match(stderr.text, /left untouched because of conflicts/);

  const plain = fixtureRepo('minimal', { git: false });
  const err2 = capture();
  assert.equal(await main(['install', plain, '--offline'], { stdout: capture(), stderr: err2, exec: fakeExec() }), 1);
  assert.match(err2.text, /not a git repository/);
});

test('CLI argument handling', async () => {
  const out = capture();
  assert.equal(await main(['--version'], { stdout: out, stderr: capture() }), 0);
  assert.match(out.text, /^\d+\.\d+\.\d+/);
  const err = capture();
  assert.equal(await main(['install', '--bogus'], { stdout: capture(), stderr: err }), 2);
  assert.match(err.text, /unknown option --bogus/);
  assert.equal(await main(['frobnicate'], { stdout: capture(), stderr: capture() }), 2);
  assert.equal(await main(['install', '--ref'], { stdout: capture(), stderr: capture() }), 2);
  const help = capture();
  assert.equal(await main([], { stdout: help, stderr: capture() }), 0);
  assert.match(help.text, /Usage:/);
});
