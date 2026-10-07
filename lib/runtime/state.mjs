// Persistent PR review state and the remediation decision.
//
// State lives in one PR comment authored by github-actions[bot]:
//
//   <!-- agent-review-state -->
//   <!-- passes=1 -->
//   <!-- final=not_started -->
//   <!-- review_sha=4d1c0e3164fe92828c917f20da980d75d54bd293 -->   the Codex review
//   <!-- review_status=requested -->                               being tracked
//   <!-- review_origin=human-fix -->                               (absent in state
//   <!-- review_requested_at=2026-10-05T18:46:00Z -->              written before
//   <!-- review_request_id=123 -->                                 these existed)
//   <!-- review_completed_at=… -->
//   <!-- review_base_sha=… -->                                     base branch tip at the request
//   <!-- fixed_threads=PRRT_a@<sha>,… -->      fixed by a verified push, unconfirmed
//   <!-- addressed_threads=PRRT_b@<sha>@<sha>,… -->  fixed, and confirmed by a clean review
//                                              (fix commit @ the head that review covered)
//   <!-- ready_sha=<sha> -->                   the head a "ready" claim covers,
//   <!-- ready_base_sha=<sha> -->              on the base branch tip it was reviewed against
//   ### Agent review status
//   ...
//
// Only github-actions[bot] comments are trusted as state, so a human cannot
// reset the remediation budget by pasting the markers into a comment. Markers
// are read only above the heading, so text quoted in the details cannot add any.
//
// Fixed and addressed threads: GitHub only lets a token with Contents: write
// resolve a review thread, and no agent-workflows token has it, so threads
// fixed by a verified remediation pass stay open on GitHub. A verified,
// validated push records the findings Claude was given as fixed, with the
// pushed head; a clean Codex review of a head containing that commit promotes
// them to addressed. Either counts only while the branch still contains its
// fix commit (see findingEvidence in flows.mjs). A judgement (an audit,
// Claude's no_change) records nothing. The human resolves the threads.
//
// Readiness: "ready for human acceptance" is a claim about one head on one
// base, recorded as ready_sha and ready_base_sha (the base branch's tip:
// pull_request.base.sha is a snapshot that does not follow the branch). Every
// other transition clears it, and any locked check that finds either moved
// withdraws it (recordHeadChange and recheckReadiness in flows.mjs).

import { findingLocation } from './codex.mjs';

export const STATE_MARKER = '<!-- agent-review-state -->';
export const AUTOMATION_LOGIN = 'github-actions[bot]';
export const FINAL_STATES = ['not_started', 'running', 'complete', 'blocked'];
export const ORIGINS = ['initial', 'opt-in', 'remediation', 'human-fix'];
export const COUNTABLE_ORIGINS = new Set(['initial', 'opt-in', 'remediation']);

export const ORIGIN_TEXT = {
  initial: 'initial review',
  'opt-in': 'review after opt-in',
  remediation: 're-review after remediation',
  'human-fix': 'review after owner-requested fix',
  manual: 'manually requested review',
};

// Codex review statuses: requested (awaiting a completion signal), clean (no
// actionable findings), findings (actionable findings), outdated (completed, but
// the pull request head moved after the request).
export const REVIEW_STATUSES = ['requested', 'clean', 'findings', 'outdated'];
const REVIEW_TEXT = {
  requested: 'Awaiting completion signal',
  clean: 'Completed — no actionable findings',
  findings: 'Completed — actionable findings',
  outdated: 'Outdated; the pull request head or its base has moved since',
};
const HEADING = '### Agent review status';
// thread@fix-commit, and for confirmed fixes @the-confirming-review's-head
// (presentation only; evidence uses thread@fix-commit).
const RECORD_RE = /^([A-Za-z0-9_-]{1,100})@([0-9a-f]{40})(?:@([0-9a-f]{40}))?$/;
const MAX_RECORDS = 200;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

const shortSha = (sha) => (sha ? sha.slice(0, 7) : 'unknown');
const timeText = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'unknown');

function parseReview(markers) {
  const sha = markers.review_sha?.toLowerCase();
  if (!sha || !SHA_RE.test(sha) || !REVIEW_STATUSES.includes(markers.review_status)) return null;
  const time = (v) => (v && TIME_RE.test(v) ? v : null);
  return {
    sha,
    status: markers.review_status,
    origin: Object.hasOwn(ORIGIN_TEXT, markers.review_origin ?? '') ? markers.review_origin : null,
    requestedAt: time(markers.review_requested_at),
    requestId: /^\d+$/.test(markers.review_request_id || '') ? Number(markers.review_request_id) : null,
    completedAt: time(markers.review_completed_at),
    baseSha: /^[0-9a-f]{40}$/.test(markers.review_base_sha || '') ? markers.review_base_sha : null,
  };
}

function reviewMarkers(review) {
  if (!review) return [];
  const lines = [`<!-- review_sha=${review.sha} -->`, `<!-- review_status=${review.status} -->`];
  if (review.origin) lines.push(`<!-- review_origin=${review.origin} -->`);
  if (review.requestedAt) lines.push(`<!-- review_requested_at=${review.requestedAt} -->`);
  if (review.requestId) lines.push(`<!-- review_request_id=${review.requestId} -->`);
  if (review.completedAt) lines.push(`<!-- review_completed_at=${review.completedAt} -->`);
  if (review.baseSha) lines.push(`<!-- review_base_sha=${review.baseSha} -->`);
  return lines;
}

function reviewLines(review) {
  if (!review) return [];
  const lines = [`**Codex review:** ${REVIEW_TEXT[review.status]}`, `**Commit:** \`${shortSha(review.sha)}\``];
  if (review.requestedAt) lines.push(`**Requested:** ${timeText(review.requestedAt)}${review.origin ? ` (${ORIGIN_TEXT[review.origin]})` : ''}`);
  if (review.completedAt && review.status !== 'requested') lines.push(`**Completed:** ${timeText(review.completedAt)}`);
  return lines;
}

const FINAL_LABELS = {
  not_started: 'Not started',
  running: 'Running',
  complete: 'Complete',
  blocked: 'Blocked — human input required',
};

export function parseState(body) {
  const header = body.split(`\n${HEADING}`)[0];
  const markers = {};
  for (const m of header.matchAll(/^<!-- ([a-z_]+)=([^\s]*) -->$/gm)) if (!(m[1] in markers)) markers[m[1]] = m[2];
  const parseRecords = (value, withConfirmation) =>
    recordList(
      (value || '')
        .split(',')
        .map((entry) => entry.match(RECORD_RE))
        .filter(Boolean)
        .map(([, thread, sha, confirmedBy]) => (withConfirmation ? { thread, sha, confirmedBy: confirmedBy ?? null } : { thread, sha })),
    );
  return {
    passes: /^\d+$/.test(markers.passes || '') ? Number(markers.passes) : 0,
    final: FINAL_STATES.includes(markers.final) ? markers.final : 'not_started',
    review: parseReview(markers),
    fixed: parseRecords(markers.fixed_threads, false),
    addressed: parseRecords(markers.addressed_threads, true),
    readySha: /^[0-9a-f]{40}$/.test(markers.ready_sha || '') ? markers.ready_sha : null,
    readyBaseSha: /^[0-9a-f]{40}$/.test(markers.ready_base_sha || '') ? markers.ready_base_sha : null,
  };
}

const recordKey = (r) => `${r.thread}@${r.sha}`;

/** Valid, distinct { thread, sha } records, keeping the most recent MAX_RECORDS. */
function recordList(records) {
  const seen = new Map();
  for (const r of records) {
    if (!RECORD_RE.test(`${r?.thread}@${r?.sha}`)) continue;
    seen.delete(recordKey(r));
    const record = { thread: r.thread, sha: r.sha };
    if ('confirmedBy' in r) record.confirmedBy = /^[0-9a-f]{40}$/.test(r.confirmedBy ?? '') ? r.confirmedBy : null;
    seen.set(recordKey(r), record);
  }
  return [...seen.values()].slice(-MAX_RECORDS);
}

const recordsMarker = (name, records) =>
  records.length ? [`<!-- ${name}=${records.map((r) => (r.confirmedBy ? `${recordKey(r)}@${r.confirmedBy}` : recordKey(r))).join(',')} -->`] : [];

export function renderState({ passes, final, review = null, fixed = [], addressed = [], readySha = null, readyBaseSha = null, maxPasses, escalationEnabled = true, stage, details }) {
  const finalLabel = final === 'not_started' && !escalationEnabled ? 'Disabled' : FINAL_LABELS[final] ?? final;
  let body = [
    STATE_MARKER,
    `<!-- passes=${passes} -->`,
    `<!-- final=${final} -->`,
    ...reviewMarkers(review),
    ...recordsMarker('fixed_threads', fixed),
    ...recordsMarker('addressed_threads', addressed),
    ...(readySha ? [`<!-- ready_sha=${readySha} -->`] : []),
    ...(readySha && readyBaseSha ? [`<!-- ready_base_sha=${readyBaseSha} -->`] : []),
    HEADING,
    '',
    `**Stage:** ${stage}`,
    ...(readySha
      ? [`**Ready for human acceptance at:** \`${shortSha(readySha)}\`${readyBaseSha ? ` on base \`${shortSha(readyBaseSha)}\`` : ''} (a later push to either withdraws this)`]
      : []),
    ...reviewLines(review),
    `**Automated remediation:** ${passes} / ${maxPasses}`,
    `**Final audit:** ${finalLabel}`,
  ].join('\n');
  if (details) body += `\n\n${details}`;
  body +=
    '\n\n<sub>Updated by agent-workflows. Automation never approves or merges; ' +
    'a human decides whether this pull request is accepted.</sub>';
  return body;
}

export async function findStateComment(client, repo, pr) {
  const comments = await client.paginate(`repos/${repo.full}/issues/${pr}/comments`);
  const mine = comments.filter((c) => c.user?.login === AUTOMATION_LOGIN && (c.body || '').startsWith(STATE_MARKER));
  return mine.length ? mine[mine.length - 1] : null;
}

export async function readState(client, repo, pr) {
  const comment = await findStateComment(client, repo, pr);
  if (!comment) return { commentId: null, passes: 0, final: 'not_started', review: null, fixed: [], addressed: [], readySha: null, readyBaseSha: null };
  return { commentId: comment.id, ...parseState(comment.body) };
}

/**
 * Merge `changes` into the current state and write it:
 *   passes?, final?   replace
 *   review?           replaces the tracked Codex review; omitted keeps it
 *   fixThreads?       adds { thread, sha } records of a verified fix (sha: its pushed head)
 *   confirmThreads?   promotes those records from fixed to addressed
 *   readySha?         the head this state calls ready; omitted clears it, so
 *                     only a transition that establishes readiness keeps it
 *   readyBaseSha?     the base branch tip that readiness was established on
 *   stage, details?   the visible text
 * Records are never dropped except by promotion. Returns the new state.
 */
export async function updateState(ctx, pr, changes) {
  const current = changes.current ?? (await readState(ctx.client, ctx.repo, pr));
  const promoted = new Set((changes.confirmThreads ?? []).map(recordKey));
  const next = {
    passes: changes.passes ?? current.passes,
    final: changes.final ?? current.final,
    review: changes.review === undefined ? current.review ?? null : changes.review,
    fixed: recordList([...(current.fixed ?? []), ...(changes.fixThreads ?? [])].filter((r) => !promoted.has(recordKey(r)))),
    addressed: recordList([...(current.addressed ?? []), ...(changes.confirmThreads ?? [])]),
    readySha: changes.readySha ?? null,
    readyBaseSha: changes.readySha ? changes.readyBaseSha ?? null : null,
  };
  const body = renderState({
    ...next,
    maxPasses: ctx.config.remediation.max_passes,
    escalationEnabled: ctx.config.escalation.enabled,
    stage: changes.stage,
    details: changes.details,
  });
  let commentId = current.commentId;
  if (commentId) {
    await ctx.client.patch(`repos/${ctx.repo.full}/issues/comments/${commentId}`, { body });
  } else {
    const created = await ctx.client.post(`repos/${ctx.repo.full}/issues/${pr}/comments`, { body });
    commentId = created.id;
  }
  const review = next.review ? `, review=${shortSha(next.review.sha)}:${next.review.status}` : '';
  const ready = next.readySha ? `, ready=${shortSha(next.readySha)}` : '';
  ctx.log.info(`Review state: ${changes.stage} [passes=${next.passes}, final=${next.final}${review}${ready}]`);
  return { commentId, ...next };
}

/**
 * Decide what a newly submitted Codex review should trigger.
 *   finished  – automation already ended (final audit ran or stopped); do nothing
 *   escalate  – normal budget spent; run the holistic audit
 *   exhausted – normal budget spent and escalation disabled
 *   remediate – run a normal remediation pass
 */
export function decide({ passes, final, origin, maxPasses, escalationEnabled }) {
  const countable = COUNTABLE_ORIGINS.has(origin);
  if (final !== 'not_started') return { mode: 'finished', countable };
  if (countable && passes >= maxPasses) return { mode: escalationEnabled ? 'escalate' : 'exhausted', countable };
  return { mode: 'remediate', countable };
}

/**
 * Decide whether a Codex completion signal for `commit` (a SHA prefix) belongs
 * to the review the state is waiting for. Never guesses: without a recorded
 * request, or with a commit that does not identify it, nothing changes.
 * Returns { ok: true } or { ok: false, outcome, reason }.
 */
export function matchCompletion(state, commit) {
  const review = state.review;
  const no = (outcome, reason) => ({ ok: false, outcome, reason });
  if (!review) return no('unknown', 'the review state records no Codex review request, so the completion cannot be correlated');
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(commit)) return no('unknown', 'the signal names no commit of at least 7 hex characters');
  if (!review.sha.startsWith(commit.toLowerCase())) {
    return no('stale', `Codex completed ${commit.slice(0, 10)}, but the review being tracked is for ${shortSha(review.sha)}`);
  }
  if (review.status !== 'requested') return no('duplicate', `the review of ${shortSha(review.sha)} is already recorded as ${review.status}`);
  if (state.final !== 'not_started') return no('finished', `automated review has already ended (final audit: ${state.final})`);
  return { ok: true };
}

/**
 * What the pull request now being at `head`, on a base branch whose tip is
 * `base` (null when unknown: then only the head is compared), invalidates:
 *   'ready' / 'ready-base'      the state calls another head, or the same head
 *                               on another base, ready for human acceptance
 *   'awaited' / 'awaited-base'  it awaits a Codex review of another commit, or
 *                               of this one requested against another base
 *   null                        nothing
 */
export function headChange(state, head, base = null) {
  if (state.readySha && state.readySha !== head) return 'ready';
  if (state.readySha && base && state.readyBaseSha !== base) return 'ready-base';
  const review = state.review;
  if (review?.status === 'requested' && review.sha !== head) return 'awaited';
  if (review?.status === 'requested' && base && review.baseSha && review.baseSha !== base) return 'awaited-base';
  return null;
}

// Finding disclosure ---------------------------------------------------------------

const MAX_LISTED = 25;

/** Text from a Codex comment, made inert in Markdown: one line, no markup, links or mentions. */
const inert = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
    .replace(/([\\`*_{}[\]()<>#|~!])/g, '\\$1')
    .replace(/@/g, '@\u200b');

function findingLine(f, outcome) {
  const parts = [`${f.severity ? `**${f.severity}** ` : ''}${inert(f.title) || '(untitled finding)'}`];
  if (f.path) parts.push(`\`${findingLocation(f).replace(/[`\r\n]/g, '')}\``);
  parts.push(outcome);
  if (/^https:\/\/[^\s()<>[\]]+$/.test(f.url || '')) parts.push(`[thread](${f.url})`);
  return `- ${parts.join(' · ')}`;
}

function confirmedOutcome(f) {
  const by = f.confirmedBy ? `confirmed by the clean review of \`${shortSha(f.confirmedBy)}\`` : 'confirmed by a clean review (head not recorded)';
  return `fixed in \`${shortSha(f.fixedBy)}\`, ${by}`;
}

function actionOutcome(f) {
  if (f.pendingFix) return `fixed in \`${shortSha(f.pendingFix)}\`, not yet confirmed by a clean Codex review`;
  if (f.lostFix) return `fixed in \`${shortSha(f.lostFix)}\`, which is no longer in the branch`;
  return 'no verified fix';
}

// Code-point order, not localeCompare, whose order depends on the runtime's locale data.
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Path, then line, then thread ID: the same findings always list the same way. */
const byLocation = (a, b) =>
  compare(a.path ?? '\uffff', b.path ?? '\uffff') ||
  (a.startLine ?? a.line ?? 0) - (b.startLine ?? b.line ?? 0) ||
  (a.line ?? 0) - (b.line ?? 0) ||
  compare(String(a.thread), String(b.thread));

function section(heading, items, line) {
  const sorted = [...items].sort(byLocation);
  const lines = sorted.slice(0, MAX_LISTED).map(line);
  if (sorted.length > MAX_LISTED) lines.push(`- …and ${sorted.length - MAX_LISTED} more; see the pull request's conversations.`);
  return [heading, ...lines].join('\n');
}

/**
 * The open Codex review threads, for the status comment: `confirmed` (each
 * with fixedBy and confirmedBy) are fixes a clean Codex review confirmed that
 * GitHub still shows open; `action` (each with pendingFix or lostFix when a fix
 * was recorded) is everything else. Presentation only. Returns Markdown, or
 * null when no thread is open.
 */
export function renderFindingsDisclosure({ confirmed = [], action = [] }) {
  const sections = [];
  if (confirmed.length) {
    sections.push(
      section(
        `**Confirmed fixed, still open on GitHub (${confirmed.length}):** resolve these threads when you accept; agent-workflows cannot, as resolving needs Contents: write.`,
        confirmed,
        (f) => findingLine(f, confirmedOutcome(f)),
      ),
    );
  }
  if (action.length) sections.push(section(`**Still requires action (${action.length}):**`, action, (f) => findingLine(f, actionOutcome(f))));
  return sections.length ? sections.join('\n\n') : null;
}
