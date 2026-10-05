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
//   ### Agent review status
//   ...
//
// Only github-actions[bot] comments are trusted as state, so a human cannot
// reset the remediation budget by pasting the markers into a comment. Markers
// are read only above the heading, so text quoted in the details cannot add any.

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
  outdated: 'Completed for an older commit; the pull request head has moved since',
};
const HEADING = '### Agent review status';
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
  };
}

function reviewMarkers(review) {
  if (!review) return [];
  const lines = [`<!-- review_sha=${review.sha} -->`, `<!-- review_status=${review.status} -->`];
  if (review.origin) lines.push(`<!-- review_origin=${review.origin} -->`);
  if (review.requestedAt) lines.push(`<!-- review_requested_at=${review.requestedAt} -->`);
  if (review.requestId) lines.push(`<!-- review_request_id=${review.requestId} -->`);
  if (review.completedAt) lines.push(`<!-- review_completed_at=${review.completedAt} -->`);
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
  return {
    passes: /^\d+$/.test(markers.passes || '') ? Number(markers.passes) : 0,
    final: FINAL_STATES.includes(markers.final) ? markers.final : 'not_started',
    review: parseReview(markers),
  };
}

export function renderState({ passes, final, review = null, maxPasses, escalationEnabled = true, stage, details }) {
  const finalLabel = final === 'not_started' && !escalationEnabled ? 'Disabled' : FINAL_LABELS[final] ?? final;
  let body = [
    STATE_MARKER,
    `<!-- passes=${passes} -->`,
    `<!-- final=${final} -->`,
    ...reviewMarkers(review),
    HEADING,
    '',
    `**Stage:** ${stage}`,
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
  if (!comment) return { commentId: null, passes: 0, final: 'not_started', review: null };
  return { commentId: comment.id, ...parseState(comment.body) };
}

/**
 * Merge `changes` ({passes?, final?, review?, stage, details?}) into the
 * current state and write it. `review` replaces the tracked Codex review as a
 * whole; when omitted, the current one is kept. Returns the new state.
 */
export async function updateState(ctx, pr, changes) {
  const current = changes.current ?? (await readState(ctx.client, ctx.repo, pr));
  const next = {
    passes: changes.passes ?? current.passes,
    final: changes.final ?? current.final,
    review: changes.review === undefined ? current.review ?? null : changes.review,
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
  ctx.log.info(`Review state: ${changes.stage} [passes=${next.passes}, final=${next.final}${review}]`);
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
