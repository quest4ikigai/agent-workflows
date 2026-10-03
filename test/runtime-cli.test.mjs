// Runs lib/runtime/main.mjs as the workflows do: inputs via env, results via $GITHUB_OUTPUT.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
    env: { AW_CONFIG: JSON.stringify(defaultConfig()) },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.outputs.prompt, /issue #4/);
  assert.ok(r.outputs.prompt.includes(hostile), 'user text survives intact inside the heredoc');
  assert.match(r.outputs.claude_args, /^--model sonnet\n--max-turns 40\n/);
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
