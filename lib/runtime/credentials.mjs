// Removal of the credential actions/checkout persists, run before every Claude
// session that may push.
//
// With persist-credentials (the default) actions/checkout stores the job's
// GITHUB_TOKEN as an `http.<server>/.extraheader` Authorization header. Up to v5
// it wrote the header into .git/config; since v6 (so in the v7 these workflows
// use) it writes it to $RUNNER_TEMP/git-credentials-<uuid>.config and references
// that file from .git/config with `includeIf.gitdir:<repo>/.git.path`, plus
// worktree and container variants. git sends the header on every request to the
// server, so it beats the GitHub App token claude-code-action embeds in the
// origin URL, and Claude's pushes authenticate as GITHUB_TOKEN: a 403 with
// `contents: read`, or a push that triggers no workflows with `contents: write`.
// claude-code-action@v1 only follows `include.path` when it clears the header
// (anthropics/claude-code-action#1721), so the workflows clear it themselves.
//
// Header values are matched by git (value pattern, --name-only), so token values
// never enter this process, its arguments or its logs.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HEADER_KEYS = '^http\\.(.*\\.)?extraheader$';
const AUTHORIZATION = '^[[:space:]]*[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn][[:space:]]*:';
const INCLUDE_KEYS = '^include(if\\..*)?\\.path$';
const MAX_INCLUDE_DEPTH = 10; // git's own limit

export class CredentialError extends Error {}

function runGit(args, { cwd, env }) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr.trim().split('\n')[0] };
}

/** True when git would send `http.<url>.extraheader` (or `http.extraheader`) to the server. */
export function headerAppliesTo(key, serverUrl) {
  const m = key.match(/^http\.(?:(.*)\.)?extraheader$/i);
  if (!m) return false;
  if (m[1] === undefined) return true;
  let scope;
  try {
    scope = new URL(m[1]);
  } catch {
    return false;
  }
  const server = new URL(serverUrl);
  const pattern = scope.hostname.split('.');
  const host = server.hostname.split('.');
  return (
    scope.protocol === server.protocol &&
    scope.port === server.port &&
    pattern.length === host.length &&
    pattern.every((label, i) => label === '*' || label === host[i])
  );
}

/** Include targets of one config file, resolved the way git resolves them. */
function includeTargets(git, file, home) {
  const r = git(['config', '--file', file, '--null', '--get-regexp', INCLUDE_KEYS]);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => (entry.includes('\n') ? entry.slice(entry.indexOf('\n') + 1) : '')) // "key\nvalue"
    .filter(Boolean)
    .map((value) => (value.startsWith('~/') ? path.join(home, value.slice(2)) : path.resolve(path.dirname(file), value)));
}

/** Names of Authorization extraheaders in `scope` args; with --show-origin, [origin, key] pairs. */
function authorizationHeaders(git, scope, { origins = false } = {}) {
  const args = ['config', ...scope, '--name-only', '--null', '--get-regexp', HEADER_KEYS, AUTHORIZATION];
  if (origins) args.splice(1, 0, '--includes', '--show-origin');
  const r = git(args);
  if (r.code === 1) return [];
  if (r.code !== 0) throw new CredentialError(`git config could not list http.extraheader entries: ${r.stderr}`);
  const parts = r.stdout.split('\0').filter(Boolean);
  if (!origins) return parts;
  const pairs = [];
  for (let i = 0; i + 1 < parts.length; i += 2) pairs.push([parts[i].replace(/^file:/, ''), parts[i + 1]]);
  return pairs;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Remove every Authorization extraheader for `serverUrl` from the repository's
 * git config and from every file it includes (include.path and includeIf.*.path,
 * whatever the condition; nested includes too), then verify that git no longer
 * resolves one here. Other headers, other hosts, the include entries themselves
 * and the included files are left in place, so actions/checkout's post-job
 * cleanup still finds what it created. Idempotent. Throws CredentialError when a
 * header remains that this function must not edit (global/system config, …).
 */
export function removeCheckoutCredentials({ cwd = process.cwd(), serverUrl = 'https://github.com', env = process.env, log } = {}) {
  const git = (args) => runGit(args, { cwd, env });
  const home = env.HOME || os.homedir();

  const commonDir = git(['rev-parse', '--git-common-dir']);
  if (commonDir.code !== 0) throw new CredentialError(`${cwd} is not a git repository: ${commonDir.stderr}`);
  const repoConfig = path.resolve(cwd, commonDir.stdout.trim(), 'config');

  const files = [];
  const missing = [];
  const seen = new Set();
  const visit = (file, depth) => {
    if (seen.has(file) || depth > MAX_INCLUDE_DEPTH) return;
    seen.add(file);
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
      missing.push(file);
      return;
    }
    files.push(file);
    for (const target of includeTargets(git, file, home)) visit(target, depth + 1);
  };
  visit(repoConfig, 0);

  const removed = [];
  for (const file of files) {
    const keys = authorizationHeaders(git, ['--file', file]).filter((k) => headerAppliesTo(k, serverUrl));
    if (!keys.length) continue;
    for (const key of new Set(keys)) {
      const r = git(['config', '--file', file, '--unset-all', key, AUTHORIZATION]);
      // 5: nothing matched (already gone).
      if (r.code !== 0 && r.code !== 5) throw new CredentialError(`could not remove ${key} from ${file}: ${r.stderr}`);
    }
    removed.push({ file, headers: keys.length });
  }

  const includes = files.length - 1;
  if (removed.length) {
    const fromRepo = removed.some((r) => r.file === repoConfig);
    const fromIncludes = removed.filter((r) => r.file !== repoConfig).length;
    const where = [fromRepo && 'the repository config', fromIncludes && plural(fromIncludes, 'included config file')].filter(Boolean).join(' and ');
    log?.info(`Removed persisted actions/checkout GitHub credential from ${where}.`);
    for (const r of removed) log?.info(`  ${r.file} (${plural(r.headers, 'authorization header')})`);
  } else {
    log?.info(`No persisted GitHub credential found in the repository config or its ${plural(includes, 'included file')}; nothing to remove.`);
  }
  if (missing.length) log?.info(`Skipped ${plural(missing.length, 'include target')} not present on this runner (such as checkout's container paths).`);

  const remaining = authorizationHeaders(git, [], { origins: true }).filter(([, key]) => headerAppliesTo(key, serverUrl));
  if (remaining.length) {
    const sources = [...new Set(remaining.map(([origin]) => origin))].join(', ');
    throw new CredentialError(
      `git still sends an Authorization header to ${new URL(serverUrl).origin} (configured in ${sources}). ` +
        "It would replace Claude's GitHub App token on push; remove it from that configuration.",
    );
  }
  return { repoConfig, scanned: files, missing, removed };
}
