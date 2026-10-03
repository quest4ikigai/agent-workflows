import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, loadConfig, resolveRuntimeConfig, isValidBranch, isValidPath } from '../lib/config.mjs';

test('an empty config gets every default', () => {
  const { config, warnings } = loadConfig('version: 1\n');
  assert.deepEqual(warnings, []);
  assert.equal(config.base_branch, null);
  assert.equal(config.branch_prefix, 'claude/');
  assert.equal(config.trusted_users, null);
  assert.deepEqual(config.implementation, { model: 'sonnet', max_turns: 40, timeout_minutes: 75 });
  assert.deepEqual(config.remediation, { model: 'sonnet', max_turns: 30, max_passes: 3, timeout_minutes: 90 });
  assert.deepEqual(config.escalation, { enabled: true, model: 'opus', audit_max_turns: 40, fix_max_turns: 45 });
  assert.deepEqual(config.human_fix, { model: 'sonnet', max_turns: 30, timeout_minutes: 75 });
  assert.deepEqual(config.codex, { wait_minutes: 15 });
  assert.deepEqual(config.setup, { node_version: null, python_version: null, script: '.github/agent/setup.sh' });
  assert.deepEqual(config.validation, { script: '.github/agent/validate.sh' });
  assert.deepEqual(config.context, ['CLAUDE.md', 'AGENTS.md']);
  assert.deepEqual(config.pull_request, { footer: null });
});

test('a full config round-trips', () => {
  const { config } = loadConfig(`
version: 1
base_branch: agent-main
branch_prefix: agent/
trusted_users: [alice, bob]
implementation:
  model: opus
  max_turns: 60
remediation:
  model: claude-sonnet-5-5
  max_passes: 0
escalation:
  enabled: false
codex:
  wait_minutes: 0
setup:
  node_version: 22
  python_version: "3.12"
  script: null
validation:
  script: scripts/check.sh
context: []
pull_request:
  footer: .github/agent/pr-footer.md
`);
  assert.equal(config.base_branch, 'agent-main');
  assert.equal(config.branch_prefix, 'agent/');
  assert.deepEqual(config.trusted_users, ['alice', 'bob']);
  assert.equal(config.implementation.model, 'opus');
  assert.equal(config.remediation.model, 'claude-sonnet-5-5');
  assert.equal(config.remediation.max_passes, 0);
  assert.equal(config.escalation.enabled, false);
  assert.equal(config.setup.node_version, '22');
  assert.equal(config.setup.python_version, '3.12');
  assert.equal(config.setup.script, null);
  assert.equal(config.validation.script, 'scripts/check.sh');
  assert.deepEqual(config.context, []);
  assert.equal(config.pull_request.footer, '.github/agent/pr-footer.md');
});

test('empty strings disable optional scripts', () => {
  const { config } = loadConfig('setup:\n  script: ""\nvalidation:\n  script: ""\n');
  assert.equal(config.setup.script, null);
  assert.equal(config.validation.script, null);
});

function errorsOf(text) {
  try {
    loadConfig(text);
  } catch (err) {
    assert.ok(err instanceof ConfigError, err.message);
    return err.errors;
  }
  assert.fail('expected ConfigError');
}

test('reports every problem at once', () => {
  const errors = errorsOf(`
version: 2
implementaton:
  model: sonnet
remediation:
  max_passes: 99
  model: "sonnet --dangerously-skip-permissions"
escalation:
  enabled: "yes"
trusted_users: [ok-user, "bad user"]
validation:
  script: ../outside.sh
base_branch: "-main"
`);
  const text = errors.join('\n');
  assert.match(text, /version must be an integer between 1 and 1/);
  assert.match(text, /unknown setting "implementaton" \(did you mean "implementation"\?\)/);
  assert.match(text, /remediation.max_passes must be an integer between 0 and 10/);
  assert.match(text, /remediation.model must be a model name/);
  assert.match(text, /escalation.enabled must be true or false/);
  assert.match(text, /trusted_users contains an invalid GitHub username: "bad user"/);
  assert.match(text, /validation.script must be a repository-relative path/);
  assert.match(text, /base_branch must be a valid branch name/);
});

test('nested unknown keys get suggestions too', () => {
  assert.match(errorsOf('codex:\n  wait_minute: 5\n').join(), /unknown setting "codex.wait_minute" \(did you mean "codex.wait_minutes"\?\)/);
});

test('malformed YAML becomes a ConfigError', () => {
  assert.match(errorsOf('a: [1, 2\n').join(), /config.yml: line 1: unterminated flow list/);
  assert.match(errorsOf('- a\n- b\n').join(), /must be a mapping/);
  assert.match(errorsOf('implementation: 3\n').join(), /implementation must be a mapping/);
});

test('warns about risky but valid combinations', () => {
  const { warnings } = loadConfig(
    'codex:\n  wait_minutes: 60\nremediation:\n  max_passes: 0\n  timeout_minutes: 60\nhuman_fix:\n  timeout_minutes: 60\nescalation:\n  enabled: false\ntrusted_users: []\n',
  );
  const text = warnings.join('\n');
  assert.match(text, /remediation.timeout_minutes/);
  assert.match(text, /human_fix.timeout_minutes/);
  assert.match(text, /never be remediated/);
  assert.match(text, /nobody can trigger/);
});

test('resolveRuntimeConfig fills base branch and personal-repo owner', () => {
  const { config } = loadConfig('version: 1\n');
  const resolved = resolveRuntimeConfig(config, { defaultBranch: 'trunk', owner: 'alice', ownerType: 'User' });
  assert.equal(resolved.base_branch, 'trunk');
  assert.deepEqual(resolved.trusted_users, ['alice']);
  assert.equal(config.base_branch, null, 'input is not mutated');
});

test('resolveRuntimeConfig requires explicit trusted users for organizations', () => {
  const { config } = loadConfig('version: 1\n');
  assert.throws(() => resolveRuntimeConfig(config, { defaultBranch: 'main', owner: 'acme', ownerType: 'Organization' }), /organization-owned/);
  const explicit = loadConfig('trusted_users: [alice]\n').config;
  assert.deepEqual(resolveRuntimeConfig(explicit, { defaultBranch: 'main', owner: 'acme', ownerType: 'Organization' }).trusted_users, ['alice']);
});

test('branch and path validators', () => {
  for (const ok of ['main', 'agent-main', 'release/1.x', 'a.b']) assert.ok(isValidBranch(ok), ok);
  for (const bad of ['', '-x', 'a..b', 'a/', '/a', 'a b', 'x.lock', 'a//b', 'a/.b']) assert.ok(!isValidBranch(bad), bad);
  for (const ok of ['CLAUDE.md', 'docs/ARCHITECTURE.md', '.github/agent/validate.sh']) assert.ok(isValidPath(ok), ok);
  for (const bad of ['../x', '/etc/passwd', 'a/../b', 'a b.md', './x', 'a//b', '..', '.']) assert.ok(!isValidPath(bad), bad);
});
