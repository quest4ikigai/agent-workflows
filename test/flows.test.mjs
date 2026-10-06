import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as flows from '../lib/runtime/flows.mjs';
import { run } from '../lib/runtime/main.mjs';
import { parseState, renderState } from '../lib/runtime/state.mjs';
import { requestBody } from '../lib/runtime/codex.mjs';
import {
  BOT,
  CODEX,
  DRIFT_FINDING,
  FakeGitHub,
  cleanResult,
  cleanupTemp,
  codexSummary,
  codexThreads,
  defaultConfig,
  fakeContext,
  user,
} from './helpers.mjs';

after(cleanupTemp);

const HEAD = 'abc1234def0123456789abcdef0123456789abcd';

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
    delete gh.compare['main...claude/issue-5-add-widget-export']; // never pushed
    assert.equal(await flows.finishImplement(ctx, implementInputs({ rawResult: ok(status) })), 0);
    assert.equal(Object.keys(gh.pulls).length, 0);
    assert.match(gh.issueComments(5).at(-1).body, new RegExp(`stopped with status \`${status}\``));
    assert.doesNotMatch(gh.issueComments(5).at(-1).body, /pushed commits/);
    assert.equal(ctx.outputs.values.request_review, 'false');
  }
});

test('Path A: a blocked run that pushed commits says so; no_change with pushed commits is invalid', async () => {
  const blocked = implementWorld();
  assert.equal(await flows.finishImplement(blocked.ctx, implementInputs({ rawResult: ok('blocked') })), 0);
  assert.match(blocked.gh.issueComments(5).at(-1).body, /stopped with status `blocked`[\s\S]*Claude pushed commits to `claude\/issue-5-add-widget-export` before stopping; no pull request was opened/);
  assert.equal(Object.keys(blocked.gh.pulls).length, 0);

  const noChange = implementWorld();
  assert.equal(await flows.finishImplement(noChange.ctx, implementInputs({ rawResult: ok('no_change') })), 1);
  assert.match(noChange.gh.issueComments(5).at(-1).body, /Claude returned `no_change`, but commits were pushed to `claude\/issue-5-add-widget-export`\. Treating this as an invalid implementation result/);
  assert.equal(Object.keys(noChange.gh.pulls).length, 0);
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
    [{ branch: 'claude/issue-5-unpushed' }, /Claude returned `implemented`, but no commit was pushed to `claude\/issue-5-unpushed`/],
  ];
  for (const [extra, pattern] of cases) {
    const { gh, ctx } = implementWorld();
    assert.equal(await flows.finishImplement(ctx, implementInputs(extra)), 1, JSON.stringify(extra));
    assert.match(gh.issueComments(5).at(-1).body, pattern, JSON.stringify(extra));
    assert.match(gh.issueComments(5).at(-1).body, /Workflow run: https:/);
    assert.equal(Object.keys(gh.pulls).length, 0);
  }
});

test('Path A: implemented requires commits on the work branch ahead of the base', async () => {
  const { gh, ctx } = implementWorld();
  gh.compare['main...claude/issue-5-add-widget-export'] = { ahead_by: 0 };
  assert.equal(await flows.finishImplement(ctx, implementInputs()), 1);
  assert.match(gh.issueComments(5).at(-1).body, /Claude returned `implemented`, but no commit was pushed to `claude\/issue-5-add-widget-export`\. Treating this as an invalid implementation result; no pull request was opened/);
  assert.equal(Object.keys(gh.pulls).length, 0);
  assert.equal(ctx.outputs.values.request_review, 'false');

  const unknown = implementWorld();
  unknown.gh.compare['main...claude/issue-5-add-widget-export'] = { status: 500 };
  assert.equal(await flows.finishImplement(unknown.ctx, implementInputs()), 1);
  assert.match(unknown.gh.issueComments(5).at(-1).body, /could not confirm that a commit was pushed/, 'an unreadable branch never confirms a push');
  assert.equal(Object.keys(unknown.gh.pulls).length, 0);
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
  gh.addPull({ number: 9, head: { ref: 'feature/x', sha: HEAD } });
  if (labelBy) gh.labelEvent(9, 'agent-review', labelBy);
  const ctx = fakeContext(gh, { config });
  if (passes !== null) gh.addComment(9, renderState({ passes, final, maxPasses: 3, stage: 'seed' }), BOT);
  return { gh, ctx };
}

test('review cycle: clean review marks the PR ready for human acceptance', async () => {
  const { gh, ctx } = prWorld();
  gh.onPoll = (g) => {
    const req = g.comments.filter((c) => c.body.startsWith('@codex review')).at(-1);
    if (req && !g.reactions[req.id]) g.reactions[req.id] = [{ user: user(CODEX), content: '+1' }];
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

test('review cycle: wait_minutes 0 records the exact request and exits without waiting', async () => {
  const { gh, ctx } = prWorld({ config: defaultConfig('codex:\n  wait_minutes: 0\n') });
  await flows.reviewCycle(ctx, { pr: 9, origin: 'human-fix' });
  assert.equal(ctx.outputs.values.result, 'requested');
  const request = gh.issueComments(9).find((c) => c.body.startsWith('@codex review'));
  const state = stateOf(gh, 9);
  assert.deepEqual(state.review, { sha: HEAD, status: 'requested', origin: 'human-fix', requestedAt: request.created_at, requestId: request.id, completedAt: null });
  assert.match(state.body, /\*\*Stage:\*\* Codex review after owner-requested fix requested; awaiting completion signal\.\n\*\*Codex review:\*\* Awaiting completion signal\n\*\*Commit:\*\* `abc1234`\n\*\*Requested:\*\* 2026-10-01 00:00 UTC \(review after owner-requested fix\)/);
  assert.match(state.body, /No Codex completion signal has been received yet, and no runner waits for one/);
  assert.doesNotMatch(state.body, /timed out|timeout|beyond the/i);
  assert.ok(!gh.calls.some((c) => c.path.includes('/reactions') || c.path.endsWith('/reviews')), 'no polling');
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

test('remediation plan: collects current unresolved Codex findings for the prompt', async () => {
  const { gh, ctx } = prWorld({ passes: 1 });
  gh.addComment(9, requestBody('remediation'), 'owner');
  const review = gh.addReview(9, CODEX, '');
  gh.threads[9] = codexThreads(review.id);
  ctx.event = { review: { id: review.id, body: '' } };
  await flows.planRemediation(ctx, { pr: 9 });
  const collected = JSON.parse(ctx.outputs.values.codex_findings);
  assert.deepEqual(collected.findings.map((f) => f.thread), ['PRRT_drift', 'PRRT_ico'], 'resolved, outdated, human and look-alike threads excluded');
  assert.ok(!ctx.outputs.values.codex_findings.includes('deploy hook'), 'a look-alike account cannot inject "findings" into the prompt');
  assert.deepEqual(collected.findings.map((f) => f.latest), [true, false]);
  assert.equal(collected.outdated, 1);

  const failing = prWorld({ passes: 1 });
  failing.gh.graphql = () => ({ data: { errors: [{ message: 'boom' }] } });
  await flows.planRemediation(failing.ctx, { pr: 9 });
  assert.equal(failing.ctx.outputs.values.mode, 'remediate', 'remediation still runs');
  assert.equal(failing.ctx.outputs.values.codex_findings, '', 'and the prompt is told the list is unavailable');
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
  headSha: HEAD,
  rawResult: ok('fixed'),
  validationOutcome: 'success',
  validationResult: '',
  ...extra,
});

const reviewRequests = (gh) => gh.issueComments(9).filter((c) => c.body.startsWith('@codex review'));

test('remediation finish: a fixed result with a pushed commit resolves threads, consumes the pass, requests re-review', async () => {
  const { gh, ctx } = prWorld({ passes: 1 });
  gh.pulls[9].head.sha = 'new5678';
  gh.threads[9] = [{ id: 't1', isResolved: false, authors: [CODEX] }];
  assert.equal(await flows.finishRemediation(ctx, remediationInputs()), 0);
  assert.equal(ctx.outputs.values.request_review, 'true');
  assert.equal(gh.threads[9][0].isResolved, true);
  const state = stateOf(gh, 9);
  assert.equal(state.passes, 2);
  assert.match(state.body, /Pushed abc1234 → new5678\. Automated remediation budget used: 2\/3/);
});

test('remediation finish: non-countable passes keep the budget', async () => {
  const { gh, ctx } = prWorld({ passes: 1 });
  gh.pulls[9].head.sha = 'new5678';
  await flows.finishRemediation(ctx, remediationInputs({ countable: 'false' }));
  assert.equal(stateOf(gh, 9).passes, 1);
  assert.equal(ctx.outputs.values.request_review, 'true');
});

test('remediation finish: fixed without a pushed commit is an invalid result (Curious Workbench regression)', async () => {
  const { gh, ctx } = prWorld({ passes: 2 });
  gh.threads[9] = codexThreads(1);
  const rawResult = ok('fixed', { summary: 'Left the drift check unresolved pending a design decision.' });
  assert.equal(await flows.finishRemediation(ctx, remediationInputs({ passes: '2', rawResult })), 1);
  const posted = gh.issueComments(9).at(-1).body;
  assert.match(posted, /^Invalid remediation result; human input required\./);
  assert.match(posted, /Claude returned `fixed`, but no commit was pushed to `feature\/x`\.\nTreating this as an invalid remediation result; human input is required\./);
  assert.match(posted, /No remediation pass was consumed and no re-review was requested/);
  assert.match(posted, /pending a design decision/, "Claude's own explanation is shown");
  const state = stateOf(gh, 9);
  assert.equal(state.passes, 2, 'the third pass is not consumed');
  assert.equal(state.final, 'not_started');
  assert.equal(ctx.outputs.values.request_review, 'false');
  assert.equal(reviewRequests(gh).length, 0);
  assert.ok(gh.threads[9].find((t) => t.id === 'PRRT_drift').isResolved === false, 'the actionable thread stays open');
});

test('remediation finish: blocked stops for a human without consuming a pass', async () => {
  const { gh, ctx } = prWorld({ passes: 1 });
  gh.threads[9] = codexThreads(1);
  assert.equal(await flows.finishRemediation(ctx, remediationInputs({ rawResult: ok('blocked') })), 0);
  const posted = gh.issueComments(9).at(-1).body;
  assert.match(posted, /could not safely resolve the latest Codex review; human input required/);
  assert.match(posted, /\*\*Reason:\*\* summary for blocked/);
  assert.match(posted, /No remediation pass was consumed/);
  assert.doesNotMatch(posted, /pushed commits/);
  assert.equal(stateOf(gh, 9).passes, 1);
  assert.equal(ctx.outputs.values.request_review, 'false');
  assert.ok(gh.threads[9].every((t) => t.id === 'PRRT_resolved' || !t.isResolved), 'threads untouched');

  const pushed = prWorld({ passes: 1 });
  pushed.gh.pulls[9].head.sha = 'new5678';
  assert.equal(await flows.finishRemediation(pushed.ctx, remediationInputs({ rawResult: ok('blocked') })), 0);
  assert.match(pushed.gh.issueComments(9).at(-1).body, /Claude pushed commits before stopping \(abc1234 → new5678\); they have not been validated or re-reviewed/);
  assert.equal(stateOf(pushed.gh, 9).passes, 1);
  assert.equal(pushed.ctx.outputs.values.request_review, 'false');
});

test('remediation finish: no_change without a commit keeps the threads open for a human', async () => {
  const { gh, ctx } = prWorld({ passes: 1 });
  gh.threads[9] = codexThreads(1);
  assert.equal(await flows.finishRemediation(ctx, remediationInputs({ rawResult: ok('no_change') })), 0);
  const posted = gh.issueComments(9).at(-1).body;
  assert.match(posted, /^Claude determined no repository change is warranted for the current Codex findings; human input required\./);
  assert.match(posted, /2 unresolved Codex review thread\(s\) remain\. Human input is required to accept or dismiss them/);
  assert.match(posted, /\*\*Claude's explanation:\*\* summary for no_change/);
  assert.doesNotMatch(posted + stateOf(gh, 9).body, /remediation complete|fixed|clean|ready for human acceptance/i);
  assert.equal(stateOf(gh, 9).passes, 1);
  assert.equal(ctx.outputs.values.request_review, 'false');
  assert.equal(reviewRequests(gh).length, 0);
  assert.equal(gh.threads[9].find((t) => t.id === 'PRRT_drift').isResolved, false, 'never resolved on Claude\'s word');

  const none = prWorld({ passes: 1 });
  none.gh.threads[9] = [{ id: 'old', isResolved: false, isOutdated: true, authors: [CODEX] }];
  assert.equal(await flows.finishRemediation(none.ctx, remediationInputs({ rawResult: ok('no_change') })), 0);
  assert.match(none.gh.issueComments(9).at(-1).body, /No current unresolved Codex review threads remain \(1 outdated\), but the review is not declared clean/);
  assert.equal(none.ctx.outputs.values.request_review, 'false');

  const unlisted = prWorld({ passes: 1 });
  unlisted.gh.graphql = () => ({ data: { errors: [{ message: 'boom' }] } });
  assert.equal(await flows.finishRemediation(unlisted.ctx, remediationInputs({ rawResult: ok('no_change') })), 0);
  assert.match(unlisted.gh.issueComments(9).at(-1).body, /could not be listed\. Human input is required/);
});

test('remediation finish: no_change with a pushed commit is an invalid result', async () => {
  const { gh, ctx } = prWorld({ passes: 1 });
  gh.pulls[9].head.sha = 'new5678';
  assert.equal(await flows.finishRemediation(ctx, remediationInputs({ rawResult: ok('no_change') })), 1);
  assert.match(gh.issueComments(9).at(-1).body, /Claude returned `no_change`, but commits were pushed to `feature\/x`\.\nTreating this as an invalid remediation result/);
  assert.equal(stateOf(gh, 9).passes, 1);
  assert.equal(ctx.outputs.values.request_review, 'false');
});

test('remediation finish: an unreadable head never confirms a fix', async () => {
  const { gh, ctx } = prWorld({ passes: 1 });
  delete gh.pulls[9];
  assert.equal(await flows.finishRemediation(ctx, remediationInputs()), 1);
  assert.match(gh.issueComments(9).at(-1).body, /Claude returned `fixed`, but the workflow could not confirm that a commit was pushed/);
  assert.equal(stateOf(gh, 9).passes, 1);
  assert.equal(ctx.outputs.values.request_review, 'false');
});

test('remediation finish: validation failure after a pushed fix consumes the pass and pauses', async () => {
  const { gh, ctx } = prWorld({ passes: 1 });
  gh.pulls[9].head.sha = 'new5678';
  assert.equal(await flows.finishRemediation(ctx, remediationInputs({ validationOutcome: 'failure' })), 1);
  const state = stateOf(gh, 9);
  assert.match(state.body, /validation failed; automated review paused/);
  assert.equal(state.passes, 2, 'a real mutation happened');
  assert.equal(ctx.outputs.values.request_review, 'false');
});

test('remediation finish: crashed or unparseable runs stop without consuming a pass', async () => {
  const crashed = prWorld({ passes: 1 });
  crashed.gh.pulls[9].head.sha = 'new5678';
  assert.equal(await flows.finishRemediation(crashed.ctx, remediationInputs({ claudeOutcome: 'cancelled', claudeConclusion: '' })), 1);
  assert.match(crashed.gh.issueComments(9).at(-1).body, /cancelled/);
  assert.equal(stateOf(crashed.gh, 9).passes, 1);

  const garbled = prWorld({ passes: 1 });
  assert.equal(await flows.finishRemediation(garbled.ctx, remediationInputs({ rawResult: '{"status":"done"}' })), 1);
  assert.match(garbled.gh.issueComments(9).at(-1).body, /unexpected status "done"/);
  assert.equal(stateOf(garbled.gh, 9).passes, 1);
});

test('pass accounting: only a countable, verified, pushed fix consumes a pass', async () => {
  const cases = [
    // [status, head moves, countable, expected passes, re-review]
    ['fixed', true, 'true', 2, 'true'],
    ['fixed', true, 'false', 1, 'true'],
    ['fixed', false, 'true', 1, 'false'],
    ['blocked', false, 'true', 1, 'false'],
    ['blocked', true, 'true', 1, 'false'],
    ['no_change', false, 'true', 1, 'false'],
    ['no_change', true, 'true', 1, 'false'],
  ];
  for (const [status, moves, countable, passes, review] of cases) {
    const { gh, ctx } = prWorld({ passes: 1 });
    if (moves) gh.pulls[9].head.sha = 'new5678';
    await flows.finishRemediation(ctx, remediationInputs({ rawResult: ok(status), countable }));
    const label = `${status}, head ${moves ? 'moved' : 'unchanged'}, countable=${countable}`;
    assert.equal(stateOf(gh, 9).passes, passes, label);
    assert.equal(ctx.outputs.values.request_review, review, label);
  }
});

test('Curious Workbench regression: inline finding reaches the prompt; fixed without a push consumes nothing', async () => {
  const { gh, ctx } = prWorld({ passes: 2 });
  gh.addComment(9, requestBody('remediation'), 'owner');
  const review = gh.addReview(9, CODEX, '');
  gh.threads[9] = [codexThreads(review.id).find((t) => t.id === 'PRRT_drift')];
  ctx.event = { review: { id: review.id, body: '' } };

  await flows.planRemediation(ctx, { pr: 9 });
  assert.equal(ctx.outputs.values.mode, 'remediate');
  assert.match(stateOf(gh, 9).body, /automated remediation pass 3\/3 is running/);

  const prompt = fakeContext(gh, { event: ctx.event });
  prompt.env = { PR_NUMBER: '9', HEAD_REF: ctx.outputs.values.head_ref, CODEX_FINDINGS: ctx.outputs.values.codex_findings };
  await run('prompt', 'remediate', prompt);
  const text = prompt.outputs.values.prompt;
  assert.match(text, /LATEST REVIEW BODY:\n````\n\(empty\)\n````/);
  assert.match(text, /An empty latest review body does not imply there are no findings/);
  assert.match(text, /1\. scripts\/brand\/sync\.mjs:20-22\n   P2: Check generated public derivatives for drift\n/);
  assert.ok(text.includes(DRIFT_FINDING), 'full comment text');

  const finish = fakeContext(gh);
  const rawResult = ok('fixed', { summary: 'Resolving it requires a design decision; left unresolved.' });
  const code = await flows.finishRemediation(finish, remediationInputs({ passes: ctx.outputs.values.passes, countable: ctx.outputs.values.countable, headSha: ctx.outputs.values.head_sha, rawResult }));
  assert.equal(code, 1);
  assert.equal(stateOf(gh, 9).passes, 2, 'pass 3 is still available');
  assert.match(stateOf(gh, 9).body, /Invalid remediation result; human input required/);
  assert.equal(finish.outputs.values.request_review, 'false');
  assert.equal(gh.threads[9][0].isResolved, false);
});

// Escalation ------------------------------------------------------------------------------------

const audit = (status, findings = []) => JSON.stringify({ status, summary: `audit ${status}`, findings });

test('audit: clean completes automation and resolves threads', async () => {
  const { gh, ctx } = prWorld({ passes: 3, final: 'running' });
  gh.threads[9] = [{ id: 't1', isResolved: false, authors: [CODEX] }];
  assert.equal(await flows.finishAudit(ctx, { ...claudeOk, pr: 9, headSha: HEAD, rawResult: audit('clean') }), 0);
  const state = stateOf(gh, 9);
  assert.equal(state.final, 'complete');
  assert.match(state.body, /ready for human acceptance/);
  assert.equal(gh.threads[9][0].isResolved, true);
  assert.equal(ctx.outputs.values.run_fix, 'false');
});

test('audit: findings hand off to the consolidated fix', async () => {
  const { gh, ctx } = prWorld({ passes: 3, final: 'running' });
  const findings = [{ severity: 'P1', location: 'src/a.ts:3', problem: 'p', recommended_fix: 'f' }];
  await flows.finishAudit(ctx, { ...claudeOk, pr: 9, headSha: HEAD, rawResult: audit('findings', findings) });
  assert.equal(ctx.outputs.values.run_fix, 'true');
  assert.deepEqual(JSON.parse(ctx.outputs.values.findings), findings);
  assert.match(stateOf(gh, 9).body, /found 1 issue\(s\); consolidated fix/);
});

test('audit: a branch change during the read-only audit blocks automation', async () => {
  const { gh, ctx } = prWorld({ passes: 3, final: 'running' });
  gh.pulls[9].head.sha = 'tampered';
  assert.equal(await flows.finishAudit(ctx, { ...claudeOk, pr: 9, headSha: HEAD, rawResult: audit('clean') }), 1);
  assert.equal(stateOf(gh, 9).final, 'blocked');
  assert.match(gh.issueComments(9).at(-1).body, /changed the branch unexpectedly/);
});

test('audit: blocked and failed audits stop for a human', async () => {
  const blocked = prWorld({ passes: 3, final: 'running' });
  await flows.finishAudit(blocked.ctx, { ...claudeOk, pr: 9, headSha: HEAD, rawResult: audit('blocked') });
  assert.equal(stateOf(blocked.gh, 9).final, 'blocked');
  const failed = prWorld({ passes: 3, final: 'running' });
  assert.equal(await flows.finishAudit(failed.ctx, { claudeOutcome: 'failure', claudeConclusion: 'failure', pr: 9, headSha: HEAD, rawResult: '' }), 1);
  assert.equal(stateOf(failed.gh, 9).final, 'blocked');
});

const finalInputs = (extra = {}) => ({ ...claudeOk, pr: 9, headSha: HEAD, auditSummary: 'two issues', rawResult: ok('fixed'), validationOutcome: 'success', ...extra });

test('final fix: a verified, pushed fix completes automation without requesting another review', async () => {
  const { gh, ctx } = prWorld({ passes: 3, final: 'running' });
  gh.pulls[9].head.sha = 'new5678';
  gh.threads[9] = [{ id: 't1', isResolved: false, authors: [CODEX] }];
  assert.equal(await flows.finishFinalFix(ctx, finalInputs()), 0);
  const state = stateOf(gh, 9);
  assert.equal(state.final, 'complete');
  assert.match(state.body, /Final audit and consolidated remediation complete/);
  assert.match(state.body, /pushed abc1234 → new5678/);
  assert.match(state.body, /No further automated review will run/);
  assert.equal(gh.threads[9][0].isResolved, true);
  assert.equal(reviewRequests(gh).length, 0);
});

test('final fix: fixed without a pushed commit never declares completion', async () => {
  const { gh, ctx } = prWorld({ passes: 3, final: 'running' });
  gh.threads[9] = [{ id: 't1', isResolved: false, authors: [CODEX] }];
  assert.equal(await flows.finishFinalFix(ctx, finalInputs()), 1);
  const state = stateOf(gh, 9);
  assert.equal(state.final, 'blocked');
  assert.doesNotMatch(state.body, /complete;|ready for human acceptance/);
  assert.match(gh.issueComments(9).at(-1).body, /^Invalid consolidated final-fix result; human input required\.\n\nClaude returned `fixed`, but no commit was pushed to `feature\/x`\./);
  assert.equal(gh.threads[9][0].isResolved, false);
  assert.equal(reviewRequests(gh).length, 0);
});

test('final fix: blocked, no_change, inconsistent results and validation failures end blocked', async () => {
  const cases = [
    // [status, head moves, validation, exit code, message]
    ['blocked', false, 'skipped', 0, /^Consolidated final remediation needs human input\.\n\n\*\*Reason:\*\* summary for blocked/],
    ['blocked', true, 'skipped', 0, /Claude pushed commits before stopping \(abc1234 → new5678\)/],
    ['no_change', false, 'skipped', 0, /^The consolidated final fix made no changes; human input required\.[\s\S]*without being declared complete[\s\S]*\*\*Audit:\*\* two issues/],
    ['no_change', true, 'skipped', 1, /Claude returned `no_change`, but commits were pushed/],
    ['fixed', true, 'failure', 1, /pushed, but repository validation failed/],
  ];
  for (const [status, moves, validationOutcome, code, message] of cases) {
    const { gh, ctx } = prWorld({ passes: 3, final: 'running' });
    if (moves) gh.pulls[9].head.sha = 'new5678';
    gh.threads[9] = [{ id: 't1', isResolved: false, authors: [CODEX] }];
    const label = `${status}, head ${moves ? 'moved' : 'unchanged'}`;
    assert.equal(await flows.finishFinalFix(ctx, finalInputs({ rawResult: ok(status), validationOutcome })), code, label);
    assert.equal(stateOf(gh, 9).final, 'blocked', label);
    assert.match(gh.issueComments(9).at(-1).body, message, label);
    assert.equal(gh.threads[9][0].isResolved, false, label);
  }
});

// Human fix ---------------------------------------------------------------------------------------

const humanInputs = (extra = {}) => ({ ...claudeOk, pr: 9, headSha: HEAD, proceed: 'true', setupOutcome: 'success', rawResult: ok('fixed'), validationOutcome: 'success', ...extra });

test('human fix: prepare opts in, records progress and collects Codex findings; a pushed fix resets the budget', async () => {
  const { gh, ctx } = prWorld({ labelBy: null, passes: 3, final: 'blocked' });
  gh.threads[9] = codexThreads(1);
  await flows.prepareHumanFix(ctx, { pr: 9, actor: 'owner' });
  assert.equal(ctx.outputs.values.proceed, 'true');
  assert.equal(ctx.outputs.values.head_ref, 'feature/x');
  assert.equal(ctx.outputs.values.head_sha, HEAD);
  assert.deepEqual(JSON.parse(ctx.outputs.values.codex_findings).findings.map((f) => [f.thread, f.latest]), [['PRRT_drift', null], ['PRRT_ico', null]]);
  assert.deepEqual(gh.events[9].map((e) => e.actor.login), [BOT]);
  assert.match(stateOf(gh, 9).body, /Owner-requested fix \(`\/agent-fix` by @owner\) is running/);

  gh.pulls[9].head.sha = 'new5678';
  assert.equal(await flows.finishHumanFix(ctx, humanInputs()), 0);
  const state = stateOf(gh, 9);
  assert.deepEqual([state.passes, state.final], [0, 'not_started']);
  assert.match(state.body, /Pushed abc1234 → new5678/);
  assert.equal(ctx.outputs.values.request_review, 'true');
});

test('human fix: fixed without a pushed commit is invalid and requests no review', async () => {
  const { gh, ctx } = prWorld({ passes: 3, final: 'blocked' });
  assert.equal(await flows.finishHumanFix(ctx, humanInputs()), 1);
  const posted = gh.issueComments(9).at(-1).body;
  assert.match(posted, /^Invalid `\/agent-fix` result; human input required\.\n\nClaude returned `fixed`, but no commit was pushed to `feature\/x`\./);
  assert.match(posted, /No Codex review was requested/);
  assert.equal(ctx.outputs.values.request_review, 'false');
  const state = stateOf(gh, 9);
  assert.deepEqual([state.passes, state.final], [3, 'blocked'], 'no fresh budget without a fix');
});

test('human fix: blocked, no_change and inconsistent results never request review', async () => {
  const cases = [
    // [status, head moves, exit code, message]
    ['blocked', false, 0, /^Owner-requested fix is blocked; human input required\.\n\n\*\*Reason:\*\* summary for blocked/],
    ['blocked', true, 0, /Claude pushed commits before stopping/],
    ['no_change', false, 0, /^Owner-requested fix made no changes\.\n\nClaude determined that no repository change is warranted\. No commit was pushed and no Codex review was requested\./],
    ['no_change', true, 1, /^Invalid `\/agent-fix` result[\s\S]*Claude returned `no_change`, but commits were pushed/],
  ];
  for (const [status, moves, code, message] of cases) {
    const { gh, ctx } = prWorld({ passes: 2 });
    if (moves) gh.pulls[9].head.sha = 'new5678';
    const label = `${status}, head ${moves ? 'moved' : 'unchanged'}`;
    assert.equal(await flows.finishHumanFix(ctx, humanInputs({ rawResult: ok(status) })), code, label);
    assert.match(gh.issueComments(9).at(-1).body, message, label);
    assert.equal(ctx.outputs.values.request_review, 'false', label);
    assert.equal(stateOf(gh, 9).passes, 2, label);
  }
});

test('human fix: validation and setup failures are reported', async () => {
  const invalid = prWorld();
  invalid.gh.pulls[9].head.sha = 'new5678';
  assert.equal(await flows.finishHumanFix(invalid.ctx, humanInputs({ validationOutcome: 'failure' })), 1);
  assert.match(invalid.gh.issueComments(9).at(-1).body, /validation failed; Codex review was not requested/);
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

// Codex completion events ---------------------------------------------------------------------

const CW = '4d1c0e3164fe92828c917f20da980d75d54bd293';

/** Curious Workbench PR #17: an opted-in PR with one pass used, its review requested with wait_minutes 0. */
async function awaitingWorld({ waitMinutes = 0, origin = 'human-fix' } = {}) {
  const gh = new FakeGitHub();
  gh.addPull({ number: 17, head: { ref: 'feature/brand', sha: CW } });
  gh.labelEvent(17, 'agent-review', BOT);
  gh.addComment(17, renderState({ passes: 1, final: 'not_started', maxPasses: 3, stage: 'seed' }), BOT);
  const config = defaultConfig(`codex:\n  wait_minutes: ${waitMinutes}\n`);
  const ctx = fakeContext(gh, { config });
  await flows.reviewCycle(ctx, { pr: 17, origin });
  return { gh, config, ctx };
}

/** Deliver a Codex issue comment to the completion job, as the review workflow does. */
async function deliver({ gh, config }, comment, action = 'edited') {
  const ctx = fakeContext(gh, { config, event: { action, issue: { number: 17, pull_request: {} }, comment } });
  assert.equal(await flows.recordCodexCompletion(ctx, { pr: 17 }), 0);
  return ctx.outputs.values.result;
}

const state17 = (gh) => stateOf(gh, 17);
const summaryComment = (gh, options) => gh.addComment(17, codexSummary(options), CODEX);
const nonStateComments = (gh) => gh.issueComments(17).filter((c) => !c.body.startsWith('<!-- agent-review-state -->'));

test('completion: a summary edit for the awaited commit marks a clean review ready for human acceptance', async () => {
  const world = await awaitingWorld();
  const { gh } = world;
  const before = nonStateComments(gh).length;
  const pending = summaryComment(gh, { code: '⏳ **In progress**' });
  assert.equal(await deliver(world, pending), 'ignored');
  assert.equal(state17(gh).review.status, 'requested');

  pending.body = codexSummary(); // Codex edits its summary to "Completed"
  assert.equal(await deliver(world, pending), 'clean');
  const state = state17(gh);
  assert.deepEqual([state.passes, state.final], [1, 'not_started'], 'budget and final audit untouched');
  assert.deepEqual(state.review, { sha: CW, status: 'clean', origin: 'human-fix', requestedAt: state.review.requestedAt, requestId: state.review.requestId, completedAt: '2026-10-05T18:52:10Z' });
  assert.match(state.body, /\*\*Stage:\*\* Codex review completed with no actionable findings\.\n\*\*Codex review:\*\* Completed — no actionable findings\n\*\*Commit:\*\* `4d1c0e3`\n\*\*Requested:\*\* .*\n\*\*Completed:\*\* 2026-10-05 18:52 UTC/);
  assert.match(state.body, /Reported by Codex's review summary; no unresolved Codex findings remain\.\n\nWhen CI passes, this pull request is ready for human acceptance\./);
  assert.doesNotMatch(state.body, /approved/i);
  assert.equal(nonStateComments(gh).length, before + 1, 'only Codex\'s own comment was added; no bottom comment');
  assert.equal(gh.issueComments(17).filter((c) => c.body.startsWith('@codex review')).length, 1, 'no new review request');
  assert.ok(!gh.calls.some((c) => c.body?.query?.includes('resolveReviewThread')), 'nothing to resolve, nothing resolved');
});

test('completion: the clean-result comment completes the review just as well', async () => {
  const world = await awaitingWorld();
  assert.equal(await deliver(world, world.gh.addComment(17, cleanResult('4d1c0e3164'), CODEX), 'created'), 'clean');
  assert.match(state17(world.gh).body, /Reported by Codex's result comment/);
});

test('completion: duplicate signals for the same review are no-ops', async () => {
  const world = await awaitingWorld();
  const { gh } = world;
  assert.equal(await deliver(world, summaryComment(gh)), 'clean');
  const snapshot = { body: state17(gh).body, comments: gh.comments.length, writes: gh.calls.filter((c) => c.method !== 'GET').length };
  assert.equal(await deliver(world, gh.addComment(17, cleanResult(), CODEX), 'created'), 'duplicate');
  assert.equal(await deliver(world, summaryComment(gh)), 'duplicate');
  assert.equal(state17(gh).body, snapshot.body, 'state unchanged');
  assert.equal(gh.comments.length, snapshot.comments + 2, 'only the two Codex comments were added');
  assert.equal(gh.calls.filter((c) => c.method !== 'GET').length, snapshot.writes, 'no state writes, comments, reviews or thread changes');
});

test('completion: polling may record the clean result first; a later event changes nothing', async () => {
  const gh = new FakeGitHub();
  gh.addPull({ number: 17, head: { ref: 'feature/brand', sha: CW } });
  gh.labelEvent(17, 'agent-review', BOT);
  const config = defaultConfig('codex:\n  wait_minutes: 5\n');
  gh.onPoll = (g) => {
    if (!g.comments.some((c) => c.body.startsWith('Codex Review:'))) g.addComment(17, cleanResult(), CODEX);
  };
  const ctx = fakeContext(gh, { config });
  await flows.reviewCycle(ctx, { pr: 17, origin: 'remediation' });
  assert.equal(ctx.outputs.values.result, 'clean');
  const body = state17(gh).body;
  assert.equal(state17(gh).review.status, 'clean');
  assert.match(body, /Reported by the monitoring job/);
  gh.onPoll = null;
  assert.equal(await deliver({ gh, config }, summaryComment(gh)), 'duplicate');
  assert.equal(await deliver({ gh, config }, gh.comments.find((c) => c.body.startsWith('Codex Review:')), 'created'), 'duplicate');
  assert.equal(state17(gh).body, body);
});

test('completion: after the monitor window, the event still completes the review', async () => {
  const world = await awaitingWorld({ waitMinutes: 1 });
  const before = state17(world.gh);
  assert.match(before.body, /still running beyond the 1-minute monitor window; awaiting completion signal/);
  assert.match(before.body, /does not mean Codex failed/);
  assert.equal(before.review.status, 'requested');
  assert.equal(await deliver(world, summaryComment(world.gh)), 'clean');
});

test('completion: a signal for an older commit never overwrites the newer request', async () => {
  const world = await awaitingWorld();
  const { gh, ctx } = world;
  const newer = 'f00dfeed'.repeat(5);
  gh.pulls[17].head.sha = newer; // remediation pushed and re-requested review
  await flows.reviewCycle(ctx, { pr: 17, origin: 'remediation' });
  const body = state17(gh).body;
  assert.equal(await deliver(world, summaryComment(gh, { commit: '4d1c0e3' })), 'stale');
  assert.equal(await deliver(world, gh.addComment(17, cleanResult('4d1c0e3164'), CODEX), 'created'), 'stale');
  assert.equal(state17(gh).body, body);
  assert.deepEqual([state17(gh).review.sha, state17(gh).review.status], [newer, 'requested']);
  assert.equal(await deliver(world, summaryComment(gh, { commit: 'f00dfee' })), 'clean');
});

test('completion: a review of a commit that is no longer the head is recorded as outdated, not ready', async () => {
  const world = await awaitingWorld();
  world.gh.pulls[17].head.sha = 'b'.repeat(40); // pushed by hand after the request
  assert.equal(await deliver(world, summaryComment(world.gh)), 'outdated');
  const state = state17(world.gh);
  assert.equal(state.review.status, 'outdated');
  assert.match(state.body, /Codex review of 4d1c0e3 completed, but the pull request head has moved to bbbbbbb; not ready for human acceptance/);
  assert.doesNotMatch(state.body, /this pull request is ready for human acceptance/);
  assert.equal(await deliver(world, summaryComment(world.gh)), 'duplicate');
});

test('completion: without a recorded request (state from before this version) nothing is guessed', async () => {
  const gh = new FakeGitHub();
  gh.addPull({ number: 17, head: { ref: 'feature/brand', sha: CW } });
  gh.labelEvent(17, 'agent-review', BOT);
  const legacy = '<!-- agent-review-state -->\n<!-- passes=1 -->\n<!-- final=not_started -->\n### Agent review status\n\n**Stage:** Codex review after owner-requested fix requested.\n\nRequested for commit 4d1c0e3.';
  gh.addComment(17, legacy, BOT);
  assert.equal(await deliver({ gh, config: defaultConfig() }, summaryComment(gh)), 'unknown');
  assert.equal(state17(gh).body, legacy);
});

test('completion: a spoofed signal or an opted-out PR changes nothing', async () => {
  const world = await awaitingWorld();
  const { gh } = world;
  const body = state17(gh).body;
  assert.equal(await deliver(world, gh.addComment(17, codexSummary(), 'owner')), 'ignored');
  assert.equal(await deliver(world, gh.addComment(17, cleanResult(), 'chatgpt-codex-connector-fan'), 'created'), 'ignored');
  assert.equal(state17(gh).body, body);
  gh.pulls[17].labels = [];
  assert.equal(await deliver(world, summaryComment(gh)), 'ignored');
  assert.equal(state17(gh).body, body);
});

test('completion: unresolved findings from the awaited review are never reported clean', async () => {
  const world = await awaitingWorld();
  const { gh } = world;
  const review = gh.addReview(17, CODEX, '', { commit_id: CW });
  gh.threads[17] = [codexThreads(review.id).find((t) => t.id === 'PRRT_drift')];
  assert.equal(await deliver(world, summaryComment(gh)), 'findings');
  const state = state17(gh);
  assert.equal(state.review.status, 'findings');
  assert.equal(state.passes, 1);
  assert.match(state.body, /\*\*Stage:\*\* Codex review completed with actionable findings; awaiting automated remediation\./);
  assert.match(state.body, /\(1 unresolved finding thread\(s\)\); that review starts automated remediation/);
  assert.doesNotMatch(state.body, /ready for human acceptance/);
  assert.equal(gh.threads[17][0].isResolved, false);
  assert.ok(!gh.issueComments(17).some((c) => c.body.startsWith('@codex review') && c.id > review.id), 'no remediation or review started here');
});

test('completion: earlier unresolved Codex findings keep a clean-looking review from being ready', async () => {
  const world = await awaitingWorld();
  world.gh.threads[17] = codexThreads(1); // left open by an earlier review
  assert.equal(await deliver(world, world.gh.addComment(17, cleanResult(), CODEX), 'created'), 'findings');
  const state = state17(world.gh);
  assert.match(state.body, /Codex review completed without new findings, but 2 earlier unresolved Codex finding\(s\) remain; human input required/);
  assert.doesNotMatch(state.body, /ready for human acceptance/);
});

test('completion: findings review first, then the summary edit: remediation state is never overwritten', async () => {
  const world = await awaitingWorld({ origin: 'remediation' });
  const { gh } = world;
  gh.addComment(17, requestBody('remediation'), 'owner');
  const review = gh.addReview(17, CODEX, '', { commit_id: CW });
  gh.threads[17] = [codexThreads(review.id).find((t) => t.id === 'PRRT_drift')];
  const plan = fakeContext(gh, { config: world.config, event: { review: { id: review.id, commit_id: CW, submitted_at: '2026-10-05T18:51:00Z', body: '' } } });
  await flows.planRemediation(plan, { pr: 17 });
  assert.equal(plan.outputs.values.mode, 'remediate');
  const running = state17(gh);
  assert.match(running.body, /automated remediation pass 2\/3 is running/);
  assert.deepEqual([running.review.sha, running.review.status], [CW, 'findings']);

  assert.equal(await deliver(world, summaryComment(gh)), 'duplicate');
  assert.equal(state17(gh).body, running.body, 'still "remediation running"');
});

test('completion: summary edit first, then the findings review: the review still drives remediation', async () => {
  const world = await awaitingWorld({ origin: 'remediation' });
  const { gh } = world;
  gh.addComment(17, requestBody('remediation'), 'owner');
  const review = gh.addReview(17, CODEX, '', { commit_id: CW });
  gh.threads[17] = [codexThreads(review.id).find((t) => t.id === 'PRRT_drift')];
  assert.equal(await deliver(world, summaryComment(gh)), 'findings');
  assert.match(state17(gh).body, /awaiting automated remediation/);

  const plan = fakeContext(gh, { config: world.config, event: { review: { id: review.id, commit_id: CW, body: '' } } });
  await flows.planRemediation(plan, { pr: 17 });
  assert.deepEqual([plan.outputs.values.mode, plan.outputs.values.countable], ['remediate', 'true']);
  assert.match(state17(gh).body, /automated remediation pass 2\/3 is running/);
  assert.equal(state17(gh).passes, 1, 'the pass is consumed only by a verified fix, later');
});

test('completion: a summary marked completed before Codex submits its review is corrected by that review', async () => {
  // GitHub orders nothing between the two events; if the summary wins and no
  // findings exist yet, "clean" is recorded until the review event arrives.
  const world = await awaitingWorld({ origin: 'remediation' });
  const { gh } = world;
  gh.addComment(17, requestBody('remediation'), 'owner');
  assert.equal(await deliver(world, summaryComment(gh)), 'clean');
  const review = gh.addReview(17, CODEX, '', { commit_id: CW });
  const plan = fakeContext(gh, { config: world.config, event: { review: { id: review.id, commit_id: CW, body: '' } } });
  await flows.planRemediation(plan, { pr: 17 });
  assert.equal(plan.outputs.values.mode, 'remediate');
  const state = state17(gh);
  assert.equal(state.review.status, 'findings');
  assert.match(state.body, /automated remediation pass 2\/3 is running/);
  assert.doesNotMatch(state.body, /ready for human acceptance/);
});

test('completion: once automated review has ended, signals change nothing', async () => {
  const world = await awaitingWorld();
  const { gh } = world;
  const state = state17(gh);
  gh.comments.find((c) => c.id === gh.stateComments(17)[0].id).body = renderState({ passes: 3, final: 'running', review: state.review, maxPasses: 3, stage: 'audit running' });
  assert.equal(await deliver(world, summaryComment(gh)), 'finished');
  assert.match(state17(gh).body, /audit running/);
});

test('completion: /agent-fix ends the wait, so a late clean result cannot hide its outcome', async () => {
  const world = await awaitingWorld({ origin: 'remediation' });
  const { gh, config } = world;
  const fix = fakeContext(gh, { config });
  await flows.prepareHumanFix(fix, { pr: 17, actor: 'owner' });
  assert.equal(state17(gh).review, null, 'no review is awaited while the fix runs');
  await flows.finishHumanFix(fix, { ...claudeOk, pr: 17, headSha: CW, proceed: 'true', setupOutcome: 'success', rawResult: ok('blocked') });
  const blocked = state17(gh).body;
  assert.match(blocked, /Owner-requested fix is blocked; human input required/);
  assert.equal(await deliver(world, summaryComment(gh)), 'unknown');
  assert.equal(state17(gh).body, blocked);
});
