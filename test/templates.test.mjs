import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../lib/config.mjs';
import {
  NO_VALIDATION_MARKER,
  WRAPPERS,
  parseWrapper,
  renderConfig,
  renderSetupScript,
  renderValidateScript,
  renderWrapper,
} from '../lib/templates.mjs';

test('wrappers reference the pinned reusable workflow and carry a managed header', () => {
  for (const w of WRAPPERS) {
    const text = renderWrapper(w.template, { ref: 'v1' });
    assert.match(text.split('\n')[0], new RegExp(`^# agent-workflows: managed template=${w.template} checksum=sha256:[0-9a-f]{16}$`));
    assert.match(text, new RegExp(`uses: quest4ikigai/agent-workflows/\\.github/workflows/${w.reusable.replace('.', '\\.')}@v1\\n`));
    assert.doesNotMatch(text, /__AW_/);
    const parsed = parseWrapper(text);
    assert.deepEqual(parsed, { managed: true, template: w.template, modified: false, workflowsRepo: 'quest4ikigai/agent-workflows', ref: 'v1' });
  }
});

test('wrappers declare explicit secrets and a permission ceiling, and no repository policy', () => {
  for (const w of WRAPPERS) {
    const text = renderWrapper(w.template, { ref: 'v1' });
    assert.match(text, /^permissions: \{\}$/m);
    for (const perm of ['contents: read', 'issues: write', 'pull-requests: write', 'actions: read', 'id-token: write']) {
      assert.ok(text.includes(`      ${perm}`), `${w.template}: ${perm}`);
    }
    for (const secret of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'AGENT_GITHUB_TOKEN']) {
      assert.ok(text.includes(`${secret}: \${{ secrets.${secret} }}`), `${w.template}: ${secret}`);
    }
    assert.doesNotMatch(text, /secrets: inherit/);
    for (const forbidden of ['agent-main', 'yarn', 'npm ', 'Mealie', 'timo-reymann', 'sonnet', 'opus']) {
      assert.ok(!text.includes(forbidden), `${w.template} mentions ${forbidden}`);
    }
    assert.ok(text.split('\n').length < 60, `${w.template} should stay small`);
  }
});

test('wrapper pre-filters match the fixed trigger conventions', () => {
  const implement = renderWrapper('agent-implement', { ref: 'v1' });
  assert.match(implement, /types: \[opened, labeled\]/);
  assert.match(implement, /startsWith\(github\.event\.issue\.title, '\[agent-build\]'\)/);
  assert.match(implement, /github\.event\.label\.name == 'agent-build'/);
  const review = renderWrapper('agent-review', { ref: 'v1' });
  assert.match(review, /github\.event\.label\.name == 'agent-review'/);
  assert.match(review, /startsWith\(github\.event\.review\.user\.login, 'chatgpt-codex-connector'\)/);
  assert.match(review, /startsWith\(github\.event\.comment\.body, '\/agent-review'\)/);
  const fix = renderWrapper('agent-human-fix', { ref: 'v1' });
  assert.match(fix, /startsWith\(github\.event\.comment\.body, '\/agent-fix'\)/);
  assert.match(fix, /github\.event\.issue\.pull_request != null/);
});

test('custom ref and workflows repository; local mode for linting', () => {
  const text = renderWrapper('agent-review', { ref: 'v1.2.3', workflowsRepo: 'fork/agent-workflows' });
  assert.match(text, /uses: fork\/agent-workflows\/\.github\/workflows\/review\.yml@v1\.2\.3/);
  assert.equal(parseWrapper(text).ref, 'v1.2.3');
  assert.match(renderWrapper('agent-review', { ref: 'v1', uses: 'local' }), /uses: \.\/\.github\/workflows\/review\.yml\n/);
  assert.throws(() => renderWrapper('agent-review', { ref: 'v1; rm -rf /' }), /invalid ref/);
  assert.throws(() => renderWrapper('agent-review', { ref: 'v1', workflowsRepo: 'not a repo' }), /invalid workflows repository/);
  assert.throws(() => renderWrapper('nope', { ref: 'v1' }), /unknown wrapper/);
});

test('detects local edits and unmanaged files', () => {
  const text = renderWrapper('agent-implement', { ref: 'v1' });
  assert.equal(parseWrapper(text.replace('timeout', 'timeout')).modified, false);
  assert.equal(parseWrapper(text.replace('name: Agent - Implement', 'name: Mine')).modified, true);
  assert.equal(parseWrapper(text.replace(/\n/g, '\r\n')).modified, false, 'line endings do not count as edits');
  assert.deepEqual(parseWrapper('name: legacy\non: push\n'), { managed: false });
});

test('rendered config parses and validates, with comments explaining each section', () => {
  const text = renderConfig({
    baseBranch: 'main',
    trustedUsers: ['alice'],
    nodeVersion: '22',
    pythonVersion: '3.12',
    setupScript: '.github/agent/setup.sh',
    validationScript: '.github/agent/validate.sh',
    context: ['CLAUDE.md', 'AGENTS.md'],
  });
  const { config, warnings } = loadConfig(text);
  assert.deepEqual(warnings, []);
  assert.equal(config.base_branch, 'main');
  assert.deepEqual(config.trusted_users, ['alice']);
  assert.equal(config.setup.node_version, '22');
  assert.equal(config.setup.python_version, '3.12');
  assert.equal(config.implementation.model, 'sonnet');
  assert.equal(config.escalation.model, 'opus');
  assert.match(text, /^# agent-workflows configuration/);
});

test('rendered config with unknown values falls back to runtime defaults', () => {
  const text = renderConfig({ baseBranch: null, trustedUsers: null, setupScript: null, validationScript: null, context: [] });
  const { config } = loadConfig(text);
  assert.equal(config.base_branch, null);
  assert.equal(config.trusted_users, null);
  assert.equal(config.setup.script, null);
  assert.equal(config.validation.script, null);
  assert.deepEqual(config.context, []);
  assert.match(text, /# base_branch: \(defaults to the repository default branch\)/);
});

test('scripts are strict bash and mark missing validation explicitly', () => {
  const setup = renderSetupScript(['npm ci']);
  assert.match(setup, /^#!\/usr\/bin\/env bash\n/);
  assert.match(setup, /set -euo pipefail\n\nnpm ci\n$/);
  const validate = renderValidateScript(['npm run lint', 'npm run build']);
  assert.match(validate, /set -euo pipefail\n\nnpm run lint\nnpm run build\n$/);
  assert.ok(!validate.includes(NO_VALIDATION_MARKER));
  const empty = renderValidateScript([], ['go test ./...']);
  assert.ok(empty.includes(NO_VALIDATION_MARKER));
  assert.match(empty, /#   go test \.\/\.\.\./);
  assert.match(empty, /::warning::No validation commands/);
});
