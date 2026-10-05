import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  SCHEMAS,
  auditPrompt,
  claudeArgs,
  codexFindingsBlock,
  existingContextDocs,
  finalFixPrompt,
  humanFixPrompt,
  implementPrompt,
  remediatePrompt,
} from '../lib/runtime/prompts.mjs';
import { parseResult, validationStatus } from '../lib/runtime/results.mjs';
import { DRIFT_FINDING, cleanupTemp, defaultConfig, tempDir } from './helpers.mjs';

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
  assert.match(p, /Return status "implemented" only when your changes are committed and pushed/);
  assert.match(p, /opens a pull request only when `claude\/issue-12-add-export` has\ncommits ahead of `agent-main` on GitHub, and rejects "no_change" if you pushed\nany/);
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

const drift = {
  thread: 'PRRT_drift',
  path: 'scripts/brand/sync.mjs',
  line: 22,
  startLine: 20,
  severity: 'P2',
  title: 'Check generated public derivatives for drift',
  latest: true,
  replies: 1,
  body: DRIFT_FINDING,
};
const ico = { thread: 'PRRT_ico', path: 'test/brand.test.mjs', line: 5, startLine: null, severity: 'P1', title: 'Cover the ICO sizes', latest: false, replies: 0, body: 'No test checks the ICO.\n````\nfence\n````' };
const fileLevel = { thread: 'PRRT_file', path: 'README.md', line: null, startLine: null, severity: null, title: '', latest: null, replies: 2, body: 'Whole-file note.' };

test('remediation prompt lists the current unresolved Codex findings even when the review body is empty', () => {
  const common = { config, pr: 9, headRef: 'feature/x', docs: [], scriptExists: true };
  const p = remediatePrompt({ ...common, reviewBody: '', codexFindings: { findings: [drift, ico, fileLevel], outdated: 2, omitted: 1 } });
  assert.match(p, /LATEST REVIEW BODY:\n````\n\(empty\)\n````/);
  assert.match(p, /CURRENT UNRESOLVED CODEX FINDINGS\n\nAn empty latest review body does not imply there are no findings\. The unresolved finding\nlist below is authoritative for the current remediation pass\./);
  assert.match(p, /1\. scripts\/brand\/sync\.mjs:20-22\n   P2: Check generated public derivatives for drift\n   \(thread PRRT_drift, from the latest review, 1 reply by others not shown\)\n````\n/);
  assert.ok(p.includes(DRIFT_FINDING), 'full comment text');
  assert.match(p, /2\. test\/brand\.test\.mjs:5\n   P1: Cover the ICO sizes\n   \(thread PRRT_ico, from an earlier review\)\n`````\nNo test checks the ICO\.\n````\nfence\n````\n`````/, 'fences cannot be closed early');
  assert.match(p, /3\. README\.md\n   \(untitled finding\)\n   \(thread PRRT_file, 2 replies by others not shown\)/);
  assert.match(p, /2 unresolved Codex thread\(s\) are outdated .* and are not listed\./);
  assert.match(p, /1 more finding\(s\) are not shown because of prompt size limits/);
  assert.ok(p.indexOf('CURRENT UNRESOLVED CODEX FINDINGS') > p.indexOf('LATEST REVIEW BODY'));
});

test('findings block: none, and not collected', () => {
  const none = codexFindingsBlock({ findings: [], outdated: 3, omitted: 0 }, 'Authoritative.');
  assert.match(none, /None: the pull request has no unresolved, non-outdated Codex review threads\.\n3 unresolved Codex thread\(s\) are outdated/);
  const missing = codexFindingsBlock(null, 'Authoritative.');
  assert.match(missing, /could not collect the review threads for this run\. Read every unresolved\nCodex review thread on the pull request yourself; an empty review body does not imply\nthere are no findings\./);
  assert.doesNotMatch(missing, /Authoritative/);
});

test('write prompts define fixed, blocked and no_change so they are hard to misread', () => {
  const common = { config, pr: 9, headRef: 'feature/x', docs: [], scriptExists: true, codexFindings: { findings: [drift] } };
  const prompts = {
    remediate: remediatePrompt({ ...common, reviewBody: 'r' }),
    'human-fix': humanFixPrompt({ ...common, actor: 'owner', feedback: 'Rename foo' }),
    'final-fix': finalFixPrompt({ ...common, findings: '[]', auditSummary: 's' }),
  };
  const flat = (p) => p.replace(/\s+/g, ' ');
  for (const [kind, p] of Object.entries(prompts)) {
    const text = flat(p);
    assert.ok(text.includes('Status rules (the workflow compares the pull request head on GitHub before and after this session'), kind);
    assert.ok(text.includes('- Return "fixed" only if you changed the repository, committed the change, pushed it to `feature/x`'), kind);
    assert.ok(text.includes('If you did not push a commit, you MUST NOT return "fixed".'), kind);
    assert.ok(text.includes('If your reasoning concludes that a human decision is needed, return "blocked", even if you made no changes'), kind);
    assert.ok(text.includes('- Return "no_change" only when'), kind);
    assert.ok(text.includes('do not push commits'), kind);
  }
  assert.ok(flat(prompts.remediate).includes('already resolved, outdated, duplicate, invalid, or non-actionable'));
  assert.ok(flat(prompts.remediate).includes('Never use "no_change" for a valid finding that needs a human decision; that is "blocked".'));
  assert.ok(flat(prompts['human-fix']).includes('A Codex review is requested only after a verified push.'));
  assert.ok(flat(prompts['final-fix']).includes('Be conservative: when unsure, return "blocked".'));
});

test('/agent-fix sees the Codex findings as its task without feedback, and as context with it', () => {
  const common = { config, pr: 9, headRef: 'feature/x', actor: 'owner', docs: [], scriptExists: true, codexFindings: { findings: [drift] } };
  const bare = humanFixPrompt({ ...common, feedback: '' });
  assert.match(bare, /No feedback text followed the command\. Address the unresolved review threads on this PR,\nstarting with the current unresolved Codex findings listed below\./);
  assert.match(bare, /these findings are the work for this fix/);
  assert.match(bare, /1\. scripts\/brand\/sync\.mjs:20-22/);
  const guided = humanFixPrompt({ ...common, feedback: 'Only rename foo' });
  assert.match(guided, /The feedback above is the task\. These findings are context: address them only where the\nfeedback asks you to\./);
  assert.ok(guided.indexOf('HUMAN FEEDBACK') < guided.indexOf('CURRENT UNRESOLVED CODEX FINDINGS'));
  assert.match(humanFixPrompt({ ...common, feedback: '', codexFindings: null }), /could not collect the review threads/);
});
