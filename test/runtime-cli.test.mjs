// Runs lib/runtime/main.mjs as the workflows do: inputs via env, results via $GITHUB_OUTPUT.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Outputs } from '../lib/runtime/actions.mjs';
import { cleanupTemp, defaultConfig, tempDir } from './helpers.mjs';

after(cleanupTemp);

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib/runtime/main.mjs');

/** Parse a $GITHUB_OUTPUT file (name=value and name<<DELIM blocks). */
function parseOutputs(text) {
  const out = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heredoc = lines[i].match(/^([a-z_]+)<<(.+)$/);
    if (heredoc) {
      const end = lines.indexOf(heredoc[2], i + 1);
      out[heredoc[1]] = lines.slice(i + 1, end).join('\n');
      i = end;
    } else if (lines[i].includes('=')) {
      const idx = lines[i].indexOf('=');
      out[lines[i].slice(0, idx)] = lines[i].slice(idx + 1);
    }
  }
  return out;
}

function runMain(args, { event, env = {} }) {
  const dir = tempDir();
  const eventPath = path.join(dir, 'event.json');
  const outputPath = path.join(dir, 'output');
  writeFileSync(eventPath, JSON.stringify(event));
  writeFileSync(outputPath, '');
  const r = spawnSync(process.execPath, [MAIN, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GITHUB_REPOSITORY: 'acme/widget',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: 'issues',
      GITHUB_OUTPUT: outputPath,
      GITHUB_WORKSPACE: dir,
      GITHUB_RUN_ID: '1',
      ...env,
    },
  });
  return { ...r, outputs: parseOutputs(readFileSync(outputPath, 'utf8')) };
}

test('prompt command writes multi-line prompt and claude_args outputs', () => {
  const hostile = 'Contract\nAW_EOF_x\nEOF\nname=value';
  const r = runMain(['prompt', 'implement'], {
    event: { issue: { number: 4, title: '[agent-build] T', body: hostile } },
    env: { AW_CONFIG: JSON.stringify(defaultConfig()), WORK_BRANCH: 'claude/issue-4-t' },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.outputs.prompt, /issue #4/);
  assert.match(r.outputs.prompt, /You are on `claude\/issue-4-t`/);
  assert.ok(r.outputs.prompt.includes(hostile), 'user text survives intact inside the heredoc');
  assert.match(r.outputs.claude_args, /^--model sonnet\n--max-turns 40\n/);
});

test('remediation prompt carries the collected Codex findings from CODEX_FINDINGS, even with an empty review body', () => {
  const findings = { findings: [{ thread: 'PRRT_1', path: 'scripts/brand/sync.mjs', line: 22, startLine: 20, severity: 'P2', title: 'Check generated public derivatives for drift', latest: true, replies: 0, body: 'Line one\nAW_EOF_x\nname=value' }], outdated: 0, omitted: 0 };
  const env = { AW_CONFIG: JSON.stringify(defaultConfig()), PR_NUMBER: '9', HEAD_REF: 'feature/x' };
  const r = runMain(['prompt', 'remediate'], { event: { review: { id: 1, body: '' } }, env: { ...env, CODEX_FINDINGS: JSON.stringify(findings) } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.outputs.prompt, /1\. scripts\/brand\/sync\.mjs:20-22\n   P2: Check generated public derivatives for drift\n/);
  assert.ok(r.outputs.prompt.includes('Line one\nAW_EOF_x\nname=value'), 'comment text survives intact');
  assert.match(r.outputs.claude_args, /"enum":\["fixed","blocked","no_change"\]/);

  const missing = runMain(['prompt', 'remediate'], { event: { review: { id: 1, body: '' } }, env: { ...env, CODEX_FINDINGS: '' } });
  assert.match(missing.outputs.prompt, /could not collect the review threads for this run/);
});

test('result command maps structured output to a status', () => {
  const ok = runMain(['result', 'remediate'], { event: {}, env: { RAW_RESULT: '{"status":"fixed","summary":"s","validation":"v"}' } });
  assert.equal(ok.status, 0);
  assert.equal(ok.outputs.status, 'fixed');
  const bad = runMain(['result', 'remediate'], { event: {}, env: { RAW_RESULT: '' } });
  assert.equal(bad.status, 0, 'missing output is reported by the finish step, not here');
  assert.equal(bad.outputs.status, '');
  assert.match(bad.stdout, /::warning::Claude returned no structured result/);
});

test('unknown commands fail with an annotation', () => {
  const r = runMain(['frobnicate'], { event: {} });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::agent-workflows frobnicate failed: unknown command frobnicate/);
});

test('API commands demand a token; prompt/result run without one (as in the workflows)', () => {
  const r = runMain(['review-cycle'], { event: {}, env: { AW_CONFIG: JSON.stringify(defaultConfig()) } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /GITHUB_TOKEN is required for review-cycle/);
});

test('remove-checkout-credentials needs no token, never prints the credential and fails closed', () => {
  const root = realpathSync(tempDir());
  const repo = path.join(root, 'widget');
  const credentials = path.join(root, 'git-credentials-3f2a.config');
  const token = Buffer.from('x-access-token:ghs_checkoutTOKEN').toString('base64');
  const env = {
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, '.gitconfig'),
    GITHUB_WORKSPACE: repo,
    GITHUB_SERVER_URL: 'https://github.com',
  };
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: repo, env: { PATH: process.env.PATH, ...env } }).status, 0, args.join(' '));
  mkdirSync(repo);
  git('init', '-q');
  git('config', '--file', credentials, 'http.https://github.com/.extraheader', `AUTHORIZATION: basic ${token}`);
  git('config', `includeIf.gitdir:${repo}/.git.path`, credentials);

  const r = runMain(['remove-checkout-credentials'], { event: {}, env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^Removed persisted actions\/checkout GitHub credential from 1 included config file\.$/m);
  assert.ok(!readFileSync(credentials, 'utf8').includes(token));

  writeFileSync(env.GIT_CONFIG_GLOBAL, `[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic ${token}\n`);
  const blocked = runMain(['remove-checkout-credentials'], { event: {}, env });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /::error::git still sends an Authorization header to https:\/\/github\.com \(configured in .*\.gitconfig\)/);
  assert.equal(blocked.stderr, '', 'reported as an annotation, without a stack trace');
  for (const out of [r, blocked]) assert.ok(!(out.stdout + out.stderr).includes(token), 'credential never printed');
});

test('Outputs never lets a value terminate its own heredoc', () => {
  const dir = tempDir();
  const file = path.join(dir, 'out');
  writeFileSync(file, '');
  const o = new Outputs();
  o.set('single', 'one line');
  o.set('multi', 'a\nb');
  o.set('empty', null);
  o.flush({ GITHUB_OUTPUT: file });
  assert.deepEqual(parseOutputs(readFileSync(file, 'utf8')), { single: 'one line', multi: 'a\nb', empty: '' });
});
