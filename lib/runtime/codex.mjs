// Codex GitHub code review integration.
//
// Codex is asked to review with an "@codex review" PR comment. That comment must
// come from a user whose GitHub account is connected to Codex — Codex ignores
// github-actions[bot] — so requests are posted with AGENT_GITHUB_TOKEN.
//
// Codex reports a finished review in up to three ways:
//   findings – it submits a pull request review (with inline threads); the
//              pull_request_review event drives remediation
//   clean    – it reacts 👍 to the request, posts a "Codex Review: Didn't find
//              any major issues" comment, and/or edits its persistent summary
//              comment to show the Code Review as completed
// Polling (waitForCodex) and the issue_comment events (parseCompletionSignal)
// share the identity and parsing rules below.
//
// Codex is identified exactly, never by login prefix: on a public repository
// anyone can register an account such as "chatgpt-codex-connector-x", and its
// reviews and threads must not start remediation or reach Claude as findings.

export const CODEX_LOGIN_PREFIX = 'chatgpt-codex-connector';
export const CODEX_BOT_LOGIN = `${CODEX_LOGIN_PREFIX}[bot]`;
export const REQUEST_PREFIX = '@codex review';
export const CLEAN_PHRASE = 'find any major issues';
export const SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';

const REQUEST_MARKER_RE = /^<!-- agent-review-request origin=([a-z-]+) -->$/m;
const CLEAN_RE = new RegExp(`\\bdidn['’]t ${CLEAN_PHRASE}\\b`, 'i');

/**
 * The Codex GitHub App's bot account, as a REST user object (reviews, comments,
 * reactions). "[bot]" logins cannot be registered by people, and the type rules
 * out a human account whose login merely resembles it.
 */
export const isCodexBot = (user) => user?.type === 'Bot' && typeof user.login === 'string' && user.login.toLowerCase() === CODEX_BOT_LOGIN;

/** The same account as a GraphQL actor, whose bot login carries no "[bot]" suffix. */
export const isCodexActor = (actor) => actor?.__typename === 'Bot' && typeof actor.login === 'string' && actor.login.toLowerCase() === CODEX_LOGIN_PREFIX;

export async function countCodexReviews(client, repo, pr) {
  const reviews = await client.paginate(`repos/${repo.full}/pulls/${pr}/reviews`);
  return reviews.filter((r) => isCodexBot(r.user)).length;
}

/** Whether Codex submitted a pull request review (its findings path) of `sha`, at or after `since` when given. */
export async function hasCodexReviewOf(client, repo, pr, sha, { since = null } = {}) {
  const reviews = await client.paginate(`repos/${repo.full}/pulls/${pr}/reviews`);
  const after = since ? Date.parse(since) : null;
  return reviews.some((r) => isCodexBot(r.user) && r.commit_id === sha && (after === null || Date.parse(r.submitted_at) >= after));
}

// Completion signals ---------------------------------------------------------------

const HEX_PREFIX_RE = /^[0-9a-f]{7,40}$/i;

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
const plain = (cell) =>
  cell
    .replace(/<relative-time\b[^>]*>[\s\S]*?<\/relative-time>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`]/g, '')
    .replace(/[^\p{L}\p{N}\s.-]/gu, '')
    .trim();

/**
 * Parse Codex's persistent review summary comment. Only the Code Review row is
 * read (never the Security Review row), and only through the table header's own
 * column names. Returns { completed, commit, completedAt } or { ignored: reason }.
 */
export function parseReviewSummary(body) {
  const text = (body || '').replace(/\r\n/g, '\n');
  if (!text.includes(SUMMARY_MARKER)) return { ignored: 'not a Codex review summary' };
  const rows = text.split('\n').filter((l) => l.trim().startsWith('|'));
  const headerAt = rows.findIndex((r) => {
    const names = cells(r).map((c) => plain(c).toLowerCase());
    return names.includes('review') && names.includes('status') && names.includes('commit');
  });
  if (headerAt < 0) return { ignored: 'the summary has no Review/Status/Commit table' };
  const header = cells(rows[headerAt]).map((c) => plain(c).toLowerCase());
  const col = { review: header.indexOf('review'), status: header.indexOf('status'), commit: header.indexOf('commit') };
  const code = rows.slice(headerAt + 1).filter((r) => /^code review$/i.test(plain(cells(r)[col.review] ?? '')));
  if (code.length !== 1) return { ignored: code.length ? 'the summary has more than one Code Review row' : 'the summary has no Code Review row' };
  const row = cells(code[0]);
  if (row.length !== header.length) return { ignored: 'the Code Review row does not match the table header' };
  const status = plain(row[col.status]);
  const commit = (row[col.commit].match(/^`?([0-9a-f]{7,40})`?$/i) || [])[1];
  if (!commit) return { ignored: 'the Code Review row has no commit' };
  const completed = /^completed\b/i.test(status);
  const completedAt = completed ? ((row[col.status].match(/datetime="([^"]+)"/) || [])[1] ?? null) : null;
  return { completed, status, commit: commit.toLowerCase(), completedAt };
}

/** Whether a comment body is Codex's "didn't find any major issues" result. */
export const isCleanResult = (body) => CLEAN_RE.test(body || '');

/**
 * Parse Codex's clean-result comment ("Codex Review: Didn't find any major
 * issues. … Reviewed commit: `4d1c0e3164`"). Returns { clean, commit } or
 * { ignored: reason }; `commit` is null when the comment names none.
 */
export function parseCleanResult(body) {
  if (!isCleanResult(body)) return { ignored: 'not a Codex clean-result comment' };
  const commit = ((body || '').match(/\breviewed commit\b\**:?\**:?\s*`?([0-9a-f]{7,40})\b`?/i) || [])[1] ?? null;
  return { clean: true, commit: commit && commit.toLowerCase() };
}

/**
 * A Codex completion signal from an issue comment, or { ignored: reason }.
 * Only comments by the Codex bot count, however their text reads. Returns
 * { source: 'summary' | 'clean-comment', completed, commit, at }.
 */
export function parseCompletionSignal(comment) {
  if (!comment) return { ignored: 'no comment' };
  if (!isCodexBot(comment.user)) return { ignored: `comment author @${comment.user?.login ?? 'unknown'} is not the Codex bot` };
  const body = comment.body || '';
  if (body.includes(SUMMARY_MARKER)) {
    const s = parseReviewSummary(body);
    if (s.ignored) return s;
    if (!s.completed) return { ignored: `the Code Review is "${s.status}", not completed` };
    return { source: 'summary', completed: true, commit: s.commit, at: s.completedAt ?? comment.updated_at ?? null };
  }
  const c = parseCleanResult(body);
  if (c.ignored) return c;
  if (!c.commit) return { ignored: 'the clean-result comment names no reviewed commit' };
  return { source: 'clean-comment', completed: true, commit: c.commit, at: comment.created_at ?? null };
}

/** Whether a reported commit prefix (at least 7 hex characters) identifies `sha`. */
export function commitMatches(prefix, sha) {
  return typeof prefix === 'string' && HEX_PREFIX_RE.test(prefix) && typeof sha === 'string' && sha.toLowerCase().startsWith(prefix.toLowerCase());
}

export function requestBody(origin) {
  return `${REQUEST_PREFIX}\n<!-- agent-review-request origin=${origin} -->`;
}

/** Post the review request. The baseline review count is taken first. */
export async function requestCodexReview({ client, agentClient, repo, pr, origin }) {
  const baseline = await countCodexReviews(client, repo, pr);
  const comment = await agentClient.post(`repos/${repo.full}/issues/${pr}/comments`, { body: requestBody(origin) });
  return { requestId: comment.id, createdAt: comment.created_at, baseline };
}

/**
 * Origin of the most recent review request. Requests not posted by the
 * automation's PAT user (or without a marker) count as "manual".
 */
export async function latestRequestOrigin(client, repo, pr, automationLogin) {
  const comments = await client.paginate(`repos/${repo.full}/issues/${pr}/comments`);
  const requests = comments.filter((c) => (c.body || '').trimStart().startsWith(REQUEST_PREFIX));
  if (!requests.length) return 'manual';
  const last = requests[requests.length - 1];
  if (!automationLogin || last.user?.login?.toLowerCase() !== automationLogin.toLowerCase()) return 'manual';
  const m = (last.body || '').match(REQUEST_MARKER_RE);
  return m ? m[1] : 'manual';
}

export async function waitForCodex({
  client,
  repo,
  pr,
  requestId,
  createdAt,
  baseline,
  reviewSha = null,
  timeoutMs,
  pollMs = 15000,
  heartbeatMs = 60000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = () => {},
}) {
  const started = now();
  let lastBeat = started;
  while (now() - started < timeoutMs) {
    const count = await countCodexReviews(client, repo, pr);
    if (count > baseline) return 'findings';

    const reactions = await client.paginate(`repos/${repo.full}/issues/comments/${requestId}/reactions`);
    if (reactions.some((r) => isCodexBot(r.user) && r.content === '+1')) return 'clean';

    // A clean-result comment after the request, unless it names another commit.
    const since = createdAt ? `?since=${encodeURIComponent(createdAt)}` : '';
    const comments = await client.paginate(`repos/${repo.full}/issues/${pr}/comments${since}`);
    const clean = (c) => {
      if (c.id <= requestId || !isCodexBot(c.user)) return false;
      const result = parseCleanResult(c.body);
      return !result.ignored && (!result.commit || !reviewSha || commitMatches(result.commit, reviewSha));
    };
    if (comments.some(clean)) return 'clean';

    if (now() - lastBeat >= heartbeatMs) {
      log(`Codex review still running: ${Math.round((now() - started) / 1000)}s elapsed, ${count} Codex review(s) (baseline ${baseline}).`);
      lastBeat = now();
    }
    await sleep(pollMs);
  }
  return 'pending';
}

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          comments(first: 20) {
            nodes { author { __typename login } body pullRequestReview { databaseId } }
          }
        }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `
mutation($id: ID!) {
  resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } }
}`;

/** Review threads of a PR, oldest first (at most 1000). Throws on API errors. */
async function reviewThreads(client, repo, pr) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const data = await client.graphql(THREADS_QUERY, { owner: repo.owner, name: repo.name, number: Number(pr), cursor });
    const threads = data.repository.pullRequest.reviewThreads;
    out.push(...threads.nodes);
    if (!threads.pageInfo.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
  }
  return out;
}

// Comment text handed to Claude is bounded: it travels through step outputs and
// environment variables, and a single environment string is limited to 128 KiB.
const FINDING_BODY_LIMIT = 4000;
const FINDINGS_TEXT_LIMIT = 30000;

/**
 * Severity and title of a Codex inline comment, which starts like
 * `**<sub><sub>![P2 Badge](…/badge/P2-yellow…)</sub></sub>  Title**`.
 */
export function describeFinding(body) {
  const text = body || '';
  const severity = (text.match(/!\[(P[0-3])\b[^\]]*\]/) || text.match(/badge\/(P[0-3])-/i) || [])[1] || null;
  const first = text.split('\n').find((l) => l.trim()) || '';
  const title = first
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<\/?sub>/gi, '')
    .replace(/\*\*/g, '')
    .trim();
  return { severity, title: title.slice(0, 200) };
}

/**
 * The current Codex findings on a PR: unresolved review threads that Codex
 * opened and whose code has not changed since (GitHub marks the others
 * outdated; they are counted, not listed). Threads in `addressed` (fixed by a
 * verified remediation pass, see state.mjs) are counted, not listed. Only
 * Codex's own comments are quoted; replies by others are counted.
 * `latestReviewId` marks findings from the review that triggered this run;
 * `textLimit` bounds the quoted text (prompts) and may be Infinity (counting).
 * Returns { findings, outdated, addressed, omitted }. Throws on API errors.
 */
export async function codexFindings(client, repo, pr, { latestReviewId = null, addressed = [], textLimit = FINDINGS_TEXT_LIMIT } = {}) {
  const done = new Set(addressed);
  const findings = [];
  let outdated = 0;
  let fixed = 0;
  let omitted = 0;
  let budget = textLimit;
  for (const t of await reviewThreads(client, repo, pr)) {
    const comments = t.comments.nodes;
    if (t.isResolved || !isCodexActor(comments[0]?.author)) continue;
    if (t.isOutdated) {
      outdated++;
      continue;
    }
    if (done.has(t.id)) {
      fixed++;
      continue;
    }
    const own = comments.filter((c) => isCodexActor(c.author));
    let body = own.map((c) => (c.body || '').trim()).join('\n\n---\n\n');
    if (body.length > FINDING_BODY_LIMIT) body = `${body.slice(0, FINDING_BODY_LIMIT)}\n… (truncated; read the full comment on the pull request)`;
    if (body.length > budget) {
      omitted++;
      budget = 0;
      continue;
    }
    budget -= body.length;
    findings.push({
      thread: t.id,
      path: t.path ?? null,
      line: t.line ?? null,
      startLine: t.startLine ?? null,
      ...describeFinding(own[0].body),
      latest: latestReviewId == null ? null : own.some((c) => c.pullRequestReview?.databaseId === Number(latestReviewId)),
      replies: comments.length - own.length,
      body,
    });
  }
  return { findings, outdated, addressed: fixed, omitted };
}

// GitHub refuses resolveReviewThread without Contents: write, which no
// agent-workflows token holds by design (pull-requests: write is not enough).
const REFUSED_RE = /Resource not accessible|FORBIDDEN/i;

/**
 * Try to resolve the given review threads: the findings a verified, validated
 * remediation pass was given, never others. Never throws. With
 * agent-workflows' read-only tokens GitHub refuses, so this stops at the first
 * refusal; the review state records the fix instead (see state.mjs).
 * Returns { resolved, failed, refused? }.
 */
export async function resolveReviewThreads(client, ids, log = () => {}) {
  let resolved = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await client.graphql(RESOLVE_MUTATION, { id });
      resolved++;
    } catch (err) {
      if (REFUSED_RE.test(err.message)) {
        log(`${ids.length - resolved} Codex review thread(s) left open: GitHub requires Contents: write to resolve review threads, and agent-workflows' tokens are read-only (${err.message}).`);
        return { resolved, failed: ids.length - resolved, refused: true };
      }
      failed++;
      log(`warning: could not resolve review thread ${id}: ${err.message}`);
    }
  }
  if (ids.length) log(`Resolved ${resolved}/${ids.length} Codex review thread(s).`);
  return { resolved, failed };
}
