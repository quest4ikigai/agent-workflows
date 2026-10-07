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
import { CODEX, cleanResult, codexSummary, evaluateExpression, user } from './helpers.mjs';

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
  assert.match(review, /^  issue_comment:\n    types: \[created, edited\]$/m, 'Codex edits its review summary');
  assert.match(review, /^  pull_request:\n    types: \[labeled, synchronize\]$/m, 'a push withdraws readiness');
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

/** The wrapper job's `if:` expression (inline or folded `>-`), as GitHub sees it. */
function wrapperCondition(template) {
  const lines = renderWrapper(template, { ref: 'v1' }).split('\n');
  const at = lines.findIndex((l) => /^ {4}if: /.test(l));
  const inline = lines[at].replace(/^ {4}if: /, '');
  if (inline !== '>-') return inline;
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^ {6}/.test(line)) break;
    body.push(line.trim());
  }
  return body.join(' ');
}

test('review wrapper starts a run for commands, Codex reviews and Codex completion signals only', () => {
  const condition = wrapperCondition('agent-review');
  const comment = (action, body, who, pr = true) => ({
    event_name: 'issue_comment',
    event: { action, issue: { number: 17, pull_request: pr ? { url: 'x' } : null }, comment: { body, user: who } },
  });
  const cases = [
    // [description, github context, runs]
    ['/agent-review', comment('created', '/agent-review', user('owner')), true],
    ['/agent-review edited', comment('edited', '/agent-review please', user('owner')), false],
    ['Codex summary edited', comment('edited', codexSummary(), user(CODEX)), true],
    ['Codex summary created', comment('created', codexSummary({ code: '⏳ **In progress**' }), user(CODEX)), true],
    ['Codex clean result', comment('created', cleanResult(), user(CODEX)), true],
    ['Codex clean result edited', comment('edited', cleanResult(), user(CODEX)), true],
    ['other Codex comment', comment('created', 'Codex is reviewing.', user(CODEX)), false],
    ['human pasting the summary', comment('edited', codexSummary(), user('owner')), false],
    ['human pasting the clean result', comment('created', cleanResult(), user('owner')), false],
    ['look-alike human login', comment('created', cleanResult(), { login: 'chatgpt-codex-connector-fan', type: 'User' }), false],
    ['other bot with the text', comment('created', cleanResult(), user('dependabot[bot]')), false],
    ['ordinary comment', comment('created', 'Looks good to me', user('owner')), false],
    ['Codex summary on an issue', comment('edited', codexSummary(), user(CODEX), false), false],
    ['Codex review', { event_name: 'pull_request_review', event: { review: { user: user(CODEX) } } }, true],
    ['human review', { event_name: 'pull_request_review', event: { review: { user: user('owner') } } }, false],
    ['look-alike human review', { event_name: 'pull_request_review', event: { review: { user: { login: 'chatgpt-codex-connector-x', type: 'User' } } } }, false],
    ['agent-review label', { event_name: 'pull_request', event: { action: 'labeled', label: { name: 'agent-review' } } }, true],
    ['other label', { event_name: 'pull_request', event: { action: 'labeled', label: { name: 'bug' } } }, false],
    ['push to an opted-in PR', { event_name: 'pull_request', event: { action: 'synchronize', pull_request: { labels: [{ name: 'bug' }, { name: 'agent-review' }] } } }, true],
    ['push to another PR', { event_name: 'pull_request', event: { action: 'synchronize', pull_request: { labels: [{ name: 'bug' }] } } }, false],
    ['push to a PR without labels', { event_name: 'pull_request', event: { action: 'synchronize', pull_request: { labels: [] } } }, false],
    ['other pull_request action on an opted-in PR', { event_name: 'pull_request', event: { action: 'edited', pull_request: { labels: [{ name: 'agent-review' }] } } }, false],
  ];
  for (const [what, github, runs] of cases) assert.equal(evaluateExpression(condition, { github }), runs, what);
});

test('human-fix wrapper still reacts only to new /agent-fix comments on pull requests', () => {
  const condition = wrapperCondition('agent-human-fix');
  const github = (body, pr = true) => ({ event_name: 'issue_comment', event: { action: 'created', issue: { pull_request: pr ? {} : null }, comment: { body, user: user('owner') } } });
  assert.equal(evaluateExpression(condition, { github: github('/agent-fix rename foo') }), true);
  assert.equal(evaluateExpression(condition, { github: github('/agent-fix rename foo', false) }), false);
  assert.equal(evaluateExpression(condition, { github: github(cleanResult()) }), false);
  assert.match(renderWrapper('agent-human-fix', { ref: 'v1' }), /^  issue_comment:\n    types: \[created\]$/m);
});
