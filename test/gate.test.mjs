import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkOptedIn,
  checkPullRequest,
  checkTrusted,
  gateHumanFix,
  gateImplement,
  gateReview,
  loadRepoConfig,
  parseCommand,
} from '../lib/runtime/gate.mjs';
import { renderState } from '../lib/runtime/state.mjs';
import { BOT, CODEX, FakeGitHub, cleanResult, codexSummary, defaultConfig, user } from './helpers.mjs';

const repo = { owner: 'acme', name: 'widget', full: 'acme/widget' };

function world() {
  const gh = new FakeGitHub();
  gh.permissions = { owner: 'admin', writer: 'write', reader: 'read', exowner: 'none' };
  return gh;
}

const cfg = (extra = '') => defaultConfig(extra);

test('trust requires both the config list and write access', async () => {
  const gh = world();
  const c = defaultConfig('', { defaultBranch: 'main', owner: 'owner', ownerType: 'User' });
  c.trusted_users = ['owner', 'reader', 'exowner', 'ghost'];
  assert.deepEqual(await checkTrusted(gh.client(), repo, c, 'owner'), { trusted: true });
  assert.deepEqual(await checkTrusted(gh.client(), repo, c, 'OWNER'), { trusted: true }, 'case-insensitive list match');
  assert.match((await checkTrusted(gh.client(), repo, c, 'writer')).reason, /not listed/);
  assert.match((await checkTrusted(gh.client(), repo, c, 'reader')).reason, /does not have write access/);
  assert.match((await checkTrusted(gh.client(), repo, c, 'exowner')).reason, /does not have write access/);
  assert.match((await checkTrusted(gh.client(), repo, c, 'ghost')).reason, /could not verify/, 'API failure fails closed');
  assert.match((await checkTrusted(gh.client(), repo, c, undefined)).reason, /unknown/);
});

test('command parsing', () => {
  assert.deepEqual(parseCommand('/agent-fix please rename X\nand Y'), { command: '/agent-fix', argument: 'please rename X\nand Y' });
  assert.deepEqual(parseCommand('  /agent-review'), { command: '/agent-review', argument: '' });
  assert.equal(parseCommand('/agent-fixes stuff').command, '/agent-fixes');
  assert.equal(parseCommand('please /agent-fix').command, null);
  assert.equal(parseCommand(null).command, null);
});

test('loads and resolves config from the default branch', async () => {
  const gh = world();
  gh.files['trunk:.github/agent/config.yml'] = 'version: 1\ncodex:\n  wait_minutes: 5\n';
  const event = { repository: { default_branch: 'trunk', owner: { login: 'owner', type: 'User' } } };
  const { config: c } = await loadRepoConfig(gh.client(), repo, event);
  assert.equal(c.base_branch, 'trunk');
  assert.equal(c.default_branch, 'trunk');
  assert.deepEqual(c.trusted_users, ['owner']);
  assert.equal(c.codex.job_timeout_minutes, 15);
  await assert.rejects(loadRepoConfig(gh.client(), repo, { repository: { default_branch: 'main', owner: {} } }), /was not found on the default branch/);
  gh.files['main:.github/agent/config.yml'] = 'nope: 1\n';
  await assert.rejects(loadRepoConfig(gh.client(), repo, { repository: { default_branch: 'main', owner: { login: 'acme', type: 'Organization' } } }), /unknown setting "nope"/);
});

// Path A -----------------------------------------------------------------------------

const issueEvent = (action, issue, extra = {}) => ({
  action,
  issue: { number: 5, state: 'open', title: '[agent-build] Add thing', body: 'contract', labels: [], user: { login: 'owner' }, ...issue },
  sender: { login: issue?.user?.login ?? 'owner' },
  ...extra,
});

test('implement: [agent-build] issue opened by a trusted user', async () => {
  const d = await gateImplement({ client: world().client(), repo, config: cfg(), event: issueEvent('opened') });
  assert.equal(d.action, 'implement');
  assert.equal(d.issueNumber, 5);
});

test('implement: ordinary issues and other labels never trigger', async () => {
  const client = world().client();
  assert.equal((await gateImplement({ client, repo, config: cfg(), event: issueEvent('opened', { title: 'Bug report' }) })).action, 'none');
  assert.equal((await gateImplement({ client, repo, config: cfg(), event: issueEvent('labeled', {}, { label: { name: 'bug' } }) })).action, 'none');
  assert.equal((await gateImplement({ client, repo, config: cfg(), event: issueEvent('edited') })).action, 'none');
  assert.equal((await gateImplement({ client, repo, config: cfg(), event: issueEvent('opened', { pull_request: {} }) })).action, 'none');
});

test('implement: untrusted authors are ignored silently on open', async () => {
  const d = await gateImplement({ client: world().client(), repo, config: cfg(), event: issueEvent('opened', { user: { login: 'stranger' } }) });
  assert.equal(d.action, 'none');
  assert.equal(d.refusal, undefined);
});

test('implement: opened with the label defers to the labeled event (no double run)', async () => {
  const d = await gateImplement({ client: world().client(), repo, config: cfg(), event: issueEvent('opened', { labels: [{ name: 'agent-build' }] }) });
  assert.equal(d.action, 'none');
  assert.match(d.reason, /labeled event starts the run/);
});

test('implement: label path checks both labeler and author, and explains refusals', async () => {
  const client = world().client();
  const c = cfg();
  c.trusted_users = ['owner', 'reader'];
  const ok = await gateImplement({ client, repo, config: c, event: issueEvent('labeled', { title: 'No prefix needed' }, { label: { name: 'agent-build' }, sender: { login: 'owner' } }) });
  assert.equal(ok.action, 'implement');

  const badLabeler = await gateImplement({ client, repo, config: c, event: issueEvent('labeled', {}, { label: { name: 'agent-build' }, sender: { login: 'reader' } }) });
  assert.equal(badLabeler.action, 'none');
  assert.equal(badLabeler.refusal.notify, true);
  assert.match(badLabeler.refusal.message, /label must be applied by a trusted user/);

  const badAuthor = await gateImplement({ client, repo, config: c, event: issueEvent('labeled', { user: { login: 'stranger' } }, { label: { name: 'agent-build' }, sender: { login: 'owner' } }) });
  assert.match(badAuthor.refusal.message, /issue author must be a trusted user/);

  const closed = await gateImplement({ client, repo, config: c, event: issueEvent('labeled', { state: 'closed' }, { label: { name: 'agent-build' }, sender: { login: 'owner' } }) });
  assert.match(closed.refusal.message, /is not open/);
});

// PR eligibility -----------------------------------------------------------------------

test('PR eligibility: same-repo, open, not base/default, not protected', async () => {
  const gh = world();
  gh.addPull({ number: 1, head: { ref: 'feature' } });
  gh.addPull({ number: 2, head: { ref: 'fork-branch', repo: { full_name: 'mallory/widget' } } });
  gh.addPull({ number: 3, head: { ref: 'feature-3' }, state: 'closed', merged: true });
  gh.addPull({ number: 4, head: { ref: 'main' }, base: { ref: 'release' } });
  gh.addPull({ number: 5, head: { ref: 'locked' } });
  gh.branches.locked = { protected: true };
  gh.addPull({ number: 6, head: { ref: 'deleted' } });
  delete gh.branches.deleted;
  gh.addPull({ number: 8, head: { ref: 'forkless', repo: null } });
  const client = gh.client();
  const c = cfg();
  assert.equal((await checkPullRequest(client, repo, c, 1)).eligible, true);
  const fork = await checkPullRequest(client, repo, c, 2);
  assert.equal(fork.eligible, false);
  assert.equal(fork.fork, true);
  assert.match((await checkPullRequest(client, repo, c, 3)).reason, /merged/);
  assert.match((await checkPullRequest(client, repo, c, 4)).reason, /base\/default branch/);
  assert.match((await checkPullRequest(client, repo, c, 5)).reason, /protected/);
  assert.match((await checkPullRequest(client, repo, c, 6)).reason, /no longer exists/);
  assert.match((await checkPullRequest(client, repo, c, 8)).reason, /fork/);
});

test('opt-in requires the label applied by a trusted user or the automation', async () => {
  const gh = world();
  const client = gh.client();
  const c = cfg();
  const pr = gh.addPull({ number: 1, head: { ref: 'feature' } });
  assert.match((await checkOptedIn(client, repo, c, pr)).reason, /does not carry/);
  gh.labelEvent(1, 'agent-review', 'owner');
  assert.deepEqual(await checkOptedIn(client, repo, c, pr), { optedIn: true, by: 'owner' });
  gh.labelEvent(1, 'agent-review', 'reader');
  assert.match((await checkOptedIn(client, repo, c, pr)).reason, /untrusted user/, 'latest application wins');
  gh.labelEvent(1, 'agent-review', BOT);
  assert.deepEqual(await checkOptedIn(client, repo, c, pr), { optedIn: true, by: BOT });
});

// Review gate ------------------------------------------------------------------------------

function reviewWorld() {
  const gh = world();
  gh.addPull({ number: 9, head: { ref: 'claude/issue-5-add-thing' } });
  gh.addPull({ number: 10, head: { ref: 'human/feature' } });
  return gh;
}

const codexReview = (number, who = CODEX) => ({ eventName: 'pull_request_review', event: { review: { user: typeof who === 'string' ? user(who) : who }, pull_request: { number } } });

test('review: Codex reviews remediate only opted-in PRs, whatever created them', async () => {
  const gh = reviewWorld();
  const client = gh.client();
  assert.equal((await gateReview({ client, repo, config: cfg(), ...codexReview(9) })).action, 'none', 'automated branch alone is not enough');
  gh.labelEvent(9, 'agent-review', BOT);
  gh.labelEvent(10, 'agent-review', 'owner');
  assert.equal((await gateReview({ client, repo, config: cfg(), ...codexReview(9) })).action, 'remediate');
  assert.equal((await gateReview({ client, repo, config: cfg(), ...codexReview(10) })).action, 'remediate');
  assert.equal((await gateReview({ client, repo, config: cfg(), ...codexReview(10, 'human-reviewer') })).action, 'none');
});

test('review: only the Codex bot account starts remediation, not look-alike accounts', async () => {
  const gh = reviewWorld();
  gh.labelEvent(10, 'agent-review', 'owner');
  const client = gh.client();
  const impostors = [
    { login: 'chatgpt-codex-connector-x', type: 'User' }, // anyone can register this
    { login: 'chatgpt-codex-connector', type: 'User' },
    { login: 'chatgpt-codex-connector[bot]', type: 'User' },
    { login: 'chatgpt-codex-connector-evil[bot]', type: 'Bot' }, // another app
    { login: 'CHATGPT-CODEX-CONNECTOR' },
    null, // no user at all
  ];
  for (const who of impostors) {
    const d = await gateReview({ client, repo, config: cfg(), ...codexReview(10, who) });
    assert.equal(d.action, 'none', JSON.stringify(who));
    assert.match(d.reason, /was not submitted by the Codex bot/);
    assert.equal(d.refusal, undefined, 'no reply');
  }
  assert.equal((await gateReview({ client, repo, config: cfg(), ...codexReview(10, { login: 'ChatGPT-Codex-Connector[bot]', type: 'Bot' }) })).action, 'remediate', 'logins are case-insensitive');
});

test('review: Codex reviews on forks and closed PRs are ignored without comments', async () => {
  const gh = reviewWorld();
  gh.addPull({ number: 11, head: { ref: 'x', repo: { full_name: 'mallory/widget' } }, labels: [{ name: 'agent-review' }] });
  const d = await gateReview({ client: gh.client(), repo, config: cfg(), ...codexReview(11) });
  assert.equal(d.action, 'none');
  assert.equal(d.refusal, undefined);
});

test('review: label opt-in by a trusted user starts a cycle', async () => {
  const d = await gateReview({
    client: reviewWorld().client(),
    repo,
    config: cfg(),
    eventName: 'pull_request',
    event: { action: 'labeled', label: { name: 'agent-review' }, pull_request: { number: 10 }, sender: { login: 'owner' } },
  });
  assert.deepEqual([d.action, d.prNumber, d.actor, d.via], ['start', 10, 'owner', 'label']);
});

test('review: label from an untrusted user is removed and explained', async () => {
  const c = cfg();
  c.trusted_users = ['owner'];
  const d = await gateReview({
    client: reviewWorld().client(),
    repo,
    config: c,
    eventName: 'pull_request',
    event: { action: 'labeled', label: { name: 'agent-review' }, pull_request: { number: 10 }, sender: { login: 'writer' } },
  });
  assert.equal(d.action, 'none');
  assert.equal(d.refusal.removeLabel, 'agent-review');
  assert.equal(d.refusal.notify, true);
  assert.match(d.refusal.message, /The label has been removed/);
});

test('review: /agent-review from trusted users; strangers get no reply', async () => {
  const client = reviewWorld().client();
  const comment = (login, body = '/agent-review') => ({ eventName: 'issue_comment', event: { issue: { number: 10, pull_request: {} }, comment: { body, user: { login } } } });
  const ok = await gateReview({ client, repo, config: cfg(), ...comment('owner') });
  assert.deepEqual([ok.action, ok.via], ['start', 'command']);
  const stranger = await gateReview({ client, repo, config: cfg(), ...comment('stranger') });
  assert.equal(stranger.action, 'none');
  assert.equal(stranger.refusal.notify, false);
  assert.equal((await gateReview({ client, repo, config: cfg(), ...comment('owner', '/agent-reviewer') })).action, 'none');
  assert.equal(
    (await gateReview({ client, repo, config: cfg(), eventName: 'issue_comment', event: { issue: { number: 3 }, comment: { body: '/agent-review', user: { login: 'owner' } } } })).action,
    'none',
    'comments on plain issues are ignored',
  );
});

test('review: an edited /agent-review comment is not a new command', async () => {
  const client = reviewWorld().client();
  const comment = (action) => ({ eventName: 'issue_comment', event: { action, issue: { number: 10, pull_request: {} }, comment: { body: '/agent-review', user: user('owner') } } });
  assert.equal((await gateReview({ client, repo, config: cfg(), ...comment('created') })).action, 'start');
  const edited = await gateReview({ client, repo, config: cfg(), ...comment('edited') });
  assert.equal(edited.action, 'none');
  assert.equal(edited.refusal, undefined);
});

test('review: trusted opt-in on an ineligible PR is explained', async () => {
  const gh = reviewWorld();
  gh.addPull({ number: 12, head: { ref: 'x', repo: { full_name: 'mallory/widget' } } });
  const d = await gateReview({ client: gh.client(), repo, config: cfg(), eventName: 'issue_comment', event: { issue: { number: 12, pull_request: {} }, comment: { body: '/agent-review', user: { login: 'owner' } } } });
  assert.equal(d.action, 'none');
  assert.equal(d.refusal.notify, true);
  assert.match(d.refusal.message, /fork/);
});

// Human fix gate ---------------------------------------------------------------------------

test('human-fix: trusted user on an eligible PR', async () => {
  const client = reviewWorld().client();
  const event = (login, number = 10) => ({ issue: { number, pull_request: {} }, comment: { body: '/agent-fix rename foo', user: { login } } });
  const ok = await gateHumanFix({ client, repo, config: cfg(), event: event('owner') });
  assert.deepEqual([ok.action, ok.prNumber, ok.actor], ['fix', 10, 'owner']);
  const stranger = await gateHumanFix({ client, repo, config: cfg(), event: event('stranger') });
  assert.equal(stranger.action, 'none');
  assert.equal(stranger.refusal.notify, false);
  assert.equal((await gateHumanFix({ client, repo, config: cfg(), event: { issue: { number: 10, pull_request: {} }, comment: { body: 'thanks!', user: { login: 'owner' } } } })).action, 'none');
});

test('human-fix: refuses protected or base branches with an explanation', async () => {
  const gh = reviewWorld();
  gh.branches['human/feature'].protected = true;
  const d = await gateHumanFix({ client: gh.client(), repo, config: cfg(), event: { issue: { number: 10, pull_request: {} }, comment: { body: '/agent-fix x', user: { login: 'owner' } } } });
  assert.equal(d.action, 'none');
  assert.match(d.refusal.message, /protected/);
});

// Codex completion signals -----------------------------------------------------------------

const SHA = '4d1c0e3164fe92828c917f20da980d75d54bd293';

function completionWorld({ review = { status: 'requested' }, labelBy = BOT } = {}) {
  const gh = reviewWorld();
  if (labelBy) gh.labelEvent(10, 'agent-review', labelBy);
  const tracked = review && { sha: SHA, origin: 'human-fix', requestedAt: '2026-10-05T18:46:00Z', requestId: 77, completedAt: null, ...review };
  gh.addComment(10, renderState({ passes: 1, final: 'not_started', review: tracked, maxPasses: 3, stage: 'seed' }), BOT);
  return gh;
}

const codexComment = (body, { login = CODEX, action = 'edited', number = 10 } = {}) => ({
  eventName: 'issue_comment',
  event: { action, issue: { number, pull_request: {} }, comment: { id: 555, body, user: typeof login === 'string' ? user(login) : login, updated_at: '2026-10-05T18:52:30Z' } },
});

test('completion: a Codex summary edit or clean result for the awaited commit records the completion', async () => {
  const client = completionWorld().client();
  const summary = await gateReview({ client, repo, config: cfg(), ...codexComment(codexSummary()) });
  assert.deepEqual([summary.action, summary.prNumber], ['complete', 10]);
  assert.equal(summary.refusal, undefined);
  const clean = await gateReview({ client, repo, config: cfg(), ...codexComment(cleanResult(), { action: 'created' }) });
  assert.equal(clean.action, 'complete');
});

test('completion: the same text from anyone but the Codex bot is ignored without a reply', async () => {
  const client = completionWorld().client();
  for (const login of ['owner', 'dependabot[bot]', { login: 'chatgpt-codex-connector-fan', type: 'User' }, { login: 'chatgpt-codex-connector-evil[bot]', type: 'Bot' }]) {
    for (const body of [codexSummary(), cleanResult()]) {
      const d = await gateReview({ client, repo, config: cfg(), ...codexComment(body, { login, action: 'created' }) });
      assert.equal(d.action, 'none', JSON.stringify(login));
      assert.equal(d.refusal, undefined);
      assert.match(d.reason, /is not the Codex bot/);
    }
  }
});

test('completion: unfinished, uncorrelated or redundant signals start no job', async () => {
  const cases = [
    [completionWorld(), codexSummary({ code: '⏳ **In progress**' }), /not completed/],
    [completionWorld(), 'Codex is reviewing this pull request.', /not a Codex clean-result comment/],
    [completionWorld(), codexSummary({ commit: 'cf789db' }), /the review being tracked is for 4d1c0e3/],
    [completionWorld({ review: null }), codexSummary(), /records no Codex review request/],
    [completionWorld({ review: { status: 'clean' } }), codexSummary(), /already recorded as clean/],
    [completionWorld({ review: { status: 'findings' } }), cleanResult(), /already recorded as findings/],
    [completionWorld({ labelBy: null }), codexSummary(), /does not carry the agent-review label/],
    [completionWorld({ labelBy: 'reader' }), codexSummary(), /untrusted user/],
  ];
  for (const [gh, body, reason] of cases) {
    const d = await gateReview({ client: gh.client(), repo, config: cfg(), ...codexComment(body) });
    assert.equal(d.action, 'none', String(reason));
    assert.match(d.reason, reason);
  }
  const fork = completionWorld();
  fork.addPull({ number: 12, head: { ref: 'x', repo: { full_name: 'mallory/widget' } }, labels: [{ name: 'agent-review' }] });
  assert.match((await gateReview({ client: fork.client(), repo, config: cfg(), ...codexComment(codexSummary(), { number: 12 }) })).reason, /fork/);
  const plainIssue = await gateReview({ client: fork.client(), repo, config: cfg(), eventName: 'issue_comment', event: { action: 'edited', issue: { number: 3 }, comment: { body: codexSummary(), user: user(CODEX) } } });
  assert.match(plainIssue.reason, /not on a pull request/);
});

test('completion: a formal Codex review of the awaited commit leaves the next step to that review', async () => {
  const gh = completionWorld();
  gh.addReview(10, CODEX, 'findings', { commit_id: SHA, submitted_at: '2026-10-05T18:40:00Z' });
  assert.equal((await gateReview({ client: gh.client(), repo, config: cfg(), ...codexComment(codexSummary()) })).action, 'complete', 'a review from before the request does not count');
  gh.addReview(10, CODEX, 'findings', { commit_id: SHA, submitted_at: '2026-10-05T18:51:00Z' });
  const d = await gateReview({ client: gh.client(), repo, config: cfg(), ...codexComment(codexSummary()) });
  assert.equal(d.action, 'none');
  assert.match(d.reason, /that review drives remediation/);
});
