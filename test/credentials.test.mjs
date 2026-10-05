// Regression tests for removing the credential actions/checkout persists
// (anthropics/claude-code-action#1721). They run real git against temporary
// repositories laid out like a runner: $GITHUB_WORKSPACE/<repo> and $RUNNER_TEMP.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { CredentialError, headerAppliesTo, removeCheckoutCredentials } from '../lib/runtime/credentials.mjs';
import { cleanupTemp, tempDir } from './helpers.mjs';

after(cleanupTemp);

const CHECKOUT_TOKEN = 'ghs_checkoutTOKENfromGITHUBTOKEN0001';
const APP_TOKEN = 'ghs_claudeAPPtoken0002';
const basic = (token) => Buffer.from(`x-access-token:${token}`).toString('base64');
const HEADER = `AUTHORIZATION: basic ${basic(CHECKOUT_TOKEN)}`;
const KEY = 'http.https://github.com/.extraheader';

/** A runner-like layout with git isolated from the host's system and global config. */
function runner() {
  const root = realpathSync(tempDir());
  const home = path.join(root, 'home');
  const temp = path.join(root, '_temp');
  const repo = path.join(root, 'work', 'widget');
  for (const d of [home, temp, repo]) mkdirSync(d, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/acme/widget');
  git('config', 'user.name', 'keep-me');
  const logs = [];
  const log = { info: (m) => logs.push(m), warning: (m) => logs.push(m) };
  const clean = (opts = {}) => removeCheckoutCredentials({ cwd: repo, env, log, ...opts });
  /** Every value git resolves for `key` here (includes followed), or [] when unset. */
  const effective = (key = KEY, cwd = repo) => {
    const r = spawnSync('git', ['config', '--includes', '--get-all', key], { cwd, env, encoding: 'utf8' });
    return r.stdout.split('\n').filter(Boolean);
  };
  return { root, home, temp, repo, env, git, logs, clean, effective };
}

/** What actions/checkout v6+/v7 writes (src/git-auth-helper.ts, configureToken, non-global branch). */
function checkoutV7(r, { header = HEADER, key = KEY } = {}) {
  const file = path.join(r.temp, 'git-credentials-7c9e6679-7425-40de-944b-e07fc1f90ae7.config');
  r.git('config', '--file', file, key, header);
  const gitDir = path.join(r.repo, '.git');
  r.git('config', `includeIf.gitdir:${gitDir}.path`, file);
  r.git('config', `includeIf.gitdir:${gitDir}/worktrees/*.path`, file);
  r.git('config', 'includeIf.gitdir:/github/workspace/widget/.git.path', `/github/runner_temp/${path.basename(file)}`);
  r.git('config', 'includeIf.gitdir:/github/workspace/widget/.git/worktrees/*.path', `/github/runner_temp/${path.basename(file)}`);
  return file;
}

function assertNoSecrets(r, result) {
  const text = `${r.logs.join('\n')}\n${JSON.stringify(result ?? {})}`;
  for (const secret of [CHECKOUT_TOKEN, basic(CHECKOUT_TOKEN), 'AUTHORIZATION: basic']) {
    assert.ok(!text.includes(secret), `logs and result must not contain ${secret.slice(0, 12)}…`);
  }
}

test('legacy layout: removes the header from .git/config and keeps everything else', () => {
  const r = runner();
  r.git('config', KEY, HEADER);
  r.git('config', '--add', KEY, 'X-Trace: keep');
  assert.equal(r.effective().length, 2);

  const result = r.clean();
  assert.deepEqual(r.effective(), ['X-Trace: keep'], 'only the Authorization header is removed');
  assert.equal(r.git('config', 'user.name').trim(), 'keep-me');
  assert.equal(r.git('remote', 'get-url', 'origin').trim(), 'https://github.com/acme/widget');
  assert.deepEqual(result.removed, [{ file: result.repoConfig, headers: 1 }]);
  assert.match(r.logs[0], /^Removed persisted actions\/checkout GitHub credential from the repository config\.$/);
  assertNoSecrets(r, result);
});

test('ordinary include.path: removes the header from the included file, keeps the file and its other settings', () => {
  const r = runner();
  const file = path.join(r.temp, 'credentials.config');
  r.git('config', '--file', file, KEY, HEADER);
  r.git('config', '--file', file, 'core.autocrlf', 'input');
  r.git('config', 'include.path', file);
  assert.equal(r.effective().length, 1);

  const result = r.clean();
  assert.deepEqual(r.effective(), []);
  assert.equal(r.git('config', '--file', file, 'core.autocrlf').trim(), 'input', 'unrelated settings in the include survive');
  assert.equal(r.git('config', 'include.path').trim(), file, 'the include entry itself survives');
  assert.deepEqual(result.removed, [{ file, headers: 1 }]);
  assertNoSecrets(r, result);
});

test('checkout v7 includeIf.gitdir layout: the header is removed, the includes and the file stay for checkout’s own cleanup', () => {
  const r = runner();
  const file = checkoutV7(r);
  assert.deepEqual(r.effective(), [HEADER], 'precondition: git resolves checkout’s header through includeIf');
  const includesBefore = r.git('config', '--local', '--get-regexp', '^includeif\\.');

  const result = r.clean();
  assert.deepEqual(r.effective(), [], 'git no longer resolves any checkout credential');
  assert.ok(!readFileSync(file, 'utf8').includes(basic(CHECKOUT_TOKEN)), 'token is gone from disk');
  assert.equal(r.git('config', '--local', '--get-regexp', '^includeif\\.'), includesBefore, 'includeIf entries untouched');
  assert.deepEqual(result.removed, [{ file, headers: 1 }]);
  assert.equal(result.missing.length, 1, 'the container path does not exist on the host and is skipped');
  assert.deepEqual(r.logs.slice(0, 2), [
    'Removed persisted actions/checkout GitHub credential from 1 included config file.',
    `  ${file} (1 authorization header)`,
  ]);
  assertNoSecrets(r, result);
});

test('checkout v7: worktrees Claude creates do not inherit the credential either', () => {
  const r = runner();
  r.git('-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  checkoutV7(r);
  const worktree = path.join(r.root, 'wt');
  r.git('worktree', 'add', '-q', worktree);
  assert.deepEqual(r.effective(KEY, worktree), [HEADER], 'precondition: the worktrees/* includeIf matches');

  r.clean();
  assert.deepEqual(r.effective(KEY, worktree), []);
});

test('multiple, nested, relative and home-relative include targets are all cleaned', () => {
  const r = runner();
  const a = path.join(r.temp, 'a.config');
  const b = path.join(r.temp, 'nested', 'b.config');
  const c = path.join(r.home, 'c.config');
  mkdirSync(path.dirname(b), { recursive: true });
  for (const f of [a, b, c]) r.git('config', '--file', f, KEY, HEADER);
  r.git('config', '--file', a, 'include.path', 'nested/b.config'); // relative to a's directory
  r.git('config', 'include.path', a);
  r.git('config', 'includeIf.onbranch:main.path', '~/c.config');
  r.git('config', KEY, HEADER);

  const result = r.clean();
  assert.deepEqual(r.effective(), []);
  for (const f of [a, b, c]) assert.ok(!readFileSync(f, 'utf8').includes('extraheader'), f);
  assert.deepEqual(result.removed.map((x) => x.file), [result.repoConfig, a, b, c]);
  assert.equal(r.logs[0], 'Removed persisted actions/checkout GitHub credential from the repository config and 3 included config files.');
  assertNoSecrets(r, result);
});

test('include targets that do not exist on the runner do not break the cleanup', () => {
  const r = runner();
  const file = checkoutV7(r);
  r.git('config', '--add', 'include.path', path.join(r.temp, 'deleted.config'));

  const result = r.clean();
  assert.deepEqual(r.effective(), []);
  assert.deepEqual(result.removed.map((x) => x.file), [file]);
  assert.deepEqual(result.missing, [`/github/runner_temp/${path.basename(file)}`, path.join(r.temp, 'deleted.config')]);
  assert.match(r.logs.at(-1), /^Skipped 2 include targets not present on this runner/);
});

test('cleanup is idempotent', () => {
  const r = runner();
  checkoutV7(r);
  r.clean();
  r.logs.length = 0;
  const second = r.clean();
  assert.deepEqual(second.removed, []);
  assert.equal(r.logs[0], 'No persisted GitHub credential found in the repository config or its 1 included file; nothing to remove.');
  assert.deepEqual(r.effective(), []);
});

test('nothing persisted (persist-credentials: false) is a quiet no-op', () => {
  const r = runner();
  const result = r.clean();
  assert.deepEqual(result.removed, []);
  assert.equal(r.logs[0], 'No persisted GitHub credential found in the repository config or its 0 included files; nothing to remove.');
});

test('only Authorization headers for the configured server are removed', () => {
  const r = runner();
  const file = checkoutV7(r);
  r.git('config', '--file', file, '--add', KEY, 'X-Request-Source: ci');
  r.git('config', '--file', file, 'http.https://example.com/.extraheader', 'AUTHORIZATION: basic b3RoZXI=');
  r.git('config', 'http.https://github.com/acme/widget.extraheader', 'authorization: Bearer scoped');

  r.clean();
  assert.deepEqual(r.effective(), ['X-Request-Source: ci']);
  assert.deepEqual(r.effective('http.https://example.com/.extraheader'), ['AUTHORIZATION: basic b3RoZXI='], 'other hosts are not ours');
  assert.deepEqual(r.effective('http.https://github.com/acme/widget.extraheader'), [], 'repository-scoped headers for the server go too');
});

test('GitHub Enterprise Server: the server URL decides which headers are checkout’s', () => {
  const r = runner();
  checkoutV7(r, { key: 'http.https://ghe.example.com/.extraheader' });
  r.git('config', KEY, 'AUTHORIZATION: basic bm90LXRoaXMtc2VydmVy');

  r.clean({ serverUrl: 'https://ghe.example.com' });
  assert.deepEqual(r.effective('http.https://ghe.example.com/.extraheader'), []);
  assert.deepEqual(r.effective(), ['AUTHORIZATION: basic bm90LXRoaXMtc2VydmVy']);
});

test('fails closed, without printing the value, when a header remains outside the repository config', () => {
  const r = runner();
  checkoutV7(r);
  const globalConfig = r.env.GIT_CONFIG_GLOBAL;
  writeFileSync(globalConfig, `[http "https://github.com/"]\n\textraheader = ${HEADER}\n`);

  let error;
  try {
    r.clean();
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof CredentialError);
  assert.match(error.message, new RegExp(`configured in ${globalConfig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(!error.message.includes(basic(CHECKOUT_TOKEN)));
  assert.ok(readFileSync(globalConfig, 'utf8').includes(HEADER), 'global configuration is never edited');
  assertNoSecrets(r);
});

test('headerAppliesTo follows git’s http.<url> scoping', () => {
  const gh = 'https://github.com';
  assert.ok(headerAppliesTo('http.extraheader', gh));
  assert.ok(headerAppliesTo('http.https://github.com/.extraheader', gh));
  assert.ok(headerAppliesTo('http.https://github.com.extraheader', gh));
  assert.ok(headerAppliesTo('http.https://github.com/acme/widget.extraheader', gh));
  assert.ok(headerAppliesTo('http.https://x-access-token@github.com/.extraheader', gh));
  assert.ok(headerAppliesTo('http.https://*.com/.extraheader', gh));
  assert.ok(!headerAppliesTo('http.http://github.com/.extraheader', gh));
  assert.ok(!headerAppliesTo('http.https://github.com:8443/.extraheader', gh));
  assert.ok(!headerAppliesTo('http.https://api.github.com/.extraheader', gh));
  assert.ok(!headerAppliesTo('http.https://github.com/.sslverify', gh));
  assert.ok(headerAppliesTo('http.https://ghe.example.com/.extraheader', 'https://ghe.example.com'));
});

// End to end: which credential does git actually send? -------------------------------------

/** A git smart-HTTP endpoint that challenges anonymous requests and records the credential used. */
async function recordingServer() {
  const seen = [];
  const server = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (!auth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }).end();
      return;
    }
    seen.push(Buffer.from(auth.replace(/^basic /i, ''), 'base64').toString());
    res.writeHead(403).end('Write access to repository not granted.');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('end to end: after the cleanup git authenticates with the token in the origin URL, not checkout’s', async () => {
  const r = runner();
  const server = await recordingServer();
  try {
    const key = `http.${server.url}/.extraheader`;
    checkoutV7(r, { key });
    // What claude-code-action's configureGitAuth does once it has its GitHub App token.
    r.git('remote', 'set-url', 'origin', `${server.url.replace('//', `//x-access-token:${APP_TOKEN}@`)}/acme/widget.git`);
    const push = () => promisify(execFile)('git', ['push', '--dry-run', 'origin', 'HEAD:refs/heads/x'], { cwd: r.repo, env: r.env }).catch(() => {});
    r.git('-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'change');

    await push();
    assert.deepEqual(server.seen, [`x-access-token:${CHECKOUT_TOKEN}`], 'the bug: checkout’s header wins over the URL credential');

    server.seen.length = 0;
    r.clean({ serverUrl: server.url });
    await push();
    assert.deepEqual(server.seen, [`x-access-token:${APP_TOKEN}`], 'fixed: git falls back to the GitHub App token');
  } finally {
    await server.close();
  }
});
