import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMAS } from '../lib/runtime/prompts.mjs';
import { headMoved, parseResult, verifyWriteResult } from '../lib/runtime/results.mjs';

const raw = (status) => JSON.stringify({ status, summary: 's', validation: 'v' });

test('write-session schemas accept exactly their documented statuses', () => {
  const expected = {
    implement: ['implemented', 'blocked', 'no_change'],
    remediate: ['fixed', 'blocked', 'no_change'],
    'human-fix': ['fixed', 'blocked', 'no_change'],
    'final-fix': ['fixed', 'blocked', 'no_change'],
  };
  for (const [kind, statuses] of Object.entries(expected)) {
    assert.deepEqual(SCHEMAS[kind].properties.status.enum, statuses, kind);
    for (const status of statuses) {
      const result = parseResult(kind, raw(status));
      assert.equal(result.ok, true, `${kind} accepts ${status}`);
      assert.equal(result.status, status);
    }
    for (const status of ['done', 'clean', 'FIXED', '', null, 'fixed ']) {
      const result = parseResult(kind, raw(status));
      assert.equal(result.ok, false, `${kind} rejects ${JSON.stringify(status)}`);
      assert.match(result.error, /unexpected status/);
    }
  }
  assert.equal(parseResult('implement', raw('fixed')).ok, false, 'implementation does not report fixed');
  assert.equal(parseResult('remediate', raw('implemented')).ok, false, 'remediation does not report implemented');
});

test('head movement is unknown unless both SHAs are known', () => {
  assert.equal(headMoved('a', 'b'), true);
  assert.equal(headMoved('a', 'a'), false);
  assert.equal(headMoved('', 'a'), null);
  assert.equal(headMoved('a', undefined), null);
});

test('a write status is accepted only when the branch agrees with it', () => {
  const cases = [
    // [status, moved, ok, error]
    ['fixed', true, true],
    ['fixed', false, false, /^Claude returned `fixed`, but no commit was pushed to `feature\/x`\.$/],
    ['fixed', null, false, /could not confirm that a commit was pushed/],
    ['implemented', true, true],
    ['implemented', false, false, /^Claude returned `implemented`, but no commit was pushed/],
    ['implemented', null, false, /could not confirm/],
    ['no_change', false, true],
    ['no_change', true, false, /^Claude returned `no_change`, but commits were pushed to `feature\/x`\.$/],
    ['no_change', null, false, /could not confirm that nothing was pushed/],
    ['blocked', false, true],
    ['blocked', true, true],
    ['blocked', null, true],
  ];
  for (const [status, moved, ok, error] of cases) {
    const result = verifyWriteResult({ status, moved, branch: 'feature/x' });
    assert.equal(result.ok, ok, `${status}, moved=${moved}`);
    if (error) assert.match(result.error, error, `${status}, moved=${moved}`);
  }
  assert.equal(verifyWriteResult({ status: 'fixed', moved: false }).error, 'Claude returned `fixed`, but no commit was pushed.');
});
