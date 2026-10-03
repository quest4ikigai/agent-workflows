import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { inspectRepository } from '../lib/inspect.mjs';
import { applyPlan, planInstall } from '../lib/install.mjs';
import { runCheck, formatCheck } from '../lib/check.mjs';
import { main } from '../lib/cli.mjs';
import { cleanupTemp, fakeExec, fixtureRepo } from './helpers.mjs';

after(cleanupTemp);

function installed(fixture = 'npm-astro', opts = {}) {
  const dir = fixtureRepo(fixture, opts);
  applyPlan(dir, planInstall(inspectRepository(dir, { exec: fakeExec(), useGh: false }), { trustedUsers: ['alice'] }));
  return dir;
}

const items = (result) => result.sections.flatMap((s) => s.items);
const find = (result, re) => items(result).filter((i) => re.test(i.message));

function check(dir, ghResponses, options = {}) {
  const exec = fakeExec(ghResponses, options);
  const useGh = ghResponses !== undefined;
  return runCheck(inspectRepository(dir, { exec, useGh }), { exec, useGh });
}

test('a fresh installation passes the offline check', () => {
  const result = check(installed());
  assert.equal(result.errors, 0, formatCheck(result));
  assert.equal(find(result, /agent-implement\.yml → quest4ikigai\/agent-workflows@v1/)[0].status, 'ok');
  assert.equal(find(result, /config\.yml valid/)[0].status, 'ok');
  assert.equal(find(result, /validation script \.github\/agent\/validate\.sh/)[0].status, 'ok');
  assert.equal(find(result, /trusted users: alice/)[0].status, 'ok');
  assert.ok(find(result, /Claude GitHub App/)[0].status === 'manual');
  assert.ok(find(result, /Codex code review is enabled/)[0].status === 'manual');
});

test('an uninstalled repository fails with actionable messages', () => {
  const result = check(fixtureRepo('npm-astro'));
  assert.ok(result.errors >= 4);
  assert.equal(find(result, /agent-review\.yml missing/)[0].hint, 'run: agent-workflows install .');
  assert.equal(find(result, /config\.yml missing/)[0].status, 'error');
});

test('detects malformed configuration', () => {
  const dir = installed();
  writeFileSync(path.join(dir, '.github/agent/config.yml'), 'version: 1\nremediaton:\n  max_passes: 2\nimplementation:\n  max_turns: zero\n');
  const result = check(dir);
  assert.equal(result.errors, 2);
  assert.ok(find(result, /did you mean "remediation"/).length);
  assert.ok(find(result, /implementation\.max_turns must be an integer/).length);
});

test('detects missing and empty validation scripts', () => {
  const dir = installed();
  rmSync(path.join(dir, '.github/agent/validate.sh'));
  let result = check(dir);
  assert.equal(find(result, /validation script .* not found/)[0].status, 'error');

  const minimal = installed('minimal');
  result = check(minimal);
  assert.equal(find(result, /has no commands yet/)[0].status, 'warn');
  assert.equal(result.errors, 0);
});

test('reports non-executable scripts as informational only', () => {
  const dir = installed();
  chmodSync(path.join(dir, '.github/agent/validate.sh'), 0o644);
  const result = check(dir);
  assert.equal(find(result, /is not executable/)[0].status, 'info');
  assert.equal(result.errors, 0);
});

test('detects edited, outdated and legacy workflow files', () => {
  const dir = installed('existing-workflows');
  const result = check(dir);
  assert.equal(find(result, /agent-implement\.yml is not managed/)[0].status, 'error');
  assert.equal(find(result, /legacy file \.github\/workflows\/agent-remediate\.yml/)[0].status, 'warn');

  const edited = installed();
  const file = path.join(edited, '.github/workflows/agent-review.yml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('Agent - Review', 'Edited'));
  assert.equal(find(check(edited), /agent-review\.yml was edited locally/)[0].status, 'warn');
});

test('GitHub checks read secret names, labels, branch state through gh', () => {
  const dir = installed();
  const wrapper = (p) => Buffer.from(readFileSync(path.join(dir, p), 'utf8')).toString('base64');
  const responses = {
    'api repos/acme/widget': { code: 0, stdout: '{"default_branch":"main","owner_type":"User"}' },
    'api repos/acme/widget/actions/secrets?per_page=100': { code: 0, stdout: 'CLAUDE_CODE_OAUTH_TOKEN\n' },
    'api repos/acme/widget/actions/organization-secrets?per_page=100': { code: 1, stdout: '' },
    'api repos/acme/widget/labels?per_page=100': { code: 0, stdout: 'bug\nagent-review\n' },
    'api repos/acme/widget/actions/permissions': { code: 0, stdout: '{"enabled":true,"allowed_actions":"all"}' },
    'api repos/acme/widget/contents/.github/workflows/agent-implement.yml?ref=main': { code: 0, stdout: wrapper('.github/workflows/agent-implement.yml') },
    'api repos/acme/widget/contents/.github/workflows/agent-review.yml?ref=main': { code: 0, stdout: wrapper('.github/workflows/agent-review.yml') },
    'api repos/acme/widget/contents/.github/workflows/agent-human-fix.yml?ref=main': { code: 1, stdout: '' },
    'api repos/acme/widget/branches/main': { code: 0, stdout: 'false\n' },
  };
  const result = check(dir, responses);
  assert.equal(find(result, /secret CLAUDE_CODE_OAUTH_TOKEN configured/)[0].status, 'ok');
  const pat = find(result, /secret AGENT_GITHUB_TOKEN not configured/)[0];
  assert.equal(pat.status, 'error');
  assert.match(pat.hint, /gh secret set AGENT_GITHUB_TOKEN/);
  assert.equal(find(result, /label agent-review exists/)[0].status, 'ok');
  assert.match(find(result, /label agent-build missing/)[0].hint, /gh label create agent-build/);
  assert.equal(find(result, /1 wrapper\(s\) not yet on main/)[0].status, 'warn');
  assert.equal(find(result, /base branch main is not protected/)[0].status, 'warn');
  assert.equal(result.errors, 1);
});

test('ANTHROPIC_API_KEY satisfies the Claude credential requirement', () => {
  const dir = installed();
  const result = check(dir, {
    'api repos/acme/widget/actions/secrets?per_page=100': { code: 0, stdout: 'ANTHROPIC_API_KEY\nAGENT_GITHUB_TOKEN\n' },
  });
  assert.equal(find(result, /ANTHROPIC_API_KEY configured/)[0].status, 'ok');
  assert.equal(find(result, /AGENT_GITHUB_TOKEN configured/)[0].status, 'ok');
});

test('GitHub checks degrade to warnings without gh', () => {
  assert.equal(find(check(installed(), {}, { ghInstalled: false }), /gh CLI not installed/)[0].status, 'warn');
  assert.equal(find(check(installed(), {}, { ghAuthenticated: false }), /not authenticated/)[0].status, 'warn');
});

test('CLI check exits non-zero when problems exist', async () => {
  const out = { text: '', write(s) { this.text += s; } };
  assert.equal(await main(['check', fixtureRepo('npm-astro'), '--offline'], { stdout: out, stderr: out, exec: fakeExec() }), 1);
  assert.match(out.text, /problem\(s\) must be fixed/);
  const ok = { text: '', write(s) { this.text += s; } };
  assert.equal(await main(['check', installed(), '--offline'], { stdout: ok, stderr: ok, exec: fakeExec() }), 0);
  assert.match(ok.text, /✓ \.github\/agent\/config\.yml valid/);
});
