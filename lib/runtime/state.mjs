// Persistent PR review state and the remediation decision.
//
// State lives in one PR comment authored by github-actions[bot]:
//
//   <!-- agent-review-state -->
//   <!-- passes=1 -->
//   <!-- final=not_started -->
//   ### Agent review status
//   ...
//
// Only github-actions[bot] comments are trusted as state, so a human cannot
// reset the remediation budget by pasting the markers into a comment.

export const STATE_MARKER = '<!-- agent-review-state -->';
export const AUTOMATION_LOGIN = 'github-actions[bot]';
export const FINAL_STATES = ['not_started', 'running', 'complete', 'blocked'];
export const ORIGINS = ['initial', 'opt-in', 'remediation', 'human-fix'];
export const COUNTABLE_ORIGINS = new Set(['initial', 'opt-in', 'remediation']);

const FINAL_LABELS = {
  not_started: 'Not started',
  running: 'Running',
  complete: 'Complete',
  blocked: 'Blocked — human input required',
};

export function parseState(body) {
  const passes = body.match(/^<!-- passes=(\d+) -->$/m);
  const final = body.match(/^<!-- final=([a-z_]+) -->$/m);
  return {
    passes: passes ? Number(passes[1]) : 0,
    final: final && FINAL_STATES.includes(final[1]) ? final[1] : 'not_started',
  };
}

export function renderState({ passes, final, maxPasses, escalationEnabled = true, stage, details }) {
  const finalLabel = final === 'not_started' && !escalationEnabled ? 'Disabled' : FINAL_LABELS[final] ?? final;
  let body = [
    STATE_MARKER,
    `<!-- passes=${passes} -->`,
    `<!-- final=${final} -->`,
    '### Agent review status',
    '',
    `**Stage:** ${stage}`,
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
  if (!comment) return { commentId: null, passes: 0, final: 'not_started' };
  return { commentId: comment.id, ...parseState(comment.body) };
}

/**
 * Merge `changes` ({passes?, final?, stage, details?}) into the current state
 * and write it. Returns the new state.
 */
export async function updateState(ctx, pr, changes) {
  const current = changes.current ?? (await readState(ctx.client, ctx.repo, pr));
  const next = {
    passes: changes.passes ?? current.passes,
    final: changes.final ?? current.final,
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
  ctx.log.info(`Review state: ${changes.stage} [passes=${next.passes}, final=${next.final}]`);
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
