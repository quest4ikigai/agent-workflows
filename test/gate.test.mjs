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
import { BOT, CODEX, FakeGitHub, defaultConfig } from './helpers.mjs';

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

const codexReview = (number, login = CODEX) => ({ eventName: 'pull_request_review', event: { review: { user: { login } }, pull_request: { number } } });

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
