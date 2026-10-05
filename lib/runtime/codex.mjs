// Codex GitHub code review integration.
//
// Codex is asked to review with an "@codex review" PR comment. That comment must
// come from a user whose GitHub account is connected to Codex — Codex ignores
// github-actions[bot] — so requests are posted with AGENT_GITHUB_TOKEN.
//
// Outcomes are detected the same way the original Mealie workflow did:
//   findings – Codex submitted a new pull request review
//   clean    – Codex reacted 👍 to the request, or posted a "didn't find any
//              major issues" comment after it
//   pending  – neither happened within the wait window

export const CODEX_LOGIN_PREFIX = 'chatgpt-codex-connector';
export const REQUEST_PREFIX = '@codex review';
export const CLEAN_PHRASE = 'find any major issues';

const REQUEST_MARKER_RE = /^<!-- agent-review-request origin=([a-z-]+) -->$/m;

export const isCodex = (login) => typeof login === 'string' && login.startsWith(CODEX_LOGIN_PREFIX);

export async function countCodexReviews(client, repo, pr) {
  const reviews = await client.paginate(`repos/${repo.full}/pulls/${pr}/reviews`);
  return reviews.filter((r) => isCodex(r.user?.login)).length;
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
    if (reactions.some((r) => isCodex(r.user?.login) && r.content === '+1')) return 'clean';

    const since = createdAt ? `?since=${encodeURIComponent(createdAt)}` : '';
    const comments = await client.paginate(`repos/${repo.full}/issues/${pr}/comments${since}`);
    if (comments.some((c) => c.id > requestId && isCodex(c.user?.login) && (c.body || '').includes(CLEAN_PHRASE))) {
      return 'clean';
    }

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
            nodes { author { login } body pullRequestReview { databaseId } }
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
 * outdated; they are counted, not listed). Only Codex's own comments are
 * quoted; replies by others are counted. `latestReviewId` marks findings from
 * the review that triggered this run.
 * Returns { findings, outdated, omitted }. Throws on API errors.
 */
export async function codexFindings(client, repo, pr, { latestReviewId = null } = {}) {
  const findings = [];
  let outdated = 0;
  let omitted = 0;
  let budget = FINDINGS_TEXT_LIMIT;
  for (const t of await reviewThreads(client, repo, pr)) {
    const comments = t.comments.nodes;
    if (t.isResolved || !isCodex(comments[0]?.author?.login)) continue;
    if (t.isOutdated) {
      outdated++;
      continue;
    }
    const own = comments.filter((c) => isCodex(c.author?.login));
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
  return { findings, outdated, omitted };
}

/** Resolve unresolved review threads that Codex participated in. Never throws. */
export async function resolveCodexThreads(client, repo, pr, log = () => {}) {
  let ids;
  try {
    ids = (await reviewThreads(client, repo, pr))
      .filter((t) => !t.isResolved && t.comments.nodes.some((c) => isCodex(c.author?.login)))
      .map((t) => t.id);
  } catch (err) {
    log(`warning: could not list review threads: ${err.message}`);
    return { resolved: 0, failed: 0, error: err.message };
  }
  let resolved = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await client.graphql(RESOLVE_MUTATION, { id });
      resolved++;
    } catch (err) {
      failed++;
      log(`warning: could not resolve review thread ${id}: ${err.message}`);
    }
  }
  log(ids.length ? `Resolved ${resolved}/${ids.length} Codex review thread(s).` : 'No unresolved Codex review threads.');
  return { resolved, failed };
}
