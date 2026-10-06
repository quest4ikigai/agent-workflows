// Step-level orchestration used by the reusable workflows.
//
// Each exported function implements one workflow step. It receives a context
// (clients, config, outputs, logger) plus the step's inputs, performs GitHub
// side effects, sets outputs, and returns an exit code. The YAML only wires
// these steps together around the Claude sessions.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { BUILD_TITLE_PREFIX, LABELS, REVIEW_LABEL, checkOptedIn, checkPullRequest } from './gate.mjs';
import {
  codexFindings,
  hasCodexReviewOf,
  latestRequestOrigin,
  parseCompletionSignal,
  requestCodexReview,
  resolveReviewThreads,
  waitForCodex,
} from './codex.mjs';
import { ORIGIN_TEXT, decide, matchCompletion, readState, updateState } from './state.mjs';
import {
  VALIDATION_TEXT,
  claudeSucceeded,
  describeClaudeFailure,
  headMoved,
  parseResult,
  validationStatus,
  verifyWriteResult,
} from './results.mjs';

// Helpers -----------------------------------------------------------------------------

export async function comment(ctx, number, body) {
  try {
    await ctx.client.post(`repos/${ctx.repo.full}/issues/${number}/comments`, { body });
  } catch (err) {
    ctx.log.warning(`could not comment on #${number}: ${err.message}`);
  }
}

export async function ensureLabel(ctx, number, name) {
  try {
    await ctx.client.get(`repos/${ctx.repo.full}/labels/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    const meta = LABELS[name] ?? { color: 'ededed', description: '' };
    try {
      await ctx.client.post(`repos/${ctx.repo.full}/labels`, { name, color: meta.color, description: meta.description });
    } catch (createErr) {
      if (createErr.status !== 422) throw createErr; // 422: created concurrently
    }
  }
  await ctx.client.post(`repos/${ctx.repo.full}/issues/${number}/labels`, { labels: [name] });
}

export async function removeLabel(ctx, number, name) {
  try {
    await ctx.client.delete(`repos/${ctx.repo.full}/issues/${number}/labels/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err.status !== 404) ctx.log.warning(`could not remove label ${name} from #${number}: ${err.message}`);
  }
}

async function headSha(ctx, pr) {
  return (await ctx.client.get(`repos/${ctx.repo.full}/pulls/${pr}`)).head.sha;
}

/** The PR head ({ sha, ref }) after a write session; null (with a warning) if it cannot be read. */
async function headAfter(ctx, pr) {
  try {
    return (await ctx.client.get(`repos/${ctx.repo.full}/pulls/${pr}`)).head;
  } catch (err) {
    ctx.log.warning(`could not read the head of #${pr}: ${err.message}`);
    return null;
  }
}

/** Unresolved Codex findings for a prompt, or null (with a warning) if they cannot be read. */
async function collectCodexFindings(ctx, pr, options) {
  try {
    const collected = await codexFindings(ctx.client, ctx.repo, pr, options);
    ctx.log.info(
      `Unresolved Codex findings: ${collected.findings.length} current, ${collected.addressed} already addressed, ${collected.outdated} outdated, ${collected.omitted} not shown.`,
    );
    return collected;
  } catch (err) {
    ctx.log.warning(`could not collect unresolved Codex review threads: ${err.message}`);
    return null;
  }
}

/**
 * Whether `head` is the verified fix commit `fix` or descends from it, i.e. the
 * fix is still in the branch. A merge from the base keeps it; a rebase or
 * force-push that drops it does not. Anything unknown (an API error, a commit
 * GitHub no longer has) counts as no.
 */
async function containsCommit(ctx, fix, head) {
  if (fix === head) return true;
  try {
    const compare = await ctx.client.get(`repos/${ctx.repo.full}/compare/${fix}...${head}?per_page=1`);
    return compare.status === 'ahead' || compare.status === 'identical';
  } catch (err) {
    if (err.status !== 404 && err.status !== 422) ctx.log.warning(`could not compare ${short(fix)} with ${short(head)}: ${err.message}`);
    return false;
  }
}

/**
 * The addressed records the branch at `head` still backs: thread IDs whose
 * recorded fix commit `head` contains. A record is evidence of a fix only while
 * that fix is in the branch. Returns { threads, lost }, `lost` counting threads
 * none of whose fix commits remain.
 */
async function trustedAddressed(ctx, addressed, head) {
  const inBranch = new Map();
  for (const sha of new Set(addressed.map((a) => a.sha))) inBranch.set(sha, await containsCommit(ctx, sha, head));
  const threads = new Set(addressed.filter((a) => inBranch.get(a.sha)).map((a) => a.thread));
  const lost = new Set(addressed.filter((a) => !threads.has(a.thread)).map((a) => a.thread)).size;
  if (lost) ctx.log.notice(`${lost} Codex finding(s) recorded as fixed count again: their fix commit is no longer in the branch at ${short(head)}.`);
  return { threads: [...threads], lost };
}

/**
 * Try to resolve on GitHub the threads a verified, validated pass fixed (never
 * others). GitHub lets only tokens with Contents: write resolve review threads,
 * and agent-workflows' tokens are read-only by design, so they normally stay
 * open; the caller records them as addressed instead, which is what readiness
 * uses. Returns a note for the status comment, or ''.
 */
async function settleCodexThreads(ctx, ids) {
  const { failed } = await resolveReviewThreads(ctx.client, ids, ctx.log.info);
  if (!failed) return '';
  return `${failed} of these thread(s) stay open on GitHub: resolving a thread needs Contents: write, which agent-workflows' tokens deliberately do not have. Resolve them when you accept the pull request.`;
}

/**
 * Open Codex findings no verified fix in the branch at `head` addressed, when
 * automation ends; null if they cannot be listed. A final audit judging them
 * non-actionable is a judgement, not a fix, so they await a human decision.
 */
async function unaddressedFindings(ctx, pr, head) {
  try {
    const { addressed } = await readState(ctx.client, ctx.repo, pr);
    const trusted = await trustedAddressed(ctx, addressed, head);
    return (await codexFindings(ctx.client, ctx.repo, pr, { addressed: trusted.threads, textLimit: Infinity })).findings.length;
  } catch (err) {
    ctx.log.warning(`could not list Codex review threads: ${err.message}`);
    return null;
  }
}

/** Status text for the end of automation, given unaddressedFindings(). */
function humanDecisionNote(open, why) {
  if (open === 0) return null;
  if (open === null) return "The open Codex review threads could not be listed; check them before accepting the pull request.";
  return `${open} open Codex finding(s) were not fixed by a verified push: ${why} That is a judgement, not a fix, so they are not recorded as addressed. Decide whether each is resolved before accepting the pull request.`;
}

const short = (sha) => (sha ? sha.slice(0, 7) : 'unknown');
const pushedNote = (before, after) =>
  `Claude pushed commits before stopping (${short(before)} → ${short(after)}); they have not been validated or re-reviewed.`;
const quoteBlock = (s) => (s || '(none)').trim().split('\n').map((l) => `> ${l}`).join('\n');

function needAgentClient(ctx) {
  if (!ctx.agentClient) throw new Error('AGENT_GITHUB_TOKEN is required for this step');
  return ctx.agentClient;
}

async function agentLogin(ctx) {
  if (ctx.agentLogin === undefined) {
    try {
      ctx.agentLogin = (await needAgentClient(ctx).get('user')).login;
    } catch (err) {
      ctx.log.warning(`could not identify the AGENT_GITHUB_TOKEN user: ${err.message}`);
      ctx.agentLogin = null;
    }
  }
  return ctx.agentLogin;
}

/** Re-validate a PR inside the concurrency lock. Returns the PR or null. */
async function recheckPullRequest(ctx, pr, { requireOptIn }) {
  const check = await checkPullRequest(ctx.client, ctx.repo, ctx.config, pr);
  if (!check.eligible) {
    ctx.log.notice(`PR #${pr} is no longer eligible: ${check.reason}`);
    return null;
  }
  if (requireOptIn) {
    const opt = await checkOptedIn(ctx.client, ctx.repo, ctx.config, check.pr);
    if (!opt.optedIn) {
      ctx.log.notice(`PR #${pr}: ${opt.reason}`);
      return null;
    }
  }
  return check.pr;
}

// Path A: implementation ------------------------------------------------------------------

/**
 * Work branch for an issue: `<prefix>issue-<n>-<first five title words>`, the
 * shape claude-code-action's tag mode used before Path A moved to agent mode.
 */
export function workBranchName(prefix, issueNumber, title) {
  let text = (title || '').trim();
  if (text.startsWith(BUILD_TITLE_PREFIX)) text = text.slice(BUILD_TITLE_PREFIX.length);
  const slug = text
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${prefix}issue-${issueNumber}-${slug || 'implementation'}`;
}

/** Whether `branch` has commits ahead of `base` on GitHub: true, false (also when it was never pushed) or null. */
async function branchAhead(ctx, base, branch) {
  try {
    const compare = await ctx.client.get(`repos/${ctx.repo.full}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`);
    return compare.ahead_by > 0;
  } catch (err) {
    if (err.status === 404) return false;
    ctx.log.warning(`could not compare ${branch} with ${base}: ${err.message}`);
    return null;
  }
}

async function branchExists(ctx, name) {
  try {
    await ctx.client.get(`repos/${ctx.repo.full}/branches/${encodeURIComponent(name)}`);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

/**
 * Refuse to start when an open agent PR for this issue already exists; otherwise
 * choose a work branch that does not exist yet. The workflow creates it from
 * base_branch before Claude runs, so claude-code-action runs in agent mode and
 * never fetches before installing its own credential (see credentials.mjs).
 */
export async function preflightImplement(ctx, { issueNumber }) {
  const issue = await ctx.client.get(`repos/${ctx.repo.full}/issues/${issueNumber}`);
  if (issue.state !== 'open') {
    ctx.log.notice(`issue #${issueNumber} is closed; nothing to do`);
    ctx.outputs.set('proceed', 'false');
    return 0;
  }
  const prefix = `${ctx.config.branch_prefix}issue-${issueNumber}-`;
  const pulls = await ctx.client.paginate(`repos/${ctx.repo.full}/pulls?state=open`);
  const existing = pulls.find((p) => p.head?.ref?.startsWith(prefix) && p.head?.repo?.full_name === ctx.repo.full);
  if (existing) {
    await comment(
      ctx,
      issueNumber,
      `Agent implementation was not started: #${existing.number} is already open for this issue. ` +
        'Close it to start over, or comment `/agent-fix <feedback>` on it to request changes.',
    );
    ctx.outputs.set('proceed', 'false');
    return 0;
  }
  const name = workBranchName(ctx.config.branch_prefix, issueNumber, issue.title);
  const candidates = [name, `${name}-${ctx.env.GITHUB_RUN_ID || Date.now()}`];
  let branch;
  for (const candidate of candidates) {
    if (!(await branchExists(ctx, candidate))) {
      branch = candidate;
      break;
    }
  }
  if (!branch) {
    await comment(ctx, issueNumber, `Agent implementation was not started: branches ${candidates.map((b) => `\`${b}\``).join(' and ')} already exist. Delete them to start over.`);
    ctx.outputs.set('proceed', 'false');
    return 0;
  }
  ctx.log.info(`Work branch: ${branch}`);
  ctx.outputs.set('branch', branch);
  ctx.outputs.set('proceed', 'true');
  return 0;
}

export function prTitle(issueTitle, issueNumber) {
  let title = (issueTitle || '').trim();
  if (title.startsWith(BUILD_TITLE_PREFIX)) title = title.slice(BUILD_TITLE_PREFIX.length).trim();
  return title || `Implement #${issueNumber}`;
}

export function prBody({ config, issueNumber, result, validation, footer }) {
  const remediation =
    config.remediation.max_passes > 0
      ? `Claude Code (\`${config.remediation.model}\`), up to ${config.remediation.max_passes} automated pass(es)`
      : 'none (max_passes is 0)';
  const escalation = config.escalation.enabled
    ? `one holistic \`${config.escalation.model}\` audit and consolidated fix`
    : 'disabled';
  const scriptName = config.validation.script ? ` (\`${config.validation.script}\`)` : '';
  const parts = [
    `Implements #${issueNumber}`,
    '',
    '## Agent workflow',
    '',
    `- Design contract: issue #${issueNumber}, approved by a trusted user`,
    `- Implementation: Claude Code (\`${config.implementation.model}\`)`,
    '- Independent review: Codex GitHub code review',
    `- Remediation: ${remediation}`,
    `- Escalation if needed: ${escalation}`,
    '- Final acceptance: a human',
    '',
    '## Claude summary',
    '',
    result.summary || '(no summary provided)',
    '',
    '## Validation',
    '',
    `**Repository validation${scriptName}:** ${VALIDATION_TEXT[validation]}`,
    '',
    'Claude reported:',
    '',
    quoteBlock(result.validation),
  ];
  if (footer) parts.push('', footer.trim());
  parts.push(
    '',
    '---',
    '<sub>Opened by agent-workflows. This pull request must not be merged automatically; a human decides whether to accept it.</sub>',
  );
  return parts.join('\n');
}

function readFooter(ctx) {
  const file = ctx.config.pull_request.footer;
  if (!file) return null;
  const full = path.join(ctx.workspace, file);
  if (!existsSync(full)) {
    ctx.log.warning(`pull_request.footer ${file} not found; omitted from the PR body`);
    return null;
  }
  return readFileSync(full, 'utf8').slice(0, 10000);
}

export async function finishImplement(ctx, inputs) {
  const issue = inputs.issueNumber;
  ctx.outputs.set('request_review', 'false');
  if (inputs.preflight !== 'true') return 0;

  const fail = async (message) => {
    await comment(ctx, issue, `Agent implementation did not complete: ${message}.\n\nWorkflow run: ${ctx.runUrl}`);
    ctx.log.error(message);
    return 1;
  };

  if (inputs.setupOutcome && inputs.setupOutcome !== 'success') return fail('environment setup failed before Claude started');
  if (!claudeSucceeded(inputs.claudeOutcome, inputs.claudeConclusion)) {
    return fail(describeClaudeFailure(inputs.claudeOutcome, inputs.claudeConclusion));
  }
  const result = parseResult('implement', inputs.rawResult);
  if (!result.ok) return fail(result.error);

  // Never open a PR from anything but a fresh feature branch with real commits.
  const branch = inputs.branch;
  const base = ctx.config.base_branch;
  const isWorkBranch = !!branch && branch.startsWith(ctx.config.branch_prefix) && branch !== base;
  if (result.status === 'implemented' && !isWorkBranch) {
    return fail(`Claude reported success but the work branch (${branch || 'none'}) is not a ${ctx.config.branch_prefix} feature branch`);
  }
  const ahead = isWorkBranch ? await branchAhead(ctx, base, branch) : null;
  const check = verifyWriteResult({ status: result.status, moved: ahead, branch });
  if (!check.ok) return fail(`${check.error} Treating this as an invalid implementation result; no pull request was opened`);
  if (result.status !== 'implemented') {
    const note = ahead ? `\n\nClaude pushed commits to \`${branch}\` before stopping; no pull request was opened.` : '';
    await comment(ctx, issue, `Agent implementation stopped with status \`${result.status}\`.\n\n${result.summary}${note}`);
    return 0;
  }

  const validation = validationStatus(inputs.validationOutcome, inputs.validationResult);
  const agent = needAgentClient(ctx);
  const body = prBody({ config: ctx.config, issueNumber: issue, result, validation, footer: readFooter(ctx) });

  // Opened with AGENT_GITHUB_TOKEN so the pull_request event starts CI.
  const open = await ctx.client.paginate(`repos/${ctx.repo.full}/pulls?state=open&base=${encodeURIComponent(base)}`);
  let pr = open.find((p) => p.head?.ref === branch && p.head?.repo?.full_name === ctx.repo.full);
  if (!pr) {
    pr = await agent.post(`repos/${ctx.repo.full}/pulls`, { title: prTitle(inputs.issueTitle, issue), head: branch, base, body });
  }
  ctx.outputs.set('pr_number', pr.number);
  ctx.log.notice(`Pull request #${pr.number} opened from ${branch}`);

  // Labelled with GITHUB_TOKEN so the label does not re-trigger the opt-in flow.
  await ensureLabel(ctx, pr.number, REVIEW_LABEL);

  if (validation === 'failed') {
    await updateState(ctx, pr.number, {
      passes: 0,
      final: 'not_started',
      stage: 'Implementation pushed, but repository validation failed; Codex review was not requested.',
      details: `Fix the failure (for example with \`/agent-fix <instructions>\`), then comment \`/agent-review\` to start the review cycle.\n\nWorkflow run: ${ctx.runUrl}`,
    });
    ctx.log.error('repository validation failed after implementation');
    return 1;
  }
  await updateState(ctx, pr.number, {
    passes: 0,
    final: 'not_started',
    stage: 'Initial implementation complete; requesting Codex review.',
    details: `The automated remediation budget starts at 0/${ctx.config.remediation.max_passes}. Manual reviews and \`/agent-fix\` do not consume it.`,
  });
  ctx.outputs.set('request_review', 'true');
  return 0;
}

// Review cycle (shared by every path) ---------------------------------------------------

const COMPLETION_SOURCE_TEXT = {
  polling: 'the monitoring job',
  summary: "Codex's review summary",
  'clean-comment': "Codex's result comment",
};
const AWAITING =
  "Findings start automated remediation through Codex's pull request review; a clean result is recorded here when Codex reports it.";

/**
 * Request a Codex review and record it, with the exact head SHA, as the review
 * being awaited. With codex.wait_minutes > 0, also poll (bounded) for the outcome.
 */
export async function reviewCycle(ctx, { pr, origin }) {
  const agent = needAgentClient(ctx);
  const sha = await headSha(ctx, pr);
  const request = await requestCodexReview({ client: ctx.client, agentClient: agent, repo: ctx.repo, pr, origin });
  const review = { sha, status: 'requested', origin, requestedAt: request.createdAt ?? null, requestId: request.requestId ?? null, completedAt: null };
  const waitMinutes = ctx.config.codex.wait_minutes;
  const what = ORIGIN_TEXT[origin] ?? 'review';

  if (waitMinutes === 0) {
    await updateState(ctx, pr, {
      review,
      stage: `Codex ${what} requested; awaiting completion signal.`,
      details: `No Codex completion signal has been received yet, and no runner waits for one (\`codex.wait_minutes\` is 0). ${AWAITING}`,
    });
    ctx.outputs.set('result', 'requested');
    return 0;
  }
  await updateState(ctx, pr, {
    review,
    stage: `Codex ${what} running; awaiting completion signal.`,
    details: `Monitoring for up to ${waitMinutes} minute(s). ${AWAITING}`,
  });
  const result = await waitForCodex({
    client: agent,
    repo: ctx.repo,
    pr,
    ...request,
    reviewSha: sha,
    timeoutMs: waitMinutes * 60000,
    pollMs: ctx.pollMs ?? 15000,
    sleep: ctx.sleep,
    now: ctx.now,
    log: ctx.log.info,
  });
  ctx.outputs.set('result', result);
  if (result === 'clean') {
    await applyCodexCompletion(ctx, pr, { commit: sha, at: null, source: 'polling' });
  } else if (result === 'pending') {
    await updateState(ctx, pr, {
      stage: `Codex review is still running beyond the ${waitMinutes}-minute monitor window; awaiting completion signal.`,
      details:
        'The monitor window ended, which does not mean Codex failed. A later Codex review or completion signal still updates this status; if none ever arrives, comment `/agent-review` to request a new review.',
    });
  } else {
    await updateState(ctx, pr, {
      review: { ...review, status: 'findings' },
      stage: 'Codex submitted findings; automated remediation will pick them up.',
      details: `Reviewed commit ${short(sha)}.`,
    });
  }
  return 0;
}

/**
 * Apply a Codex completion signal for `commit` (a SHA prefix) to the review
 * state. Shared by polling and the issue_comment events. Only a `requested`
 * review whose SHA the commit identifies, and which is still the PR head,
 * changes; a duplicate, stale or uncorrelated signal is logged and ignored, so
 * repeated signals are harmless and a known findings result is never turned
 * clean. Returns clean | findings | outdated | unknown | stale | duplicate | finished.
 */
async function applyCodexCompletion(ctx, pr, { commit, at, source }) {
  const state = await readState(ctx.client, ctx.repo, pr);
  const match = matchCompletion(state, commit);
  const what = `Codex completion from ${COMPLETION_SOURCE_TEXT[source] ?? source} (commit ${String(commit).slice(0, 10)})`;
  if (!match.ok) {
    ctx.log.notice(`${what} left the review state unchanged: ${match.reason}.`);
    return match.outcome;
  }
  const review = state.review;
  const head = await headSha(ctx, pr);
  if (head !== review.sha) {
    ctx.log.notice(`${what} is for ${short(review.sha)}, but the pull request head is now ${short(head)}.`);
    await updateState(ctx, pr, {
      current: state,
      review: { ...review, status: 'outdated', completedAt: at ?? null },
      stage: `Codex review of ${short(review.sha)} completed, but the pull request head has moved to ${short(head)}; not ready for human acceptance.`,
      details: 'The result does not cover the current head. Comment `/agent-review` to request a review of it.',
    });
    return 'outdated';
  }
  // "Completed" is not "clean": Codex's pull request review of this commit is
  // its findings result, and unresolved Codex threads are still actionable.
  // Threads fixed by a verified push still in the branch stay open on GitHub
  // (see settleCodexThreads) but are not actionable.
  const formal = await hasCodexReviewOf(ctx.client, ctx.repo, pr, review.sha, { since: review.requestedAt });
  const trusted = await trustedAddressed(ctx, state.addressed, head);
  const { findings, addressed } = await codexFindings(ctx.client, ctx.repo, pr, { addressed: trusted.threads, textLimit: Infinity });
  const lostNote = trusted.lost ? `${trusted.lost} finding(s) recorded as fixed count again, because the commit that fixed them is no longer in the branch.` : null;
  const done = { ...review, completedAt: at ?? null };
  if (formal) {
    await updateState(ctx, pr, {
      current: state,
      review: { ...done, status: 'findings' },
      stage: 'Codex review completed with actionable findings; awaiting automated remediation.',
      details: `Codex submitted a pull request review of ${short(review.sha)} (${findings.length} unresolved finding thread(s)); that review starts automated remediation.`,
    });
    return 'findings';
  }
  if (findings.length) {
    await updateState(ctx, pr, {
      current: state,
      review: { ...done, status: 'findings' },
      stage: `Codex review completed without new findings, but ${findings.length} earlier unresolved Codex finding(s) remain; human input required.`,
      details: [
        lostNote,
        'Resolve the threads that are already addressed, or comment `/agent-fix <instructions>`; comment `/agent-review` to request a fresh review.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    return 'findings';
  }
  await updateState(ctx, pr, {
    current: state,
    review: { ...done, status: 'clean' },
    stage: 'Codex review completed with no actionable findings.',
    details: [
      `Reported by ${COMPLETION_SOURCE_TEXT[source] ?? source}; no unresolved Codex findings remain.`,
      addressed
        ? `${addressed} Codex thread(s) fixed by verified remediation passes are still open on GitHub, because resolving needs Contents: write; resolve them when you accept.`
        : null,
      'When CI passes, this pull request is ready for human acceptance.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
  return 'clean';
}

/**
 * Record a Codex completion signal delivered as a PR issue comment: the
 * persistent review summary (edited) or the clean-result comment (created).
 */
export async function recordCodexCompletion(ctx, { pr }) {
  ctx.outputs.set('result', 'ignored');
  const current = await recheckPullRequest(ctx, pr, { requireOptIn: true });
  if (!current) return 0;
  const signal = parseCompletionSignal(ctx.event?.comment);
  if (signal.ignored) {
    ctx.log.notice(`Comment ${ctx.event?.comment?.id ?? ''} is not a Codex completion signal: ${signal.ignored}.`);
    return 0;
  }
  ctx.outputs.set('result', await applyCodexCompletion(ctx, pr, signal));
  return 0;
}

// Path B: opt-in -----------------------------------------------------------------------------

export async function startReview(ctx, { pr, actor, via }) {
  const current = await recheckPullRequest(ctx, pr, { requireOptIn: false });
  if (!current) return 0;
  if (!(current.labels || []).some((l) => l.name === REVIEW_LABEL)) await ensureLabel(ctx, pr, REVIEW_LABEL);
  const how = via === 'label' ? `the \`${REVIEW_LABEL}\` label` : '`/agent-review`';
  await updateState(ctx, pr, {
    passes: 0,
    final: 'not_started',
    stage: `Opted in to agent review by @${actor} via ${how}; requesting Codex review.`,
    details: `A fresh automated remediation budget of ${ctx.config.remediation.max_passes} pass(es) starts now.`,
  });
  return reviewCycle(ctx, { pr, origin: 'opt-in' });
}

// Remediation and escalation -------------------------------------------------------------

export async function planRemediation(ctx, { pr }) {
  ctx.outputs.set('mode', 'none');
  const current = await recheckPullRequest(ctx, pr, { requireOptIn: true });
  if (!current) return 0;
  const state = await readState(ctx.client, ctx.repo, pr);
  const origin = await latestRequestOrigin(ctx.client, ctx.repo, pr, await agentLogin(ctx));
  const max = ctx.config.remediation.max_passes;
  const d = decide({ passes: state.passes, final: state.final, origin, maxPasses: max, escalationEnabled: ctx.config.escalation.enabled });

  ctx.outputs.set('mode', d.mode);
  ctx.outputs.set('passes', state.passes);
  ctx.outputs.set('countable', d.countable);
  ctx.outputs.set('origin', origin);
  ctx.outputs.set('head_ref', current.head.ref);
  ctx.outputs.set('head_sha', current.head.sha);
  ctx.log.info(`Review origin: ${origin}; passes ${state.passes}/${max}; final audit ${state.final}; decision: ${d.mode}`);

  // Codex's pull request review is its findings result for the commit it
  // reviewed; recording that keeps a later completion signal from marking it clean.
  const reviewed = /^[0-9a-f]{40}$/.test(ctx.event?.review?.commit_id || '') ? ctx.event.review.commit_id : current.head.sha;
  const tracked = state.review?.sha === reviewed ? state.review : { sha: reviewed, origin, requestedAt: null, requestId: null };
  const review = { ...tracked, status: 'findings', completedAt: ctx.event?.review?.submitted_at ?? null };

  switch (d.mode) {
    case 'remediate': {
      // Inline findings, not just the review body, go into the prompt.
      const trusted = await trustedAddressed(ctx, state.addressed, current.head.sha);
      const collected = await collectCodexFindings(ctx, pr, { latestReviewId: ctx.event?.review?.id ?? null, addressed: trusted.threads });
      ctx.outputs.set('codex_findings', collected ? JSON.stringify(collected) : '');
      await updateState(ctx, pr, {
        current: state,
        review,
        stage: d.countable
          ? `Codex findings received; automated remediation pass ${state.passes + 1}/${max} is running.`
          : 'Codex findings received; remediation is running without consuming the automated budget.',
        details: `Review trigger origin: ${origin}.`,
      });
      break;
    }
    case 'escalate':
      await updateState(ctx, pr, {
        current: state,
        review,
        final: 'running',
        stage: `Automated remediation budget exhausted; holistic final audit (\`${ctx.config.escalation.model}\`) is running.`,
        details: 'The audit reviews the entire pull request and all prior findings in one read-only pass.',
      });
      break;
    case 'exhausted':
      await updateState(ctx, pr, {
        current: state,
        review,
        final: 'blocked',
        stage: 'Automated remediation budget exhausted and escalation is disabled; human input required.',
        details: 'Use `/agent-fix <feedback>` or `/agent-review` to start a fresh cycle.',
      });
      await comment(ctx, pr, `Codex still reports findings after ${max} automated remediation pass(es), and escalation is disabled. Human input is required.`);
      break;
    default:
      ctx.log.notice(`Automated review for PR #${pr} has already finished (final audit: ${state.final}); this review is left for the human.`);
  }
  return 0;
}

/**
 * Finish a normal remediation pass. The structured status is checked against
 * the PR head first, and a pass is consumed only by a verified, pushed fix:
 * blocked, no_change, invalid and crashed attempts leave the budget unchanged.
 */
export async function finishRemediation(ctx, inputs) {
  const pr = inputs.pr;
  ctx.outputs.set('request_review', 'false');
  const stop = async (stage, message, code = 0) => {
    await updateState(ctx, pr, { stage, details: `${message}\n\nWorkflow run: ${ctx.runUrl}` });
    await comment(ctx, pr, `${stage}\n\n${message}`);
    return code;
  };
  const unchanged = 'No remediation pass was consumed and no re-review was requested.';

  if (!claudeSucceeded(inputs.claudeOutcome, inputs.claudeConclusion)) {
    return stop('Automated remediation did not complete; human input required.', describeClaudeFailure(inputs.claudeOutcome, inputs.claudeConclusion), 1);
  }
  const result = parseResult('remediate', inputs.rawResult);
  if (!result.ok) return stop('Automated remediation did not complete; human input required.', result.error, 1);

  const head = await headAfter(ctx, pr);
  const moved = headMoved(inputs.headSha, head?.sha);
  const check = verifyWriteResult({ status: result.status, moved, branch: head?.ref });
  if (!check.ok) {
    return stop(
      'Invalid remediation result; human input required.',
      `${check.error}\nTreating this as an invalid remediation result; human input is required. ${unchanged}\n\n**Claude's summary:** ${result.summary || '(none)'}`,
      1,
    );
  }
  if (result.status === 'blocked') {
    return stop(
      'Claude could not safely resolve the latest Codex review; human input required.',
      [`**Reason:** ${result.summary}`, `**Validation:** ${result.validation || '(none)'}`, moved ? pushedNote(inputs.headSha, head.sha) : null, unchanged]
        .filter(Boolean)
        .join('\n\n'),
    );
  }
  if (result.status === 'no_change') {
    // Never declare the review clean on Claude's word: the Codex threads stay
    // open and a human accepts or dismisses them.
    let remaining;
    try {
      const trusted = await trustedAddressed(ctx, (await readState(ctx.client, ctx.repo, pr)).addressed, head.sha);
      const { findings, outdated } = await codexFindings(ctx.client, ctx.repo, pr, { addressed: trusted.threads, textLimit: Infinity });
      remaining = findings.length
        ? `${findings.length} unresolved Codex review thread(s) remain. Human input is required to accept or dismiss them.`
        : `No current unresolved Codex review threads remain${outdated ? ` (${outdated} outdated)` : ''}, but the review is not declared clean on Claude's word. Human input is required to confirm the latest Codex review is addressed.`;
    } catch (err) {
      ctx.log.warning(`could not list review threads: ${err.message}`);
      remaining = 'The remaining Codex review threads could not be listed. Human input is required to accept or dismiss the Codex findings.';
    }
    return stop(
      'Claude determined no repository change is warranted for the current Codex findings; human input required.',
      [remaining, `**Claude's explanation:** ${result.summary || '(none)'}`, unchanged].join('\n\n'),
    );
  }

  // fixed, and the branch really moved: a remediation pass happened.
  const passes = Number(inputs.passes) + (inputs.countable === 'true' ? 1 : 0);
  const validation = validationStatus(inputs.validationOutcome, inputs.validationResult);
  if (validation === 'failed') {
    // The pushed commit consumed the pass; automation pauses rather than re-reviewing a broken branch.
    await updateState(ctx, pr, {
      passes,
      stage: 'Remediation pushed, but repository validation failed; automated review paused.',
      details: `Use \`/agent-fix <instructions>\` or fix the branch manually, then comment \`/agent-review\`.\n\nWorkflow run: ${ctx.runUrl}`,
    });
    await comment(ctx, pr, `Remediation was pushed, but repository validation failed, so no re-review was requested.\n\nWorkflow run: ${ctx.runUrl}`);
    ctx.log.error('repository validation failed after remediation');
    return 1;
  }
  // Claude was given these findings as authoritative and made a verified,
  // validated fix: they are addressed by this head, whether or not GitHub lets
  // us resolve the threads. Nothing else is: not outdated threads, not findings
  // Claude was not shown.
  const fixedThreads = (inputs.codexFindings?.findings ?? []).map((f) => f.thread);
  const openNote = await settleCodexThreads(ctx, fixedThreads);
  await updateState(ctx, pr, {
    passes,
    addressThreads: fixedThreads.map((thread) => ({ thread, sha: head.sha })),
    stage: 'Claude remediation complete; requesting Codex re-review.',
    details: [
      `Pushed ${short(inputs.headSha)} → ${short(head.sha)}. Automated remediation budget used: ${passes}/${ctx.config.remediation.max_passes}. Repository validation: ${VALIDATION_TEXT[validation]}.`,
      inputs.codexFindings
        ? `Recorded ${fixedThreads.length} Codex finding(s) from this pass as addressed by ${short(head.sha)}.`
        : 'The Codex findings for this pass could not be listed, so none were recorded as addressed.',
      openNote,
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
  ctx.outputs.set('request_review', 'true');
  return 0;
}

export async function finishAudit(ctx, inputs) {
  const pr = inputs.pr;
  ctx.outputs.set('run_fix', 'false');
  const block = async (stage, message, code = 0) => {
    await updateState(ctx, pr, { final: 'blocked', stage, details: `${message}\n\nWorkflow run: ${ctx.runUrl}` });
    await comment(ctx, pr, `${stage}\n\n${message}`);
    return code;
  };

  const after = await headSha(ctx, pr);
  if (after !== inputs.headSha) {
    return block('The read-only final audit changed the branch unexpectedly; human input required.', `Head moved from ${short(inputs.headSha)} to ${short(after)}.`, 1);
  }
  if (!claudeSucceeded(inputs.claudeOutcome, inputs.claudeConclusion)) {
    return block('The holistic final audit did not complete; human input required.', describeClaudeFailure(inputs.claudeOutcome, inputs.claudeConclusion), 1);
  }
  const result = parseResult('audit', inputs.rawResult);
  if (!result.ok) return block('The holistic final audit did not complete; human input required.', result.error, 1);

  if (result.status === 'clean') {
    // A read-only audit adjudicates; it fixes nothing. Open findings it judged
    // non-actionable are neither resolved nor recorded as addressed.
    const open = await unaddressedFindings(ctx, pr, after);
    const decision = humanDecisionNote(open, 'the final audit judged them non-actionable.');
    await updateState(ctx, pr, {
      final: 'complete',
      stage: decision
        ? 'Holistic final audit completed cleanly, but open Codex findings await a human decision; automated review is finished.'
        : 'Holistic final audit completed cleanly; automated review is finished.',
      details: [result.summary, decision ?? 'When CI passes, this pull request is ready for human acceptance.'].join('\n\n'),
    });
    return 0;
  }
  if (result.status === 'blocked') {
    return block('The final audit found a design/product decision that requires human input.', `**Reason:** ${result.summary}`);
  }
  await updateState(ctx, pr, {
    stage: `Final audit found ${result.findings.length} issue(s); consolidated fix (\`${ctx.config.escalation.model}\`) is running.`,
    details: result.summary,
  });
  ctx.outputs.set('run_fix', 'true');
  ctx.outputs.set('findings', JSON.stringify(result.findings, null, 2));
  ctx.outputs.set('summary', result.summary);
  return 0;
}

/**
 * Finish the consolidated final fix, the terminal automated stage. Automation is
 * declared complete only for a verified, pushed fix that passed validation;
 * every other outcome ends blocked for a human.
 */
export async function finishFinalFix(ctx, inputs) {
  const pr = inputs.pr;
  const block = async (stage, message, code = 0) => {
    await updateState(ctx, pr, { final: 'blocked', stage, details: `${message}\n\nWorkflow run: ${ctx.runUrl}` });
    await comment(ctx, pr, `${stage}\n\n${message}`);
    return code;
  };
  if (!claudeSucceeded(inputs.claudeOutcome, inputs.claudeConclusion)) {
    return block('The consolidated final fix did not complete; human input required.', describeClaudeFailure(inputs.claudeOutcome, inputs.claudeConclusion), 1);
  }
  const result = parseResult('final-fix', inputs.rawResult);
  if (!result.ok) return block('The consolidated final fix did not complete; human input required.', result.error, 1);

  const head = await headAfter(ctx, pr);
  const moved = headMoved(inputs.headSha, head?.sha);
  const check = verifyWriteResult({ status: result.status, moved, branch: head?.ref });
  if (!check.ok) {
    return block(
      'Invalid consolidated final-fix result; human input required.',
      `${check.error}\nTreating this as an invalid final-fix result; automated review has ended without completing.\n\n**Claude's summary:** ${result.summary || '(none)'}`,
      1,
    );
  }
  if (result.status === 'blocked') {
    return block(
      'Consolidated final remediation needs human input.',
      [`**Reason:** ${result.summary}`, `**Validation:** ${result.validation || '(none)'}`, moved ? pushedNote(inputs.headSha, head.sha) : null].filter(Boolean).join('\n\n'),
    );
  }
  if (result.status === 'no_change') {
    return block(
      'The consolidated final fix made no changes; human input required.',
      [
        'The final audit reported findings, but the consolidated fix concluded that none warrants a repository change. Automated review has ended without being declared complete; a human decides whether to accept or dismiss the audit findings.',
        `**Audit:** ${inputs.auditSummary || '(none)'}`,
        `**Final fix:** ${result.summary || '(none)'}`,
      ].join('\n\n'),
    );
  }
  const validation = validationStatus(inputs.validationOutcome, inputs.validationResult);
  if (validation === 'failed') {
    return block('The consolidated final fix was pushed, but repository validation failed; human input required.', result.summary, 1);
  }
  // The consolidated fix was given the audit's findings, not the Codex
  // threads, so it records no thread as addressed: which threads it fixed is
  // the audit's judgement, not evidence.
  const open = await unaddressedFindings(ctx, pr, head.sha);
  const decision = humanDecisionNote(open, "the consolidated fix was given the audit's findings, not these threads, and the audit judged them covered or non-actionable.");
  await updateState(ctx, pr, {
    final: 'complete',
    stage: decision
      ? 'Final audit and consolidated remediation complete, but open Codex findings await a human decision; automated review is finished.'
      : 'Final audit and consolidated remediation complete; automated review is finished.',
    details: [
      `**Audit:** ${inputs.auditSummary || '(none)'}`,
      `**Final fix:** ${result.summary} (pushed ${short(inputs.headSha)} → ${short(head.sha)})`,
      `**Repository validation:** ${VALIDATION_TEXT[validation]}`,
      decision,
      decision ? 'No further automated review will run.' : 'No further automated review will run. When CI passes, this pull request is ready for human acceptance.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
  return 0;
}

// Human-requested fix ------------------------------------------------------------------------

export async function prepareHumanFix(ctx, { pr, actor }) {
  ctx.outputs.set('proceed', 'false');
  const current = await recheckPullRequest(ctx, pr, { requireOptIn: false });
  if (!current) return 0;
  if (!(current.labels || []).some((l) => l.name === REVIEW_LABEL)) await ensureLabel(ctx, pr, REVIEW_LABEL);
  // A human intervening ends the wait for a pending Codex review: its result must
  // not later overwrite this fix's outcome. A pushed fix requests a new review.
  const state = await readState(ctx.client, ctx.repo, pr);
  await updateState(ctx, pr, {
    current: state,
    review: state.review?.status === 'requested' ? null : state.review,
    stage: `Owner-requested fix (\`/agent-fix\` by @${actor}) is running.`,
    details: `Workflow run: ${ctx.runUrl}`,
  });
  const trusted = await trustedAddressed(ctx, state.addressed, current.head.sha);
  const collected = await collectCodexFindings(ctx, pr, { addressed: trusted.threads });
  ctx.outputs.set('codex_findings', collected ? JSON.stringify(collected) : '');
  ctx.outputs.set('proceed', 'true');
  ctx.outputs.set('head_ref', current.head.ref);
  ctx.outputs.set('head_sha', current.head.sha);
  return 0;
}

/**
 * Finish an owner-requested fix. A fresh budget and a Codex review follow only a
 * verified, pushed fix that passed validation.
 */
export async function finishHumanFix(ctx, inputs) {
  const pr = inputs.pr;
  ctx.outputs.set('request_review', 'false');
  if (inputs.proceed !== 'true') return 0;
  const report = async (stage, message, code = 0) => {
    await updateState(ctx, pr, { stage, details: `${message}\n\nWorkflow run: ${ctx.runUrl}` });
    await comment(ctx, pr, `${stage}\n\n${message}`);
    return code;
  };
  if (inputs.setupOutcome && inputs.setupOutcome !== 'success') {
    return report('Owner-requested fix did not start; human input required.', 'Environment setup failed before Claude started.', 1);
  }
  if (!claudeSucceeded(inputs.claudeOutcome, inputs.claudeConclusion)) {
    return report('Owner-requested fix did not complete; human input required.', describeClaudeFailure(inputs.claudeOutcome, inputs.claudeConclusion), 1);
  }
  const result = parseResult('human-fix', inputs.rawResult);
  if (!result.ok) return report('Owner-requested fix did not complete; human input required.', result.error, 1);

  const head = await headAfter(ctx, pr);
  const moved = headMoved(inputs.headSha, head?.sha);
  const check = verifyWriteResult({ status: result.status, moved, branch: head?.ref });
  if (!check.ok) {
    return report(
      'Invalid `/agent-fix` result; human input required.',
      `${check.error}\nTreating this as an invalid fix result; human input is required. No Codex review was requested.\n\n**Claude's summary:** ${result.summary || '(none)'}`,
      1,
    );
  }
  if (result.status === 'blocked') {
    return report(
      'Owner-requested fix is blocked; human input required.',
      [`**Reason:** ${result.summary}`, `**Validation:** ${result.validation || '(none)'}`, moved ? pushedNote(inputs.headSha, head.sha) : null].filter(Boolean).join('\n\n'),
    );
  }
  if (result.status === 'no_change') {
    return report(
      'Owner-requested fix made no changes.',
      `Claude determined that no repository change is warranted. No commit was pushed and no Codex review was requested.\n\n**Claude's explanation:** ${result.summary || '(none)'}`,
    );
  }
  const validation = validationStatus(inputs.validationOutcome, inputs.validationResult);
  if (validation === 'failed') {
    return report('Owner-requested fix was pushed, but repository validation failed; Codex review was not requested.', result.summary, 1);
  }
  await updateState(ctx, pr, {
    passes: 0,
    final: 'not_started',
    stage: 'Owner-requested fix complete; requesting Codex review.',
    details: `A deliberate \`/agent-fix\` starts a fresh automated remediation budget.\n\nPushed ${short(inputs.headSha)} → ${short(head.sha)}.\n\n**Summary:** ${result.summary}`,
  });
  ctx.outputs.set('request_review', 'true');
  return 0;
}
