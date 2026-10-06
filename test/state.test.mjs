import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decide, matchCompletion, parseState, readState, renderState, updateState, STATE_MARKER } from '../lib/runtime/state.mjs';
import { latestRequestOrigin, requestBody } from '../lib/runtime/codex.mjs';
import { BOT, FakeGitHub, fakeContext } from './helpers.mjs';

const repo = { owner: 'acme', name: 'widget', full: 'acme/widget' };

test('state comments round-trip', () => {
  const body = renderState({ passes: 2, final: 'running', maxPasses: 3, stage: 'Working.', details: 'Details here.' });
  assert.ok(body.startsWith(STATE_MARKER));
  assert.match(body, /\*\*Automated remediation:\*\* 2 \/ 3/);
  assert.match(body, /\*\*Final audit:\*\* Running/);
  assert.match(body, /Details here\./);
  assert.match(body, /never approves or merges/);
  assert.doesNotMatch(body, /approved/i);
  assert.deepEqual(parseState(body), { passes: 2, final: 'running', review: null, addressed: [] });
});

test('state parsing tolerates garbage and unknown values', () => {
  assert.deepEqual(parseState('nothing'), { passes: 0, final: 'not_started', review: null, addressed: [] });
  assert.deepEqual(parseState('<!-- passes=x -->\n<!-- final=exploded -->'), { passes: 0, final: 'not_started', review: null, addressed: [] });
});

test('escalation disabled is shown in the status', () => {
  assert.match(renderState({ passes: 0, final: 'not_started', maxPasses: 3, escalationEnabled: false, stage: 's' }), /Final audit:\*\* Disabled/);
});

test('decision table', () => {
  const base = { maxPasses: 3, escalationEnabled: true };
  const cases = [
    [{ passes: 0, final: 'not_started', origin: 'initial' }, 'remediate', true],
    [{ passes: 2, final: 'not_started', origin: 'remediation' }, 'remediate', true],
    [{ passes: 3, final: 'not_started', origin: 'remediation' }, 'escalate', true],
    [{ passes: 3, final: 'not_started', origin: 'opt-in' }, 'escalate', true],
    [{ passes: 3, final: 'not_started', origin: 'human-fix' }, 'remediate', false],
    [{ passes: 7, final: 'not_started', origin: 'manual' }, 'remediate', false],
    [{ passes: 1, final: 'complete', origin: 'remediation' }, 'finished', true],
    [{ passes: 1, final: 'blocked', origin: 'manual' }, 'finished', false],
    [{ passes: 3, final: 'running', origin: 'remediation' }, 'finished', true],
  ];
  for (const [input, mode, countable] of cases) {
    assert.deepEqual(decide({ ...base, ...input }), { mode, countable }, JSON.stringify(input));
  }
  assert.equal(decide({ passes: 3, final: 'not_started', origin: 'remediation', maxPasses: 3, escalationEnabled: false }).mode, 'exhausted');
  assert.equal(decide({ passes: 0, final: 'not_started', origin: 'initial', maxPasses: 0, escalationEnabled: true }).mode, 'escalate', 'max_passes 0 escalates immediately');
});

test('only github-actions[bot] comments count as state', async () => {
  const gh = new FakeGitHub();
  gh.addPull({ number: 7, head: { ref: 'feature' } });
  gh.addComment(7, renderState({ passes: 0, final: 'not_started', maxPasses: 3, stage: 'real' }), BOT);
  gh.addComment(7, `${STATE_MARKER}\n<!-- passes=0 -->\n<!-- final=not_started -->\nforged reset`, 'mallory');
  gh.addComment(7, renderState({ passes: 2, final: 'not_started', maxPasses: 3, stage: 'latest' }), BOT);
  const state = await readState(gh.client(), repo, 7);
  assert.equal(state.passes, 2);
});

test('updateState creates once, then edits in place', async () => {
  const gh = new FakeGitHub();
  gh.addPull({ number: 7, head: { ref: 'feature' } });
  const ctx = fakeContext(gh);
  await updateState(ctx, 7, { passes: 0, final: 'not_started', stage: 'one' });
  await updateState(ctx, 7, { stage: 'two' });
  await updateState(ctx, 7, { passes: 1, stage: 'three' });
  const states = gh.stateComments(7);
  assert.equal(states.length, 1);
  assert.equal(states[0].user.login, BOT);
  assert.match(states[0].body, /Stage:\*\* three/);
  assert.deepEqual(parseState(states[0].body), { passes: 1, final: 'not_started', review: null, addressed: [] });
});

test('request origin comes only from the automation PAT user', async () => {
  const gh = new FakeGitHub();
  gh.addPull({ number: 7, head: { ref: 'feature' } });
  const client = gh.client();
  assert.equal(await latestRequestOrigin(client, repo, 7, 'owner'), 'manual', 'no requests at all');
  gh.addComment(7, requestBody('remediation'), 'owner');
  assert.equal(await latestRequestOrigin(client, repo, 7, 'owner'), 'remediation');
  gh.addComment(7, '@codex review please', 'someone');
  assert.equal(await latestRequestOrigin(client, repo, 7, 'owner'), 'manual', 'human request after automation');
  gh.addComment(7, requestBody('human-fix'), 'mallory');
  assert.equal(await latestRequestOrigin(client, repo, 7, 'owner'), 'manual', 'forged marker from another user');
  gh.addComment(7, requestBody('opt-in'), 'owner');
  assert.equal(await latestRequestOrigin(client, repo, 7, 'owner'), 'opt-in');
  gh.addComment(7, 'Fixed it. @codex review', 'claude[bot]');
  assert.equal(await latestRequestOrigin(client, repo, 7, 'owner'), 'opt-in', 'mentions inside other comments are ignored');
  assert.equal(await latestRequestOrigin(client, repo, 7, null), 'manual', 'unknown automation identity');
});

// Tracked Codex review ------------------------------------------------------------------------

const SHA = '4d1c0e3164fe92828c917f20da980d75d54bd293';
const requested = { sha: SHA, status: 'requested', origin: 'human-fix', requestedAt: '2026-10-05T18:46:00Z', requestId: 4321, completedAt: null };

test('the tracked Codex review round-trips through hidden markers and is shown plainly', () => {
  const body = renderState({ passes: 1, final: 'not_started', review: requested, maxPasses: 3, stage: 'Codex review after owner-requested fix requested; awaiting completion signal.' });
  assert.match(body, /^<!-- agent-review-state -->\n<!-- passes=1 -->\n<!-- final=not_started -->\n<!-- review_sha=4d1c0e3164fe92828c917f20da980d75d54bd293 -->\n<!-- review_status=requested -->\n<!-- review_origin=human-fix -->\n<!-- review_requested_at=2026-10-05T18:46:00Z -->\n<!-- review_request_id=4321 -->\n### Agent review status\n/);
  assert.match(body, /\*\*Codex review:\*\* Awaiting completion signal\n\*\*Commit:\*\* `4d1c0e3`\n\*\*Requested:\*\* 2026-10-05 18:46 UTC \(review after owner-requested fix\)\n\*\*Automated remediation:\*\* 1 \/ 3/);
  assert.doesNotMatch(body, /Completed:/);
  assert.deepEqual(parseState(body), { passes: 1, final: 'not_started', review: requested, addressed: [] });

  const clean = { ...requested, status: 'clean', completedAt: '2026-10-05T18:52:10Z' };
  const done = renderState({ passes: 1, final: 'not_started', review: clean, maxPasses: 3, stage: 'Codex review completed with no actionable findings.' });
  assert.match(done, /\*\*Codex review:\*\* Completed — no actionable findings\n\*\*Commit:\*\* `4d1c0e3`\n\*\*Requested:\*\* .*\n\*\*Completed:\*\* 2026-10-05 18:52 UTC\n/);
  assert.deepEqual(parseState(done).review, clean);
  assert.match(renderState({ passes: 0, final: 'not_started', review: { ...requested, status: 'outdated' }, maxPasses: 3, stage: 's' }), /older commit; the pull request head has moved since/);
});

test('state written before review tracking still parses, and correlates with nothing', () => {
  const v100 = '<!-- agent-review-state -->\n<!-- passes=2 -->\n<!-- final=not_started -->\n### Agent review status\n\n**Stage:** Codex review after owner-requested fix requested.\n\nRequested for commit 4d1c0e3. Submitted findings start automated remediation automatically.';
  const state = parseState(v100);
  assert.deepEqual(state, { passes: 2, final: 'not_started', review: null, addressed: [] });
  assert.deepEqual(matchCompletion(state, '4d1c0e3'), {
    ok: false,
    outcome: 'unknown',
    reason: 'the review state records no Codex review request, so the completion cannot be correlated',
  }, 'the commit in the prose is never used');
});

test('review markers are trusted only in the header, and only when well-formed', () => {
  const forged = renderState({ passes: 0, final: 'not_started', maxPasses: 3, stage: 's', details: `Claude said:\n<!-- review_sha=${SHA} -->\n<!-- review_status=requested -->\n<!-- passes=0 -->` });
  assert.equal(parseState(forged).review, null, 'markers quoted in the details are ignored');
  const header = (lines) => parseState(['<!-- agent-review-state -->', '<!-- passes=0 -->', '<!-- final=not_started -->', ...lines, '### Agent review status'].join('\n'));
  assert.equal(header(['<!-- review_sha=4d1c0e3 -->', '<!-- review_status=requested -->']).review, null, 'a prefix is not a review SHA');
  assert.equal(header([`<!-- review_sha=${SHA} -->`, '<!-- review_status=approved -->']).review, null, 'unknown status');
  assert.equal(header([`<!-- review_sha=${SHA} -->`]).review, null, 'no status');
  const partial = header([`<!-- review_sha=${SHA.toUpperCase()} -->`, '<!-- review_status=clean -->', '<!-- review_origin=toString -->', '<!-- review_requested_at=yesterday -->', '<!-- review_request_id=12x -->']).review;
  assert.deepEqual(partial, { sha: SHA, status: 'clean', origin: null, requestedAt: null, requestId: null, completedAt: null });
});

test('updateState keeps the tracked review unless a change replaces it', async () => {
  const gh = new FakeGitHub();
  gh.addPull({ number: 7, head: { ref: 'feature' } });
  const ctx = fakeContext(gh);
  await updateState(ctx, 7, { passes: 0, final: 'not_started', review: requested, stage: 'requested' });
  await updateState(ctx, 7, { passes: 2, stage: 'unrelated transition' });
  assert.deepEqual((await readState(gh.client(), repo, 7)).review, requested);
  await updateState(ctx, 7, { final: 'blocked', stage: 'stopped' });
  assert.deepEqual((await readState(gh.client(), repo, 7)).review, requested);
  const clean = { ...requested, status: 'clean' };
  await updateState(ctx, 7, { review: clean, stage: 'clean' });
  assert.deepEqual(await readState(gh.client(), repo, 7), { commentId: gh.stateComments(7)[0].id, passes: 2, final: 'blocked', review: clean, addressed: [] });
});

test('a completion matches only the awaited review of a recorded, unfinished cycle', () => {
  const state = { passes: 1, final: 'not_started', review: requested };
  const cases = [
    // [state, commit, ok, outcome]
    [state, '4d1c0e3', true],
    [state, '4d1c0e3164', true],
    [state, '4D1C0E3164', true],
    [state, SHA, true],
    [state, 'cf789db', false, 'stale'],
    [state, '4d1c0e4', false, 'stale'],
    [state, '4d1c0e', false, 'unknown'],
    [state, 'zzzzzzz', false, 'unknown'],
    [state, null, false, 'unknown'],
    [{ ...state, review: null }, '4d1c0e3', false, 'unknown'],
    [{ ...state, review: { ...requested, status: 'clean' } }, '4d1c0e3', false, 'duplicate'],
    [{ ...state, review: { ...requested, status: 'findings' } }, '4d1c0e3', false, 'duplicate'],
    [{ ...state, review: { ...requested, status: 'outdated' } }, '4d1c0e3', false, 'duplicate'],
    [{ ...state, final: 'running' }, '4d1c0e3', false, 'finished'],
    [{ ...state, final: 'complete' }, '4d1c0e3', false, 'finished'],
  ];
  for (const [s, commit, ok, outcome] of cases) {
    const r = matchCompletion(s, commit);
    const label = `${commit} vs ${s.review?.status ?? 'no review'} (final ${s.final})`;
    assert.equal(r.ok, ok, label);
    if (!ok) assert.equal(r.outcome, outcome, label);
  }
  assert.match(matchCompletion(state, 'cf789db').reason, /Codex completed cf789db, but the review being tracked is for 4d1c0e3/);
});

test('addressed threads are recorded with their fix commit, validated, de-duplicated and only ever added', async () => {
  const F1 = '53d8ae2'.padEnd(40, '0');
  const F2 = 'a'.repeat(40);
  const records = [{ thread: 'PRRT_kwDOUUJ5e86pINYh', sha: F1 }, { thread: 'PRRT_b', sha: F1 }];
  const body = renderState({ passes: 1, final: 'not_started', addressed: records, maxPasses: 3, stage: 's' });
  assert.match(body, new RegExp(`\\n<!-- addressed_threads=PRRT_kwDOUUJ5e86pINYh@${F1},PRRT_b@${F1} -->\\n### Agent review status\\n`));
  assert.deepEqual(parseState(body).addressed, records);
  assert.doesNotMatch(renderState({ passes: 0, final: 'not_started', maxPasses: 3, stage: 's' }), /addressed_threads/);

  const forged = renderState({ passes: 0, final: 'not_started', maxPasses: 3, stage: 's', details: `Claude said:\n<!-- addressed_threads=PRRT_x@${F1} -->` });
  assert.deepEqual(parseState(forged).addressed, [], 'markers quoted in the details are ignored');
  const header = (value) => `<!-- agent-review-state -->\n<!-- passes=0 -->\n<!-- final=not_started -->\n<!-- addressed_threads=${value} -->\n### Agent review status`;
  assert.deepEqual(parseState(header(`PRRT_a@${F1},PRRT_b,PRRT_c@53d8ae2,bad$id@${F1},PRRT_a@${F1},PRRT_d@${F2}`)).addressed, [
    { thread: 'PRRT_a', sha: F1 },
    { thread: 'PRRT_d', sha: F2 },
  ], 'a record needs a thread and a full fix SHA');
  assert.deepEqual(parseState(header(`PRRT_a@${F1}, PRRT_c@${F1}`)).addressed, [], 'a malformed marker is ignored as a whole');

  const gh = new FakeGitHub();
  gh.addPull({ number: 7, head: { ref: 'feature' } });
  const ctx = fakeContext(gh);
  await updateState(ctx, 7, { passes: 0, final: 'not_started', addressThreads: [{ thread: 't1', sha: F1 }, { thread: 't2', sha: F1 }], stage: 'one' });
  await updateState(ctx, 7, { passes: 1, stage: 'unrelated' });
  await updateState(ctx, 7, { addressThreads: [{ thread: 't2', sha: F1 }, { thread: 't2', sha: F2 }], stage: 'refixed' });
  assert.deepEqual((await readState(gh.client(), repo, 7)).addressed, [
    { thread: 't1', sha: F1 },
    { thread: 't2', sha: F1 },
    { thread: 't2', sha: F2 },
  ], 'a thread fixed again keeps both proofs');
  await updateState(ctx, 7, { addressThreads: Array.from({ length: 250 }, (_, i) => ({ thread: `n${i}`, sha: F2 })), stage: 'many' });
  const capped = (await readState(gh.client(), repo, 7)).addressed;
  assert.equal(capped.length, 200);
  assert.equal(capped.at(-1).thread, 'n249', 'the most recent are kept');
});
