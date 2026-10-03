// Static checks over the reusable workflow YAML. actionlint (in CI) validates
// syntax and expressions; these tests pin the security and wiring invariants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WRAPPERS, renderWrapper } from '../lib/templates.mjs';
import { COMMANDS } from '../lib/runtime/main.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REUSABLE = ['implement.yml', 'review.yml', 'human-fix.yml'];
const read = (f) => readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8');

/** Split a workflow into step blocks: [{ job, text }]. */
function steps(text) {
  const out = [];
  let job = null;
  let current = null;
  for (const line of text.split('\n')) {
    const jobMatch = line.match(/^  ([a-z_-]+):$/);
    if (jobMatch) job = jobMatch[1];
    if (/^      - /.test(line)) {
      current = { job, text: line };
      out.push(current);
    } else if (current && (/^ {8}/.test(line) || line === '')) {
      current.text += `\n${line}`;
    } else {
      current = null;
    }
  }
  return out;
}

function jobs(text) {
  const body = text.split(/^jobs:$/m)[1];
  return body.split(/^(?=  [a-z_-]+:$)/m).filter((b) => b.trim());
}

test('reusable workflows are workflow_call only, with explicit optional secrets', () => {
  for (const f of REUSABLE) {
    const text = read(f);
    assert.match(text, /^on:\n  workflow_call:\n    secrets:\n/m, f);
    assert.doesNotMatch(text, /^  (push|pull_request|issues|issue_comment|pull_request_review|workflow_dispatch):/m, `${f} declares no triggers of its own`);
    for (const s of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'AGENT_GITHUB_TOKEN']) {
      assert.match(text, new RegExp(`      ${s}:\\n        description: .+\\n        required: false`), `${f}: ${s}`);
    }
    assert.match(text, /^permissions: \{\}$/m, `${f}: no default token permissions`);
  }
});

test('every job declares its own minimal permissions', () => {
  for (const f of REUSABLE) {
    for (const job of jobs(read(f))) {
      const name = job.match(/^  ([a-z_-]+):/)[1];
      assert.match(job, /\n    permissions:\n/, `${f}/${name}`);
      const usesClaude = job.includes('anthropics/claude-code-action');
      assert.equal(job.includes('id-token: write'), usesClaude, `${f}/${name}: id-token only where Claude runs`);
      assert.doesNotMatch(job, /contents: write/, `${f}/${name}: GITHUB_TOKEN never needs to push`);
    }
  }
});

test('the PAT never reaches Claude sessions or job-wide environments', () => {
  for (const f of REUSABLE) {
    const text = read(f);
    for (const job of jobs(text)) {
      const jobEnv = job.match(/\n    env:\n((?: {6}.+\n)+)/);
      if (jobEnv) assert.doesNotMatch(jobEnv[1], /secrets\.|github\.token/, `${f}: job-level env must not hold credentials`);
    }
    for (const step of steps(text).filter((s) => s.text.includes('anthropics/claude-code-action'))) {
      assert.doesNotMatch(step.text, /AGENT_GITHUB_TOKEN/, `${f}: Claude step must not see the PAT`);
      assert.doesNotMatch(step.text, /github_token:/, `${f}: Claude uses its own GitHub App token`);
    }
  }
});

test('tooling is fetched identically, at the exact workflow commit, in every job', () => {
  const blocks = [];
  for (const f of REUSABLE) {
    const all = steps(read(f));
    const fetches = all.filter((s) => s.text.includes('name: Fetch agent-workflows tooling'));
    assert.equal(fetches.length, jobs(read(f)).length, `${f}: one fetch per job`);
    blocks.push(...fetches.map((s) => s.text.trimEnd()));
  }
  const selftest = steps(read('selftest.yml')).find((s) => s.text.includes('name: Fetch agent-workflows tooling'));
  blocks.push(selftest.text.trimEnd());
  assert.ok(blocks.every((b) => b === blocks[0]), 'all fetch steps (including the CI self-test) are identical');
  assert.match(blocks[0], /WORKFLOW_REPOSITORY: \$\{\{ job\.workflow_repository \}\}/);
  assert.match(blocks[0], /WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(blocks[0], /fetch -q --depth 1 "\$GITHUB_SERVER_URL\/\$WORKFLOW_REPOSITORY" "\$WORKFLOW_SHA"/);
});

test('every runtime command used by the workflows exists and is dispatched', () => {
  const main = readFileSync(path.join(ROOT, 'lib/runtime/main.mjs'), 'utf8');
  const dispatched = new Set([...main.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));
  for (const command of Object.keys(COMMANDS)) assert.ok(dispatched.has(command), `run() handles ${command}`);
  let count = 0;
  for (const f of REUSABLE) {
    for (const m of read(f).matchAll(/node "\$AW" ([a-z-]+)(?: ([a-z-]+))?\n/g)) {
      count++;
      assert.ok(m[1] in COMMANDS, `${f}: unknown command ${m[1]}`);
      const kinds = COMMANDS[m[1]];
      if (kinds) assert.ok(kinds.includes(m[2]), `${f}: ${m[1]} does not accept kind ${m[2]}`);
      else assert.equal(m[2], undefined, `${f}: ${m[1]} takes no kind`);
    }
  }
  assert.ok(count >= 20, `found ${count} runtime invocations`);
});

test('PR-mutating jobs share one lock per PR; implementation locks per issue', () => {
  const groups = REUSABLE.flatMap((f) => [...read(f).matchAll(/group: (agent-[a-z]+)-\$\{\{ ([^}]+) \}\}/g)].map((m) => [f, m[1], m[2].trim()]));
  assert.deepEqual(groups, [
    ['implement.yml', 'agent-implement', 'needs.gate.outputs.issue_number'],
    ['implement.yml', 'agent-pr', 'needs.implement.outputs.pr_number'],
    ['review.yml', 'agent-pr', 'needs.gate.outputs.pr_number'],
    ['review.yml', 'agent-pr', 'needs.gate.outputs.pr_number'],
    ['human-fix.yml', 'agent-pr', 'needs.gate.outputs.pr_number'],
  ]);
  for (const f of REUSABLE) assert.doesNotMatch(read(f), /cancel-in-progress: true/);
});

test('sessions triggered by Codex reviews allow only the Codex bot', () => {
  const review = steps(read('review.yml')).filter((s) => s.text.includes('anthropics/claude-code-action'));
  assert.equal(review.length, 3);
  for (const s of review) assert.match(s.text, /allowed_bots: "chatgpt-codex-connector,chatgpt-codex-connector\[bot\]"/);
  for (const f of ['implement.yml', 'human-fix.yml']) {
    for (const s of steps(read(f)).filter((x) => x.text.includes('anthropics/claude-code-action'))) {
      assert.doesNotMatch(s.text, /allowed_bots/, `${f}: human-triggered sessions do not admit bots`);
    }
  }
});

test('reusable workflows contain no repository-specific assumptions and never merge', () => {
  const forbidden = ['agent-main', 'yarn', 'npm ', 'pnpm', 'Mealie', 'timo-reymann', 'gen:docs', 'src/tools', 'ARCHITECTURE.md', 'WORKFLOWS.md', 'API_COVERAGE.md', 'Astro', 'quest4ikigai', 'corepack'];
  for (const f of REUSABLE) {
    const text = read(f);
    for (const word of forbidden) assert.ok(!text.includes(word), `${f} mentions ${word}`);
    assert.doesNotMatch(text, /gh pr merge|\/merge\b|pulls\/[^ ]*\/merge|--admin|event: APPROVE/, `${f} must never merge or approve`);
  }
  const runtime = readdirSync(path.join(ROOT, 'lib/runtime')).map((f) => readFileSync(path.join(ROOT, 'lib/runtime', f), 'utf8')).join('\n');
  assert.doesNotMatch(runtime, /\/merge['"`]|APPROVE/, 'runtime never merges or approves');
});

test('wrappers call exactly the reusable workflows that exist, with matching secrets', () => {
  for (const w of WRAPPERS) {
    const text = renderWrapper(w.template, { ref: 'v1' });
    assert.ok(REUSABLE.includes(w.reusable));
    const called = read(w.reusable);
    for (const s of [...text.matchAll(/^      ([A-Z_]+): \$\{\{ secrets\.\1 \}\}$/gm)].map((m) => m[1])) {
      assert.match(called, new RegExp(`\\n      ${s}:\\n`), `${w.reusable} accepts ${s}`);
    }
  }
});

// Inputs each runtime command reads (see run() in lib/runtime/main.mjs).
const CLAUDE = ['CLAUDE_OUTCOME', 'CLAUDE_CONCLUSION', 'RAW_RESULT'];
const VALIDATION = ['VALIDATION_OUTCOME', 'VALIDATION_RESULT'];
const PAT = 'AGENT_GITHUB_TOKEN';
const REQUIRED_ENV = {
  gate: ['GITHUB_TOKEN'],
  'prompt implement': ['AW_CONFIG'],
  'prompt remediate': ['AW_CONFIG', 'PR_NUMBER', 'HEAD_REF'],
  'prompt audit': ['AW_CONFIG', 'PR_NUMBER', 'HEAD_REF'],
  'prompt final-fix': ['AW_CONFIG', 'PR_NUMBER', 'HEAD_REF', 'AUDIT_FINDINGS', 'AUDIT_SUMMARY'],
  'prompt human-fix': ['AW_CONFIG', 'PR_NUMBER', 'HEAD_REF'],
  result: ['RAW_RESULT'],
  'preflight-implement': ['GITHUB_TOKEN', 'AW_CONFIG', 'ISSUE_NUMBER'],
  'finish-implement': ['GITHUB_TOKEN', PAT, 'AW_CONFIG', 'ISSUE_NUMBER', 'PREFLIGHT', 'SETUP_OUTCOME', 'CLAUDE_BRANCH', ...CLAUDE, ...VALIDATION],
  'review-cycle': ['GITHUB_TOKEN', PAT, 'AW_CONFIG', 'PR_NUMBER', 'ORIGIN'],
  'start-review': ['GITHUB_TOKEN', PAT, 'AW_CONFIG', 'PR_NUMBER', 'ACTOR', 'VIA'],
  'plan-remediation': ['GITHUB_TOKEN', PAT, 'AW_CONFIG', 'PR_NUMBER'],
  'finish-remediation': ['GITHUB_TOKEN', 'AW_CONFIG', 'PR_NUMBER', 'PASSES', 'COUNTABLE', 'HEAD_SHA', ...CLAUDE, ...VALIDATION],
  'finish-audit': ['GITHUB_TOKEN', 'AW_CONFIG', 'PR_NUMBER', 'HEAD_SHA', ...CLAUDE],
  'finish-final-fix': ['GITHUB_TOKEN', 'AW_CONFIG', 'PR_NUMBER', 'AUDIT_SUMMARY', ...CLAUDE, ...VALIDATION],
  'prepare-human-fix': ['GITHUB_TOKEN', 'AW_CONFIG', 'PR_NUMBER', 'ACTOR'],
  'finish-human-fix': ['GITHUB_TOKEN', 'AW_CONFIG', 'PR_NUMBER', 'PROCEED', 'SETUP_OUTCOME', ...CLAUDE, ...VALIDATION],
};

test('every runtime step receives exactly the inputs its command reads', () => {
  const envNames = (block) => [...(block || '').matchAll(/^ +([A-Z_]+): /gm)].map((m) => m[1]);
  let checked = 0;
  for (const f of REUSABLE) {
    const text = read(f);
    for (const job of jobs(text)) {
      const jobEnv = envNames((job.match(/\n    env:\n((?: {6}.+\n)+)/) || [])[1]);
      for (const step of steps(job)) {
        const m = step.text.match(/node "\$AW" ([a-z-]+)(?: ([a-z-]+))?\n/);
        if (!m) continue;
        const key = REQUIRED_ENV[`${m[1]} ${m[2]}`] ? `${m[1]} ${m[2]}` : m[1];
        const required = REQUIRED_ENV[key];
        assert.ok(required, `${f}: no expectation for ${key}`);
        const stepEnv = envNames((step.text.match(/\n {8}env:\n((?: {10}.+\n)+)/) || [])[1]);
        const available = new Set([...jobEnv, ...stepEnv]);
        for (const name of required) assert.ok(available.has(name), `${f}: "${key}" step is missing ${name}`);
        if (!required.includes(PAT)) assert.ok(!stepEnv.includes(PAT), `${f}: "${key}" step should not receive the PAT`);
        checked++;
      }
    }
  }
  assert.equal(checked, 24);
});
