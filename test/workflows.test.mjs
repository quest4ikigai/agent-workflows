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

/** Steps of one job with their name, id, condition and action parsed out. */
function jobSteps(job) {
  return steps(job).map(({ text }) => ({
    text,
    name: (text.match(/^ {6}- name: (.+)$/m) || [])[1],
    id: (text.match(/^ {8}id: (.+)$/m) || [])[1],
    if: (text.match(/^ {8}if: (.+)$/m) || [])[1],
    uses: (text.match(/^ {8}uses: (.+)$/m) || [])[1] || '',
  }));
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
    ['review.yml', 'agent-pr', 'needs.gate.outputs.pr_number'],
    ['review.yml', 'agent-pr', 'needs.gate.outputs.pr_number'],
    ['human-fix.yml', 'agent-pr', 'needs.gate.outputs.pr_number'],
  ]);
  for (const f of REUSABLE) assert.doesNotMatch(read(f), /cancel-in-progress: true/);
});

test('persisted checkout credentials are removed before every Claude session', () => {
  const covered = [];
  for (const f of REUSABLE) {
    for (const job of jobs(read(f))) {
      const all = jobSteps(job);
      const claude = all.filter((s) => s.uses.startsWith('anthropics/claude-code-action'));
      if (!claude.length) continue;
      const where = `${f}/${job.match(/^  ([a-z_-]+):/)[1]}`;
      const at = (step) => all.indexOf(step);
      const checkouts = all.filter((s) => s.uses.startsWith('actions/checkout'));
      const cleanups = all.filter((s) => /node "\$AW" remove-checkout-credentials\n/.test(s.text));
      assert.equal(checkouts.length, 1, `${where}: one checkout`);
      assert.equal(cleanups.length, 1, `${where}: one cleanup step`);
      const [checkout, cleanup] = [checkouts[0], cleanups[0]];
      const setup = all.find((s) => s.name === 'Run setup script');
      assert.ok(at(cleanup) > at(checkout), `${where}: cleanup runs after checkout persisted the credential`);
      assert.ok(at(cleanup) > at(setup), `${where}: cleanup runs after setup.sh, which may still need the credential`);
      assert.equal(cleanup.if, checkout.if, `${where}: cleanup runs whenever the repository is checked out`);
      assert.doesNotMatch(cleanup.text, /continue-on-error|always\(\)/, `${where}: a failed cleanup stops the job`);
      for (const step of claude) {
        assert.ok(at(step) > at(cleanup), `${where}/${step.id}: Claude starts only after the cleanup`);
        assert.doesNotMatch(step.if, /always\(\)|failure\(\)|cancelled\(\)/, `${where}/${step.id}: skipped when the cleanup fails`);
        assert.doesNotMatch(step.text, /continue-on-error/, `${where}/${step.id}`);
        covered.push(`${f}:${step.id}`);
      }
      for (const later of all.slice(at(cleanup) + 1)) {
        assert.ok(!later.uses.startsWith('actions/checkout'), `${where}: nothing checks out again after the cleanup`);
        assert.doesNotMatch(later.text, /extraheader|persist-credentials|credential\.helper|git config/, `${where}/${later.name}: nothing re-adds a git credential`);
      }
    }
  }
  // Path A, normal remediation, the read-only audit, the Opus escalation fix, /agent-fix.
  assert.deepEqual(covered, ['implement.yml:claude', 'review.yml:claude', 'review.yml:audit', 'review.yml:final_fix', 'human-fix.yml:claude']);
});

test('every Claude session runs in agent mode, which installs its own credential before any git fetch', () => {
  for (const f of REUSABLE) {
    for (const s of steps(read(f)).filter((x) => x.text.includes('anthropics/claude-code-action'))) {
      assert.match(s.text, /\n {10}prompt: \$\{\{ steps\.[a-z_]+\.outputs\.prompt \}\}\n/, `${f}: an explicit prompt selects agent mode`);
      assert.doesNotMatch(s.text, /track_progress|branch_prefix|branch_name_template|trigger_phrase|label_trigger|assignee_trigger/, `${f}: no tag-mode inputs`);
    }
  }
  // Path A therefore creates its branch itself, and later steps use that branch.
  const implement = jobSteps(jobs(read('implement.yml')).find((j) => j.startsWith('  implement:')));
  const create = implement.find((s) => s.name === 'Create work branch');
  const claude = implement.find((s) => s.id === 'claude');
  assert.ok(implement.indexOf(create) > implement.findIndex((s) => s.uses.startsWith('actions/checkout')));
  assert.ok(implement.indexOf(create) < implement.indexOf(claude));
  assert.match(create.text, /WORK_BRANCH: \$\{\{ steps\.preflight\.outputs\.branch \}\}\n {8}run: git switch --create "\$WORK_BRANCH"\n/);
  for (const name of ['Render prompt', 'Finish implementation']) {
    assert.match(implement.find((s) => s.name === name).text, /WORK_BRANCH: \$\{\{ steps\.preflight\.outputs\.branch \}\}/, name);
  }
  assert.doesNotMatch(read('implement.yml'), /outputs\.branch_name/, 'the branch never comes from Claude');
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
  'prompt implement': ['AW_CONFIG', 'WORK_BRANCH'],
  'prompt remediate': ['AW_CONFIG', 'PR_NUMBER', 'HEAD_REF', 'CODEX_FINDINGS'],
  'prompt audit': ['AW_CONFIG', 'PR_NUMBER', 'HEAD_REF'],
  'prompt final-fix': ['AW_CONFIG', 'PR_NUMBER', 'HEAD_REF', 'AUDIT_FINDINGS', 'AUDIT_SUMMARY'],
  'prompt human-fix': ['AW_CONFIG', 'PR_NUMBER', 'HEAD_REF', 'CODEX_FINDINGS'],
  result: ['RAW_RESULT'],
  'preflight-implement': ['GITHUB_TOKEN', 'AW_CONFIG', 'ISSUE_NUMBER'],
  'finish-implement': ['GITHUB_TOKEN', PAT, 'AW_CONFIG', 'ISSUE_NUMBER', 'PREFLIGHT', 'SETUP_OUTCOME', 'WORK_BRANCH', ...CLAUDE, ...VALIDATION],
  'review-cycle': ['GITHUB_TOKEN', PAT, 'AW_CONFIG', 'PR_NUMBER', 'ORIGIN'],
  'start-review': ['GITHUB_TOKEN', PAT, 'AW_CONFIG', 'PR_NUMBER', 'ACTOR', 'VIA'],
  'plan-remediation': ['GITHUB_TOKEN', PAT, 'AW_CONFIG', 'PR_NUMBER'],
  'record-codex-completion': ['GITHUB_TOKEN', 'AW_CONFIG', 'PR_NUMBER'],
  'record-head-change': ['GITHUB_TOKEN', 'AW_CONFIG', 'PR_NUMBER'],
  'finish-remediation': ['GITHUB_TOKEN', 'AW_CONFIG', 'PR_NUMBER', 'PASSES', 'COUNTABLE', 'HEAD_SHA', 'CODEX_FINDINGS', ...CLAUDE, ...VALIDATION],
  'finish-audit': ['GITHUB_TOKEN', 'AW_CONFIG', 'PR_NUMBER', 'HEAD_SHA', ...CLAUDE],
  'finish-final-fix': ['GITHUB_TOKEN', 'AW_CONFIG', 'PR_NUMBER', 'HEAD_SHA', 'AUDIT_SUMMARY', ...CLAUDE, ...VALIDATION],
  'prepare-human-fix': ['GITHUB_TOKEN', 'AW_CONFIG', 'PR_NUMBER', 'ACTOR'],
  'finish-human-fix': ['GITHUB_TOKEN', 'AW_CONFIG', 'PR_NUMBER', 'HEAD_SHA', 'PROCEED', 'SETUP_OUTCOME', ...CLAUDE, ...VALIDATION],
  'remove-checkout-credentials': [],
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
  assert.equal(checked, 29);
});

test('write sessions are verified against the head recorded before Claude ran, and only a verified fix requests review', () => {
  const stepsOf = (f, name) => jobSteps(jobs(read(f)).find((j) => j.startsWith(`  ${name}:`)));
  const env = (step, name) => (step.text.match(new RegExp(`\\n {10}${name}: (.+)\\n`)) || [])[1];
  const cases = [
    // [workflow, job, step recording the head, finish step, Claude step, review step]
    ['review.yml', 'remediate', 'plan', 'Finish remediation', 'claude', 'Request Codex re-review and wait'],
    ['review.yml', 'remediate', 'plan', 'Finish consolidated fix', 'final_fix', null],
    ['human-fix.yml', 'fix', 'prepare', 'Finish', 'claude', 'Request Codex review and wait'],
  ];
  for (const [f, job, recorder, finishName, claudeId, reviewName] of cases) {
    const all = stepsOf(f, job);
    const finish = all.find((s) => s.name === finishName);
    const where = `${f}/${finishName}`;
    assert.equal(env(finish, 'HEAD_SHA'), `\${{ steps.${recorder}.outputs.head_sha }}`, where);
    assert.ok(all.findIndex((s) => s.id === recorder) < all.findIndex((s) => s.id === claudeId), `${where}: head recorded before Claude runs`);
    assert.ok(all.indexOf(finish) > all.findIndex((s) => s.id === claudeId), where);
    if (reviewName) {
      const review = all.find((s) => s.name === reviewName);
      assert.equal(review.if, `steps.${finish.id}.outputs.request_review == 'true'`, `${f}: review only after the finish step verified the fix`);
    }
  }
  // The final fix ends automation; nothing after it requests a review.
  const remediate = stepsOf('review.yml', 'remediate');
  const afterFix = remediate.slice(remediate.findIndex((s) => s.id === 'final_fix'));
  assert.ok(!afterFix.some((s) => /node "\$AW" review-cycle/.test(s.text)));
});

test('remediation and /agent-fix prompts receive the Codex findings collected inside the PR lock', () => {
  const cases = [
    ['review.yml', 'remediate', 'prompt remediate', 'plan'],
    ['human-fix.yml', 'fix', 'prompt human-fix', 'prepare'],
  ];
  for (const [f, job, command, collector] of cases) {
    const all = jobSteps(jobs(read(f)).find((j) => j.startsWith(`  ${job}:`)));
    const prompt = all.find((s) => s.text.includes(`node "$AW" ${command}\n`));
    assert.match(prompt.text, new RegExp(`\\n {10}CODEX_FINDINGS: \\$\\{\\{ steps\\.${collector}\\.outputs\\.codex_findings \\}\\}\\n`), f);
  }
});

test('Codex completion signals are recorded by a small locked job without Claude, PAT or write access to code', () => {
  const job = jobs(read('review.yml')).find((j) => j.startsWith('  complete:'));
  assert.ok(job, 'review.yml has a complete job');
  assert.match(job, /\n    needs: gate\n    if: needs\.gate\.outputs\.action == 'complete'\n/);
  assert.match(job, /\n    concurrency:\n      group: agent-pr-\$\{\{ needs\.gate\.outputs\.pr_number \}\}\n      cancel-in-progress: false\n/);
  assert.match(job, /\n    permissions:\n      contents: read\n      issues: write\n      pull-requests: write\n    steps:/);
  assert.doesNotMatch(job, /anthropics\/claude-code-action|actions\/checkout|secrets\.|id-token|AGENT_GITHUB_TOKEN/);
  const all = jobSteps(job);
  assert.deepEqual(all.map((s) => s.name), ['Fetch agent-workflows tooling', 'Record Codex completion']);
  assert.match(all[1].text, /node "\$AW" record-codex-completion\n/);
});

// Runtime commands that create or edit comments on pull requests (the review
// status comment, explanations, Codex requests). GitHub refuses those edits
// with 403 unless the job's GITHUB_TOKEN has pull-requests: write; issues:
// write alone is not enough, and the fake GitHub in these tests cannot tell.
const WRITES_PR_COMMENTS = [
  'gate review',
  'gate human-fix',
  'finish-implement',
  'review-cycle',
  'start-review',
  'plan-remediation',
  'record-codex-completion',
  'record-head-change',
  'finish-remediation',
  'finish-audit',
  'finish-final-fix',
  'prepare-human-fix',
  'finish-human-fix',
];

test('every job that writes pull request comments can: issues and pull-requests write', () => {
  const seen = new Set();
  for (const f of REUSABLE) {
    for (const job of jobs(read(f))) {
      const name = job.match(/^  ([a-z_-]+):/)[1];
      const perms = (job.match(/\n    permissions:\n((?: {6}.+\n)+)/) || [])[1] || '';
      for (const m of job.matchAll(/node "\$AW" ([a-z-]+)(?: ([a-z-]+))?\n/g)) {
        const key = m[2] && WRITES_PR_COMMENTS.includes(`${m[1]} ${m[2]}`) ? `${m[1]} ${m[2]}` : m[1];
        if (!WRITES_PR_COMMENTS.includes(key)) continue;
        seen.add(key);
        assert.match(perms, /^ {6}pull-requests: write$/m, `${f}/${name}: ${key} edits PR comments`);
        assert.match(perms, /^ {6}issues: write$/m, `${f}/${name}: ${key}`);
      }
    }
  }
  assert.deepEqual([...seen].sort(), [...WRITES_PR_COMMENTS].sort(), 'every listed command is used by a workflow');
});
