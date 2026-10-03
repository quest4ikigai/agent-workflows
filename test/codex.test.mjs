import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countCodexReviews, requestCodexReview, resolveCodexThreads, waitForCodex } from '../lib/runtime/codex.mjs';
import { CODEX, FakeGitHub } from './helpers.mjs';

const repo = { owner: 'acme', name: 'widget', full: 'acme/widget' };

function setup() {
  const gh = new FakeGitHub();
  gh.addPull({ number: 7, head: { ref: 'feature' } });
  gh.addReview(7, CODEX);
  gh.addReview(7, 'human-reviewer');
  return gh;
}

async function wait(gh, request, extra = {}) {
  let t = 0;
  return waitForCodex({
    client: gh.client('pat-token'),
    repo,
    pr: 7,
    ...request,
    timeoutMs: 5000,
    pollMs: 1000,
    sleep: async () => {},
    now: () => (t += 500),
    ...extra,
  });
}

test('request posts "@codex review" with the PAT and records the baseline first', async () => {
  const gh = setup();
  const request = await requestCodexReview({ client: gh.client(), agentClient: gh.client('pat-token'), repo, pr: 7, origin: 'initial' });
  assert.equal(request.baseline, 1, 'only Codex reviews are counted');
  const posted = gh.issueComments(7).at(-1);
  assert.equal(posted.user.login, 'owner');
  assert.equal(posted.body, '@codex review\n<!-- agent-review-request origin=initial -->');
  assert.equal(request.requestId, posted.id);
});

test('a new Codex review means findings', async () => {
  const gh = setup();
  const request = await requestCodexReview({ client: gh.client(), agentClient: gh.client('pat-token'), repo, pr: 7, origin: 'initial' });
  let polls = 0;
  gh.onPoll = (g) => {
    if (++polls === 2) g.addReview(7, CODEX);
  };
  assert.equal(await wait(gh, request), 'findings');
  assert.equal(await countCodexReviews(gh.client(), repo, 7), 2);
});

test('a 👍 reaction from Codex on the request means clean', async () => {
  const gh = setup();
  const request = await requestCodexReview({ client: gh.client(), agentClient: gh.client('pat-token'), repo, pr: 7, origin: 'initial' });
  gh.reactions[request.requestId] = [{ user: { login: 'someone' }, content: '+1' }];
  assert.equal(await wait(gh, request), 'pending', 'reactions from others do not count');
  gh.reactions[request.requestId].push({ user: { login: CODEX }, content: '+1' });
  assert.equal(await wait(gh, request), 'clean');
});

test('a "didn\'t find any major issues" comment after the request means clean', async () => {
  const gh = setup();
  gh.addComment(7, "Codex Review: Didn't find any major issues. Old one.", CODEX);
  const request = await requestCodexReview({ client: gh.client(), agentClient: gh.client('pat-token'), repo, pr: 7, origin: 'initial' });
  assert.equal(await wait(gh, request), 'pending', 'clean comments before the request are ignored');
  gh.addComment(7, "Didn't find any major issues", 'impostor');
  assert.equal(await wait(gh, request), 'pending', 'only Codex counts');
  gh.addComment(7, "Codex Review: Didn't find any major issues. Swish!", CODEX);
  assert.equal(await wait(gh, request), 'clean');
});

test('times out as pending and emits heartbeats', async () => {
  const gh = setup();
  const request = await requestCodexReview({ client: gh.client(), agentClient: gh.client('pat-token'), repo, pr: 7, origin: 'initial' });
  const beats = [];
  assert.equal(await wait(gh, request, { heartbeatMs: 1000, log: (m) => beats.push(m) }), 'pending');
  assert.ok(beats.length > 0);
  assert.match(beats[0], /Codex review still running/);
});

test('resolves only unresolved threads Codex took part in', async () => {
  const gh = setup();
  gh.threads[7] = [
    { id: 't1', isResolved: false, authors: [CODEX, 'owner'] },
    { id: 't2', isResolved: false, authors: ['human-reviewer'] },
    { id: 't3', isResolved: true, authors: [CODEX] },
  ];
  const logs = [];
  const r = await resolveCodexThreads(gh.client(), repo, 7, (m) => logs.push(m));
  assert.deepEqual(r, { resolved: 1, failed: 0 });
  assert.deepEqual(gh.threads[7].map((t) => t.isResolved), [true, false, true]);
});

test('thread resolution failures are reported, never thrown', async () => {
  const client = { graphql: async () => { throw new Error('forbidden'); } };
  const logs = [];
  const r = await resolveCodexThreads(client, repo, 7, (m) => logs.push(m));
  assert.equal(r.resolved, 0);
  assert.match(logs[0], /could not list review threads/);
});
