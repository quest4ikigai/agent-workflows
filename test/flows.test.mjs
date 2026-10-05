import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as flows from '../lib/runtime/flows.mjs';
import { parseState, renderState } from '../lib/runtime/state.mjs';
import { requestBody } from '../lib/runtime/codex.mjs';
import { BOT, CODEX, FakeGitHub, cleanupTemp, defaultConfig, fakeContext } from './helpers.mjs';

after(cleanupTemp);

const ok = (status, extra = {}) => JSON.stringify({ status, summary: `summary for ${status}`, validation: 'ran validate.sh: passed', ...extra });
const claudeOk = { claudeOutcome: 'success', claudeConclusion: 'success' };

function stateOf(gh, pr) {
  const comments = gh.stateComments(pr);
  assert.equal(comments.length, 1, 'exactly one state comment');
  assert.equal(comments[0].user.login, BOT);
  return { ...parseState(comments[0].body), body: comments[0].body };
}

// Path A ------------------------------------------------------------------------------------

function implementWorld() {
  const gh = new FakeGitHub();
  gh.addIssue({ number: 5, title: '[agent-build] Add widget export', body: 'contract' });
  gh.branches['claude/issue-5-add-widget-export'] = { protected: false };
  gh.compare['main...claude/issue-5-add-widget-export'] = { ahead_by: 3 };
  const ctx = fakeContext(gh, { event: { issue: gh.issues[5] } });
  return { gh, ctx };
}

const implementInputs = (extra = {}) => ({
  ...claudeOk,
  issueNumber: 5,
  issueTitle: '[agent-build] Add widget export',
  preflight: 'true',
  setupOutcome: 'success',
  branch: 'claude/issue-5-add-widget-export',
  rawResult: ok('implemented'),
  validationOutcome: 'success',
  validationResult: '',
  ...extra,
});

test('Path A: opens the PR with the PAT, labels it as the automation, initializes state', async () => {
  const { gh, ctx } = implementWorld();
  assert.equal(await flows.finishImplement(ctx, implementInputs()), 0);
  const pr = Object.values(gh.pulls)[0];
  assert.equal(pr.title, 'Add widget export');
  assert.equal(pr.user.login, 'owner', 'opened with AGENT_GITHUB_TOKEN so CI runs');
  assert.equal(pr.base.ref, 'main');
  assert.match(pr.body, /^Implements #5/);
  assert.match(pr.body, /Repository validation \(`\.github\/agent\/validate\.sh`\):\*\* ✅ passed/);
  assert.match(pr.body, /must not be merged automatically/);
  assert.deepEqual(gh.events[pr.number].map((e) => [e.label.name, e.actor.login]), [['agent-review', BOT]]);
  assert.ok(gh.labels.has('agent-review'), 'label created when missing');
  const state = stateOf(gh, pr.number);
  assert.deepEqual([state.passes, state.final], [0, 'not_started']);
  assert.match(state.body, /Initial implementation complete; requesting Codex review/);
  assert.equal(ctx.outputs.values.pr_number, String(pr.number));
  assert.equal(ctx.outputs.values.request_review, 'true');
});

test('Path A: includes the configured PR footer', async () => {
  const { gh, ctx } = implementWorld();
  ctx.config = defaultConfig('pull_request:\n  footer: .github/agent/pr-footer.md\n');
  mkdirSync(path.join(ctx.workspace, '.github/agent'), { recursive: true });
  writeFileSync(path.join(ctx.workspace, '.github/agent/pr-footer.md'), '## AI-assisted contribution\n\n- [ ] I understand the changes.\n');
  await flows.finishImplement(ctx, implementInputs());
  assert.match(Object.values(gh.pulls)[0].body, /## AI-assisted contribution\n\n- \[ \] I understand the changes\./);
});

test('Path A: reuses an existing open PR and its status comment', async () => {
  const { gh, ctx } = implementWorld();
  gh.addPull({ number: 77, head: { ref: 'claude/issue-5-add-widget-export' } });
  gh.addComment(77, renderState({ passes: 2, final: 'blocked', maxPasses: 3, stage: 'old' }), BOT);
  await flows.finishImplement(ctx, implementInputs());
  assert.equal(Object.keys(gh.pulls).length, 1);
  assert.equal(ctx.outputs.values.pr_number, '77');
  const state = stateOf(gh, 77);
  assert.deepEqual([state.passes, state.final], [0, 'not_started']);
});

test('Path A: blocked and no_change results are reported on the issue without a PR', async () => {
  for (const status of ['blocked', 'no_change']) {
    const { gh, ctx } = implementWorld();
    assert.equal(await flows.finishImplement(ctx, implementInputs({ rawResult: ok(status) })), 0);
    assert.equal(Object.keys(gh.pulls).length, 0);
    assert.match(gh.issueComments(5).at(-1).body, new RegExp(`stopped with status \`${status}\``));
    assert.equal(ctx.outputs.values.request_review, 'false');
  }
});

test('Path A: failures are reported on the issue and fail the job', async () => {
  const cases = [
    [{ setupOutcome: 'failure' }, /environment setup failed/],
    [{ claudeOutcome: 'failure', claudeConclusion: 'failure' }, /Claude step failed/],
    [{ claudeConclusion: '' }, /without running Claude/],
    [{ rawResult: '' }, /no structured result/],
    [{ rawResult: '{"status":"done"}' }, /unexpected status/],
    [{ branch: 'main' }, /not a claude\/ feature branch/],
    [{ branch: '' }, /not a claude\/ feature branch/],
    [{ branch: 'claude/issue-5-unpushed' }, /could not be compared/],
  ];
  for (const [extra, pattern] of cases) {
    const { gh, ctx } = implementWorld();
    assert.equal(await flows.finishImplement(ctx, implementInputs(extra)), 1, JSON.stringify(extra));
    assert.match(gh.issueComments(5).at(-1).body, pattern, JSON.stringify(extra));
    assert.match(gh.issueComments(5).at(-1).body, /Workflow run: https:/);
    assert.equal(Object.keys(gh.pulls).length, 0);
  }
});

test('Path A: refuses to open a PR when nothing was pushed', async () => {
  const { gh, ctx } = implementWorld();
  gh.compare['main...claude/issue-5-add-widget-export'] = { ahead_by: 0 };
  assert.equal(await flows.finishImplement(ctx, implementInputs()), 1);
  assert.match(gh.issueComments(5).at(-1).body, /pushed no commits/);
});

test('Path A: validation failure opens the PR but does not request review', async () => {
  const { gh, ctx } = implementWorld();
  assert.equal(await flows.finishImplement(ctx, implementInputs({ validationOutcome: 'failure' })), 1);
  const pr = Object.values(gh.pulls)[0];
  assert.match(pr.body, /❌ failed/);
  assert.match(stateOf(gh, pr.number).body, /validation failed; Codex review was not requested/);
  assert.equal(ctx.outputs.values.request_review, 'false');
});

test('Path A: no validation script configured is stated, not hidden', async () => {
  const { gh, ctx } = implementWorld();
  await flows.finishImplement(ctx, implementInputs({ validationResult: 'skipped' }));
  assert.match(Object.values(gh.pulls)[0].body, /no validation script configured/);
});

test('Path A: preflight refuses when an agent PR for the issue is already open', async () => {
  const { gh, ctx } = implementWorld();
  gh.addPull({ number: 40, head: { ref: 'claude/issue-5-20261001-1200' } });
  gh.addPull({ number: 41, head: { ref: 'claude/issue-55-other' } });
  await flows.preflightImplement(ctx, { issueNumber: 5 });
  assert.equal(ctx.outputs.values.proceed, 'false');
  assert.match(gh.issueComments(5).at(-1).body, /#40 is already open/);

  const other = implementWorld();
  other.gh.addPull({ number: 41, head: { ref: 'claude/issue-55-other' } });
  await flows.preflightImplement(other.ctx, { issueNumber: 5 });
  assert.equal(other.ctx.outputs.values.proceed, 'true', 'issue 55 is not issue 5');
});

test('Path A: preflight picks a fresh work branch for the workflow to create', async () => {
  const gh = new FakeGitHub();
  gh.addIssue({ number: 5, title: '[agent-build] Add widget export to the CSV page', body: 'contract' });
  const ctx = fakeContext(gh, { event: { issue: gh.issues[5] } });
  ctx.env.GITHUB_RUN_ID = '987';
  await flows.preflightImplement(ctx, { issueNumber: 5 });
  assert.equal(ctx.outputs.values.proceed, 'true');
  assert.equal(ctx.outputs.values.branch, 'claude/issue-5-add-widget-export-to-the');

  gh.branches['claude/issue-5-add-widget-export-to-the'] = { protected: false }; // left over from a closed PR
  await flows.preflightImplement(ctx, { issueNumber: 5 });
  assert.equal(ctx.outputs.values.branch, 'claude/issue-5-add-widget-export-to-the-987', 'never reuses an existing branch');

  gh.branches['claude/issue-5-add-widget-export-to-the-987'] = { protected: false };
  await flows.preflightImplement(ctx, { issueNumber: 5 });
  assert.equal(ctx.outputs.values.proceed, 'false');
  assert.match(gh.issueComments(5).at(-1).body, /already exist\. Delete them to start over/);
});

test('work branch names follow <prefix>issue-<n>-<first five title words>', () => {
  assert.equal(flows.workBranchName('claude/', 7, '[agent-build] Fix: the `--dry-run` flag!'), 'claude/issue-7-fix-the-dry-run-flag');
  assert.equal(flows.workBranchName('agent-', 7, 'Plain title'), 'agent-issue-7-plain-title');
  assert.equal(flows.workBranchName('claude/', 7, '[agent-build] 🚀 ✨'), 'claude/issue-7-implementation');
});

test('Path A: finish is a no-op when preflight stopped the run', async () => {
  const { gh, ctx } = implementWorld();
  assert.equal(await flows.finishImplement(ctx, implementInputs({ preflight: 'false', claudeOutcome: 'skipped' })), 0);
  assert.equal(gh.issueComments(5).length, 0);
});

test('PR title strips the trigger prefix', () => {
  assert.equal(flows.prTitle('[agent-build]   Add X', 3), 'Add X');
  assert.equal(flows.prTitle('Plain title', 3), 'Plain title');
  assert.equal(flows.prTitle('[agent-build]', 3), 'Implement #3');
});

// Review cycle --------------------------------------------------------------------------------

function prWorld({ labelBy = BOT, passes = 0, final = 'not_started', config } = {}) {
  const gh = new FakeGitHub();
  gh.addPull({ number: 9, head: { ref: 'feature/x', sha: 'abc1234def' } });
  if (labelBy) gh.labelEvent(9, 'agent-review', labelBy);
  const ctx = fakeContext(gh, { config });
  if (passes !== null) gh.addComment(9, renderState({ passes, final, maxPasses: 3, stage: 'seed' }), BOT);
  return { gh, ctx };
}

test('review cycle: clean review marks the PR ready for human acceptance', async () => {
  const { gh, ctx } = prWorld();
  gh.onPoll = (g) => {
    const req = g.comments.filter((c) => c.body.startsWith('@codex review')).at(-1);
    if (req && !g.reactions[req.id]) g.reactions[req.id] = [{ user: { login: CODEX }, content: '+1' }];
  };
  await flows.reviewCycle(ctx, { pr: 9, origin: 'initial' });
  assert.equal(ctx.outputs.values.result, 'clean');
  const request = gh.issueComments(9).find((c) => c.body.startsWith('@codex review'));
  assert.equal(request.user.login, 'owner');
  assert.equal(request.body, requestBody('initial'));
  const state = stateOf(gh, 9);
  assert.match(state.body, /no actionable findings/);
  assert.match(state.body, /ready for human acceptance/);
  assert.doesNotMatch(state.body, /approved/i);
});

test('review cycle: findings and timeouts are recorded', async () => {
  const findings = prWorld();
  findings.gh.onPoll = (g) => {
    if (!(g.reviews[9] || []).length) g.addReview(9, CODEX);
  };
  await flows.reviewCycle(findings.ctx, { pr: 9, origin: 'remediation' });
  assert.equal(findings.ctx.outputs.values.result, 'findings');
  assert.match(stateOf(findings.gh, 9).body, /remediation will pick them up/);

  const pending = prWorld({ config: defaultConfig('codex:\n  wait_minutes: 1\n') });
  await flows.reviewCycle(pending.ctx, { pr: 9, origin: 'opt-in' });
  assert.equal(pending.ctx.outputs.values.result, 'pending');
  assert.match(stateOf(pending.gh, 9).body, /beyond the 1-minute monitor window/);
});

test('review cycle: wait_minutes 0 requests without waiting', async () => {
  const { gh, ctx } = prWorld({ config: defaultConfig('codex:\n  wait_minutes: 0\n') });
  await flows.reviewCycle(ctx, { pr: 9, origin: 'initial' });
  assert.equal(ctx.outputs.values.result, 'requested');
  assert.match(stateOf(gh, 9).body, /Codex initial review requested/);
  assert.ok(!gh.calls.some((c) => c.path.includes('/reactions')), 'no polling');
});

// Path B opt-in --------------------------------------------------------------------------------

test('Path B: opt-in labels via command, resets the budget and requests review', async () => {
  const { gh, ctx } = prWorld({ labelBy: null, passes: 3, final: 'complete', config: defaultConfig('codex:\n  wait_minutes: 0\n') });
  await flows.startReview(ctx, { pr: 9, actor: 'owner', via: 'command' });
  assert.deepEqual(gh.events[9].map((e) => [e.label.name, e.actor.login]), [['agent-review', BOT]]);
  const state = stateOf(gh, 9);
  assert.deepEqual([state.passes, state.final], [0, 'not_started']);
  assert.ok(gh.issueComments(9).some((c) => c.body === requestBody('opt-in')));
});

test('Path B: opt-in does nothing when the PR became ineligible', async () => {
  const { gh, ctx } = prWorld({ labelBy: null, passes: null });
  gh.pulls[9].state = 'closed';
  await flows.startReview(ctx, { pr: 9, actor: 'owner', via: 'label' });
  assert.equal(gh.issueComments(9).length, 0);
});

// Remediation --------------------------------------------------------------------------------

test('remediation plan: normal pass marks running; budget comes from countable origins', async () => {
  const { gh, ctx } = prWorld({ passes: 1 });
  gh.addComment(9, requestBody('remediation'), 'owner');
  await flows.planRemediation(ctx, { pr: 9 });
  assert.deepEqual(
    [ctx.outputs.values.mode, ctx.outputs.values.passes, ctx.outputs.values.countable, ctx.outputs.values.origin, ctx.outputs.values.head_ref],
    ['remediate', '1', 'true', 'remediation', 'feature/x'],
  );
  assert.match(stateOf(gh, 9).body, /automated remediation pass 2\/3 is running/);
});

test('remediation plan: escalates once the budget is spent', async () => {
  const { gh, ctx } = prWorld({ passes: 3 });
  gh.addComment(9, requestBody('remediation'), 'owner');
  await flows.planRemediation(ctx, { pr: 9 });
  assert.equal(ctx.outputs.values.mode, 'escalate');
  const state = stateOf(gh, 9);
  assert.equal(state.final, 'running');
  assert.match(state.body, /holistic final audit \(`opus`\) is running/);
});

test('remediation plan: exhausted when escalation is disabled', async () => {
  const { gh, ctx } = prWorld({ passes: 3, config: defaultConfig('escalation:\n  enabled: false\n') });
  gh.addComment(9, requestBody('remediation'), 'owner');
  await flows.planRemediation(ctx, { pr: 9 });
  assert.equal(ctx.outputs.values.mode, 'exhausted');
  assert.equal(stateOf(gh, 9).final, 'blocked');
  assert.match(gh.issueComments(9).at(-1).body, /escalation is disabled/);
});

test('remediation plan: manual review requests do not consume budget', async () => {
  const { gh, ctx } = prWorld({ passes: 3 });
  gh.addComment(9, '@codex review', 'owner');
  await flows.planRemediation(ctx, { pr: 9 });
  assert.deepEqual([ctx.outputs.values.mode, ctx.outputs.values.countable], ['remediate', 'false']);
  assert.match(stateOf(gh, 9).body, /without consuming the automated budget/);
});

test('remediation plan: finished automation and opted-out PRs are left alone', async () => {
  const done = prWorld({ passes: 3, final: 'complete' });
  await flows.planRemediation(done.ctx, { pr: 9 });
  assert.equal(done.ctx.outputs.values.mode, 'finished');
  assert.match(stateOf(done.gh, 9).body, /seed/, 'state untouched');

  const optedOut = prWorld();
  optedOut.gh.pulls[9].labels = [];
  await flows.planRemediation(optedOut.ctx, { pr: 9 });
  assert.equal(optedOut.ctx.outputs.values.mode, 'none', 'removing the label stops automation');
});

const remediationInputs = (extra = {}) => ({
  ...claudeOk,
  pr: 9,
  passes: '1',
  countable: 'true',
  headSha: 'abc1234def',
  rawResult: ok('fixed'),
  validationOutcome: 'success',
  validationResult: '',
  ...extra,
});

test('remediation finish: success resolves threads, advances budget, requests re-review', async () => {
  const { gh, ctx } = prWorld({ passes: 1 });
  gh.pulls[9].head.sha = 'new5678';
  gh.threads[9] = [{ id: 't1', isResolved: false, authors: [CODEX] }];
  assert.equal(await flows.finishRemediation(ctx, remediationInputs()), 0);
  assert.equal(ctx.outputs.values.request_review, 'true');
  assert.equal(gh.threads[9][0].isResolved, true);
  const state = stateOf(gh, 9);
  assert.equal(state.passes, 2);
  assert.match(state.body, /budget used: 2\/3/);
});

test('remediation finish: non-countable passes keep the budget', async () => {
  const { gh, ctx } = prWorld({ passes: 1 });
  gh.pulls[9].head.sha = 'new5678';
  await flows.finishRemediation(ctx, remediationInputs({ countable: 'false' }));
  assert.equal(stateOf(gh, 9).passes, 1);
});

test('remediation finish: blocked, no commits, validation failure and crashes stop for a human', async () => {
  const blocked = prWorld({ passes: 1 });
  assert.equal(await flows.finishRemediation(blocked.ctx, remediationInputs({ rawResult: ok('blocked') })), 0);
  assert.match(blocked.gh.issueComments(9).at(-1).body, /could not safely resolve/);
  assert.equal(blocked.ctx.outputs.values.request_review, 'false');

  const nothing = prWorld({ passes: 1 });
  assert.equal(await flows.finishRemediation(nothing.ctx, remediationInputs()), 0);
  assert.match(nothing.gh.issueComments(9).at(-1).body, /pushed no commits/);
  assert.equal(stateOf(nothing.gh, 9).passes, 2, 'the attempt still counts');
  assert.equal(nothing.ctx.outputs.values.request_review, 'false');

  const invalid = prWorld({ passes: 1 });
  invalid.gh.pulls[9].head.sha = 'new5678';
  assert.equal(await flows.finishRemediation(invalid.ctx, remediationInputs({ validationOutcome: 'failure' })), 1);
  assert.match(stateOf(invalid.gh, 9).body, /validation failed; automated review paused/);
  assert.equal(invalid.ctx.outputs.values.request_review, 'false');

  const crashed = prWorld({ passes: 1 });
  assert.equal(await flows.finishRemediation(crashed.ctx, remediationInputs({ claudeOutcome: 'cancelled', claudeConclusion: '' })), 1);
  assert.match(crashed.gh.issueComments(9).at(-1).body, /cancelled/);
  assert.equal(stateOf(crashed.gh, 9).passes, 1, 'a crashed run does not consume budget');
});

// Escalation ------------------------------------------------------------------------------------

const audit = (status, findings = []) => JSON.stringify({ status, summary: `audit ${status}`, findings });

test('audit: clean completes automation and resolves threads', async () => {
  const { gh, ctx } = prWorld({ passes: 3, final: 'running' });
  gh.threads[9] = [{ id: 't1', isResolved: false, authors: [CODEX] }];
  assert.equal(await flows.finishAudit(ctx, { ...claudeOk, pr: 9, headSha: 'abc1234def', rawResult: audit('clean') }), 0);
  const state = stateOf(gh, 9);
  assert.equal(state.final, 'complete');
  assert.match(state.body, /ready for human acceptance/);
  assert.equal(gh.threads[9][0].isResolved, true);
  assert.equal(ctx.outputs.values.run_fix, 'false');
});

test('audit: findings hand off to the consolidated fix', async () => {
  const { gh, ctx } = prWorld({ passes: 3, final: 'running' });
  const findings = [{ severity: 'P1', location: 'src/a.ts:3', problem: 'p', recommended_fix: 'f' }];
  await flows.finishAudit(ctx, { ...claudeOk, pr: 9, headSha: 'abc1234def', rawResult: audit('findings', findings) });
  assert.equal(ctx.outputs.values.run_fix, 'true');
  assert.deepEqual(JSON.parse(ctx.outputs.values.findings), findings);
  assert.match(stateOf(gh, 9).body, /found 1 issue\(s\); consolidated fix/);
});

test('audit: a branch change during the read-only audit blocks automation', async () => {
  const { gh, ctx } = prWorld({ passes: 3, final: 'running' });
  gh.pulls[9].head.sha = 'tampered';
  assert.equal(await flows.finishAudit(ctx, { ...claudeOk, pr: 9, headSha: 'abc1234def', rawResult: audit('clean') }), 1);
  assert.equal(stateOf(gh, 9).final, 'blocked');
  assert.match(gh.issueComments(9).at(-1).body, /changed the branch unexpectedly/);
});

test('audit: blocked and failed audits stop for a human', async () => {
  const blocked = prWorld({ passes: 3, final: 'running' });
  await flows.finishAudit(blocked.ctx, { ...claudeOk, pr: 9, headSha: 'abc1234def', rawResult: audit('blocked') });
  assert.equal(stateOf(blocked.gh, 9).final, 'blocked');
  const failed = prWorld({ passes: 3, final: 'running' });
  assert.equal(await flows.finishAudit(failed.ctx, { claudeOutcome: 'failure', claudeConclusion: 'failure', pr: 9, headSha: 'abc1234def', rawResult: '' }), 1);
  assert.equal(stateOf(failed.gh, 9).final, 'blocked');
});

test('final fix: completes automation without requesting another review', async () => {
  const { gh, ctx } = prWorld({ passes: 3, final: 'running' });
  await flows.finishFinalFix(ctx, { ...claudeOk, pr: 9, auditSummary: 'two issues', rawResult: ok('fixed'), validationOutcome: 'success' });
  const state = stateOf(gh, 9);
  assert.equal(state.final, 'complete');
  assert.match(state.body, /No further automated review will run/);
  assert.ok(!gh.issueComments(9).some((c) => c.body.startsWith('@codex review')));
});

test('final fix: validation failure or blocked result ends blocked', async () => {
  const invalid = prWorld({ passes: 3, final: 'running' });
  assert.equal(await flows.finishFinalFix(invalid.ctx, { ...claudeOk, pr: 9, rawResult: ok('fixed'), validationOutcome: 'failure' }), 1);
  assert.equal(stateOf(invalid.gh, 9).final, 'blocked');
  const blocked = prWorld({ passes: 3, final: 'running' });
  await flows.finishFinalFix(blocked.ctx, { ...claudeOk, pr: 9, rawResult: ok('blocked') });
  assert.equal(stateOf(blocked.gh, 9).final, 'blocked');
});

// Human fix ---------------------------------------------------------------------------------------

test('human fix: prepare opts in and records progress; finish resets the budget', async () => {
  const { gh, ctx } = prWorld({ labelBy: null, passes: 3, final: 'blocked' });
  await flows.prepareHumanFix(ctx, { pr: 9, actor: 'owner' });
  assert.equal(ctx.outputs.values.proceed, 'true');
  assert.equal(ctx.outputs.values.head_ref, 'feature/x');
  assert.deepEqual(gh.events[9].map((e) => e.actor.login), [BOT]);
  assert.match(stateOf(gh, 9).body, /Owner-requested fix \(`\/agent-fix` by @owner\) is running/);

  assert.equal(await flows.finishHumanFix(ctx, { ...claudeOk, pr: 9, proceed: 'true', setupOutcome: 'success', rawResult: ok('fixed'), validationOutcome: 'success' }), 0);
  const state = stateOf(gh, 9);
  assert.deepEqual([state.passes, state.final], [0, 'not_started']);
  assert.equal(ctx.outputs.values.request_review, 'true');
});

test('human fix: blocked/no_change and validation failures are reported', async () => {
  for (const status of ['blocked', 'no_change']) {
    const { gh, ctx } = prWorld();
    await flows.finishHumanFix(ctx, { ...claudeOk, pr: 9, proceed: 'true', setupOutcome: 'success', rawResult: ok(status) });
    assert.match(gh.issueComments(9).at(-1).body, new RegExp(`finished with status \`${status}\``));
    assert.equal(ctx.outputs.values.request_review, 'false');
  }
  const invalid = prWorld();
  assert.equal(await flows.finishHumanFix(invalid.ctx, { ...claudeOk, pr: 9, proceed: 'true', setupOutcome: 'success', rawResult: ok('fixed'), validationOutcome: 'failure' }), 1);
  assert.equal(invalid.ctx.outputs.values.request_review, 'false');
  const noSetup = prWorld();
  assert.equal(await flows.finishHumanFix(noSetup.ctx, { claudeOutcome: 'skipped', pr: 9, proceed: 'true', setupOutcome: 'failure' }), 1);
  assert.match(noSetup.gh.issueComments(9).at(-1).body, /Environment setup failed/);
});

test('human fix: ineligible PRs are skipped inside the lock', async () => {
  const gh = new FakeGitHub();
  gh.addPull({ number: 9, head: { ref: 'x', repo: { full_name: 'mallory/widget' } } });
  const forkCtx = fakeContext(gh);
  await flows.prepareHumanFix(forkCtx, { pr: 9, actor: 'owner' });
  assert.equal(forkCtx.outputs.values.proceed, 'false');
  assert.equal(await flows.finishHumanFix(forkCtx, { pr: 9, proceed: 'false' }), 0);
  assert.equal(gh.comments.length, 0);
});
