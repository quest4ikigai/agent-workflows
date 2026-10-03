// Step-level orchestration used by the reusable workflows.
//
// Each exported function implements one workflow step. It receives a context
// (clients, config, outputs, logger) plus the step's inputs, performs GitHub
// side effects, sets outputs, and returns an exit code. The YAML only wires
// these steps together around the Claude sessions.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { BUILD_TITLE_PREFIX, LABELS, REVIEW_LABEL, checkOptedIn, checkPullRequest } from './gate.mjs';
import { latestRequestOrigin, requestCodexReview, resolveCodexThreads, waitForCodex } from './codex.mjs';
import { decide, readState, updateState } from './state.mjs';
import { VALIDATION_TEXT, claudeSucceeded, describeClaudeFailure, parseResult, validationStatus } from './results.mjs';

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

const short = (sha) => (sha ? sha.slice(0, 7) : 'unknown');
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

/** Refuse to start when an open agent PR for this issue already exists. */
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
  if (result.status !== 'implemented') {
    await comment(ctx, issue, `Agent implementation stopped with status \`${result.status}\`.\n\n${result.summary}`);
    return 0;
  }

  // Never open a PR from anything but a fresh feature branch with real commits.
  const branch = inputs.branch;
  const base = ctx.config.base_branch;
  if (!branch || !branch.startsWith(ctx.config.branch_prefix) || branch === base) {
    return fail(`Claude reported success but the work branch (${branch || 'none'}) is not a ${ctx.config.branch_prefix} feature branch`);
  }
  let compare;
  try {
    compare = await ctx.client.get(`repos/${ctx.repo.full}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`);
  } catch (err) {
    return fail(`Claude reported success but branch ${branch} could not be compared with ${base} (${err.status || err.message}); was it pushed?`);
  }
  if (!compare.ahead_by) return fail(`Claude reported success but pushed no commits to ${branch}`);

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
      current: { commentId: null, passes: 0, final: 'not_started' },
      stage: 'Implementation pushed, but repository validation failed; Codex review was not requested.',
      details: `Fix the failure (for example with \`/agent-fix <instructions>\`), then comment \`/agent-review\` to start the review cycle.\n\nWorkflow run: ${ctx.runUrl}`,
    });
    ctx.log.error('repository validation failed after implementation');
    return 1;
  }
  await updateState(ctx, pr.number, {
    current: { commentId: null, passes: 0, final: 'not_started' },
    stage: 'Initial implementation complete; requesting Codex review.',
    details: `The automated remediation budget starts at 0/${ctx.config.remediation.max_passes}. Manual reviews and \`/agent-fix\` do not consume it.`,
  });
  ctx.outputs.set('request_review', 'true');
  return 0;
}

// Review cycle (shared by every path) ---------------------------------------------------

const ORIGIN_TEXT = {
  initial: 'initial review',
  'opt-in': 'review after opt-in',
  remediation: 're-review after remediation',
  'human-fix': 'review after owner-requested fix',
};

/** Request a Codex review and wait (bounded) for the outcome, updating the status comment. */
export async function reviewCycle(ctx, { pr, origin }) {
  const agent = needAgentClient(ctx);
  const sha = await headSha(ctx, pr);
  const request = await requestCodexReview({ client: ctx.client, agentClient: agent, repo: ctx.repo, pr, origin });
  const waitMinutes = ctx.config.codex.wait_minutes;
  const what = ORIGIN_TEXT[origin] ?? 'review';

  if (waitMinutes === 0) {
    await updateState(ctx, pr, {
      stage: `Codex ${what} requested.`,
      details: `Requested for commit ${short(sha)}. Submitted findings start automated remediation automatically.`,
    });
    ctx.outputs.set('result', 'requested');
    return 0;
  }
  await updateState(ctx, pr, { stage: `Codex ${what} running.`, details: `Waiting on the independent review of commit ${short(sha)}.` });
  const result = await waitForCodex({
    client: agent,
    repo: ctx.repo,
    pr,
    ...request,
    timeoutMs: waitMinutes * 60000,
    pollMs: ctx.pollMs ?? 15000,
    sleep: ctx.sleep,
    now: ctx.now,
    log: ctx.log.info,
  });
  ctx.outputs.set('result', result);
  if (result === 'clean') {
    await updateState(ctx, pr, {
      stage: 'Codex review completed with no actionable findings.',
      details: 'When CI passes, this pull request is ready for human acceptance.',
    });
  } else if (result === 'pending') {
    await updateState(ctx, pr, {
      stage: `Codex review is still running beyond the ${waitMinutes}-minute monitor window.`,
      details: 'The review can still finish later; submitted findings will start automated remediation automatically.',
    });
  } else {
    await updateState(ctx, pr, {
      stage: 'Codex submitted findings; automated remediation will pick them up.',
      details: `Reviewed commit ${short(sha)}.`,
    });
  }
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

  switch (d.mode) {
    case 'remediate':
      await updateState(ctx, pr, {
        current: state,
        stage: d.countable
          ? `Codex findings received; automated remediation pass ${state.passes + 1}/${max} is running.`
          : 'Codex findings received; remediation is running without consuming the automated budget.',
        details: `Review trigger origin: ${origin}.`,
      });
      break;
    case 'escalate':
      await updateState(ctx, pr, {
        current: state,
        final: 'running',
        stage: `Automated remediation budget exhausted; holistic final audit (\`${ctx.config.escalation.model}\`) is running.`,
        details: 'The audit reviews the entire pull request and all prior findings in one read-only pass.',
      });
      break;
    case 'exhausted':
      await updateState(ctx, pr, {
        current: state,
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

export async function finishRemediation(ctx, inputs) {
  const pr = inputs.pr;
  ctx.outputs.set('request_review', 'false');
  const stop = async (stage, message, code = 0) => {
    await updateState(ctx, pr, { stage, details: `${message}\n\nWorkflow run: ${ctx.runUrl}` });
    await comment(ctx, pr, `${stage}\n\n${message}`);
    return code;
  };

  if (!claudeSucceeded(inputs.claudeOutcome, inputs.claudeConclusion)) {
    return stop('Automated remediation did not complete; human input required.', describeClaudeFailure(inputs.claudeOutcome, inputs.claudeConclusion), 1);
  }
  const result = parseResult('remediate', inputs.rawResult);
  if (!result.ok) return stop('Automated remediation did not complete; human input required.', result.error, 1);
  if (result.status === 'blocked') {
    return stop(
      'Claude could not safely resolve the latest Codex review; human input required.',
      `**Reason:** ${result.summary}\n\n**Validation:** ${result.validation || '(none)'}`,
    );
  }

  const countable = inputs.countable === 'true';
  const passes = Number(inputs.passes) + (countable ? 1 : 0);
  const after = await headSha(ctx, pr);
  if (after === inputs.headSha) {
    await updateState(ctx, pr, { passes, stage: 'Claude reported a fix but pushed no commits; human input required.', details: result.summary });
    await comment(ctx, pr, `Claude reported the Codex findings as fixed but pushed no commits.\n\n**Summary:** ${result.summary}`);
    return 0;
  }
  const validation = validationStatus(inputs.validationOutcome, inputs.validationResult);
  if (validation === 'failed') {
    await updateState(ctx, pr, {
      passes,
      stage: 'Remediation pushed, but repository validation failed; automated review paused.',
      details: `Use \`/agent-fix <instructions>\` or fix the branch manually, then comment \`/agent-review\`.\n\nWorkflow run: ${ctx.runUrl}`,
    });
    await comment(ctx, pr, `Remediation was pushed, but repository validation failed, so no re-review was requested.\n\nWorkflow run: ${ctx.runUrl}`);
    ctx.log.error('repository validation failed after remediation');
    return 1;
  }
  await resolveCodexThreads(ctx.client, ctx.repo, pr, ctx.log.info);
  await updateState(ctx, pr, {
    passes,
    stage: 'Claude remediation complete; requesting Codex re-review.',
    details: `Automated remediation budget used: ${passes}/${ctx.config.remediation.max_passes}. Repository validation: ${VALIDATION_TEXT[validation]}.`,
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
    await resolveCodexThreads(ctx.client, ctx.repo, pr, ctx.log.info);
    await updateState(ctx, pr, {
      final: 'complete',
      stage: 'Holistic final audit completed cleanly; automated review is finished.',
      details: `${result.summary}\n\nWhen CI passes, this pull request is ready for human acceptance.`,
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
  if (result.status === 'blocked') {
    return block('Consolidated final remediation needs human input.', `**Reason:** ${result.summary}\n\n**Validation:** ${result.validation || '(none)'}`);
  }
  const validation = validationStatus(inputs.validationOutcome, inputs.validationResult);
  if (validation === 'failed') {
    return block('The consolidated final fix was pushed, but repository validation failed; human input required.', result.summary, 1);
  }
  await resolveCodexThreads(ctx.client, ctx.repo, pr, ctx.log.info);
  await updateState(ctx, pr, {
    final: 'complete',
    stage: 'Final audit and consolidated remediation complete; automated review is finished.',
    details: [
      `**Audit:** ${inputs.auditSummary || '(none)'}`,
      `**Final fix:** ${result.summary}`,
      `**Repository validation:** ${VALIDATION_TEXT[validation]}`,
      'No further automated review will run. When CI passes, this pull request is ready for human acceptance.',
    ].join('\n\n'),
  });
  return 0;
}

// Human-requested fix ------------------------------------------------------------------------

export async function prepareHumanFix(ctx, { pr, actor }) {
  ctx.outputs.set('proceed', 'false');
  const current = await recheckPullRequest(ctx, pr, { requireOptIn: false });
  if (!current) return 0;
  if (!(current.labels || []).some((l) => l.name === REVIEW_LABEL)) await ensureLabel(ctx, pr, REVIEW_LABEL);
  await updateState(ctx, pr, { stage: `Owner-requested fix (\`/agent-fix\` by @${actor}) is running.`, details: `Workflow run: ${ctx.runUrl}` });
  ctx.outputs.set('proceed', 'true');
  ctx.outputs.set('head_ref', current.head.ref);
  ctx.outputs.set('head_sha', current.head.sha);
  return 0;
}

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
  if (result.status !== 'fixed') {
    return report(
      `Owner-requested fix finished with status \`${result.status}\`.`,
      `**Summary:** ${result.summary}\n\n**Validation:** ${result.validation || '(none)'}`,
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
    details: `A deliberate \`/agent-fix\` starts a fresh automated remediation budget.\n\n**Summary:** ${result.summary}`,
  });
  ctx.outputs.set('request_review', 'true');
  return 0;
}
