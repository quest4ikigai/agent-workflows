import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  SCHEMAS,
  auditPrompt,
  claudeArgs,
  existingContextDocs,
  finalFixPrompt,
  humanFixPrompt,
  implementPrompt,
  remediatePrompt,
} from '../lib/runtime/prompts.mjs';
import { parseResult, validationStatus } from '../lib/runtime/results.mjs';
import { cleanupTemp, defaultConfig, tempDir } from './helpers.mjs';

after(cleanupTemp);

const config = defaultConfig('base_branch: agent-main\n', { defaultBranch: 'main', owner: 'owner', ownerType: 'User' });

test('claude args carry model, turns, tools and the JSON schema', () => {
  const args = claudeArgs('implement', config).split('\n');
  assert.deepEqual(args.slice(0, 3), ['--model sonnet', '--max-turns 40', '--allowedTools Edit,Read,Write,Bash']);
  const schema = JSON.parse(args[3].match(/^--json-schema '(.*)'$/)[1]);
  assert.deepEqual(schema.properties.status.enum, ['implemented', 'blocked', 'no_change']);
  for (const kind of Object.keys(SCHEMAS)) assert.ok(!JSON.stringify(SCHEMAS[kind]).includes("'"), `${kind} schema is shell-safe`);
});

test('model selection follows configuration', () => {
  const custom = defaultConfig('implementation:\n  model: opus\nremediation:\n  model: haiku\nescalation:\n  model: claude-opus-5-5\n');
  assert.match(claudeArgs('implement', custom), /--model opus/);
  assert.match(claudeArgs('remediate', custom), /--model haiku/);
  assert.match(claudeArgs('audit', custom), /--model claude-opus-5-5/);
  assert.match(claudeArgs('final-fix', custom), /--model claude-opus-5-5\n--max-turns 45/);
  assert.match(claudeArgs('human-fix', custom), /--model sonnet\n--max-turns 30/);
});

test('the audit session is read-only', () => {
  const args = claudeArgs('audit', config);
  assert.match(args, /--allowedTools Read,Bash/);
  assert.match(args, /--disallowedTools Edit,Write,MultiEdit,NotebookEdit/);
  assert.match(auditPrompt({ config, pr: 3, headRef: 'x', docs: [] }), /REVIEW ONLY/);
});

test('only existing context documents are listed', () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'CLAUDE.md'), '#');
  assert.deepEqual(existingContextDocs(dir, ['CLAUDE.md', 'AGENTS.md', 'ARCHITECTURE.md']), ['CLAUDE.md']);
});

const issue = { number: 12, title: '[agent-build] Add export', body: 'Contract text\n```\ncode\n```' };
const branch = 'claude/issue-12-add-export';

test('implement prompt: contract, docs, validation, branch rules', () => {
  const p = implementPrompt({ config, issue, branch, docs: ['CLAUDE.md', 'AGENTS.md'], scriptExists: true });
  assert.match(p, /issue #12/);
  assert.match(p, /````\nContract text\n```\ncode\n```\n````/, 'contract fenced safely even when it contains fences');
  assert.match(p, /- CLAUDE\.md\n- AGENTS\.md/);
  assert.match(p, /bash \.github\/agent\/validate\.sh/);
  assert.match(p, /You are on `claude\/issue-12-add-export`, created from `agent-main`/);
  assert.match(p, /push them with `git push origin claude\/issue-12-add-export`/);
  assert.match(p, /- Only push to `claude\/issue-12-add-export`\./);
  assert.match(p, /never push to `agent-main` or `main`/);
  assert.match(p, /Do not request reviews or mention @codex/);
});

test('prompts degrade gracefully without docs or validation', () => {
  const noValidation = defaultConfig('validation:\n  script: null\n');
  const p = implementPrompt({ config: noValidation, issue, branch, docs: [], scriptExists: false });
  assert.match(p, /No project context documents were found/);
  assert.match(p, /does not configure a validation script/);
  const missing = implementPrompt({ config, issue, branch, docs: [], scriptExists: false });
  assert.match(missing, /does not exist in this checkout\. Stop and return blocked/);
});

test('remediation, human-fix and final-fix prompts pin the PR branch', () => {
  const common = { config, pr: 9, headRef: 'feature/x', docs: ['AGENTS.md'], scriptExists: true };
  const r = remediatePrompt({ ...common, reviewBody: 'Codex says X' });
  assert.match(r, /Codex says X/);
  assert.match(r, /only to the existing pull request branch `feature\/x`/);
  const h = humanFixPrompt({ ...common, actor: 'owner', feedback: 'Rename foo' });
  assert.match(h, /@owner deliberately invoked \/agent-fix/);
  assert.match(h, /Rename foo/);
  assert.match(humanFixPrompt({ ...common, actor: 'owner', feedback: '' }), /No feedback text followed the command/);
  const f = finalFixPrompt({ ...common, findings: '[{"severity":"P1"}]', auditSummary: 'one' });
  assert.match(f, /terminal automated stage/);
  assert.match(f, /"severity":"P1"/);
});

test('prompts contain no repository-specific assumptions', () => {
  const generic = defaultConfig();
  const common = { config: generic, pr: 1, headRef: 'b', docs: [], scriptExists: true };
  const all = [
    implementPrompt({ config: generic, issue, branch, docs: [], scriptExists: true }),
    remediatePrompt({ ...common, reviewBody: '' }),
    humanFixPrompt({ ...common, actor: 'a', feedback: 'x' }),
    auditPrompt(common),
    finalFixPrompt({ ...common, findings: '[]', auditSummary: '' }),
  ].join('\n');
  for (const word of ['agent-main', 'yarn', 'npm', 'Mealie', 'timo-reymann', 'gen:docs', 'src/tools', 'ARCHITECTURE.md', 'WORKFLOWS.md', 'API_COVERAGE.md', 'Astro', 'quest4ikigai']) {
    assert.ok(!all.includes(word), `prompt mentions ${word}`);
  }
});

test('structured result parsing validates status values', () => {
  assert.deepEqual(parseResult('remediate', '{"status":"fixed","summary":"s","validation":"v"}'), { ok: true, status: 'fixed', summary: 's', validation: 'v', findings: [] });
  assert.equal(parseResult('remediate', '{"status":"implemented"}').ok, false);
  assert.match(parseResult('audit', 'not json').error, /not valid JSON/);
  assert.match(parseResult('audit', '').error, /no structured result/);
  assert.equal(parseResult('audit', '{"status":"findings","summary":"s","findings":[{"severity":"P2"}]}').findings.length, 1);
  assert.throws(() => parseResult('nope', '{}'), /unknown session kind/);
});

test('validation status mapping', () => {
  assert.equal(validationStatus('success', ''), 'passed');
  assert.equal(validationStatus('success', 'skipped'), 'not-configured');
  assert.equal(validationStatus('failure', ''), 'failed');
  assert.equal(validationStatus('skipped', ''), 'not-run');
  assert.equal(validationStatus(undefined, undefined), 'not-run');
});
