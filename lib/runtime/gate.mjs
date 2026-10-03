// Gate decisions: is this event something the automation should act on?
//
// Everything security-relevant is decided here, in one place:
//   - trusted users: listed in config AND currently holding write/admin access
//   - eligible PRs: open, same repository, head is not the base/default branch,
//     head branch is not protected
//   - opted-in PRs: labelled agent-review, most recently by a trusted user or by
//     the automation itself
//
// Gate functions are pure with respect to side effects: they return a decision
// and, optionally, a refusal message for the caller to post.

import { CONFIG_PATH, ConfigError, loadConfig, resolveRuntimeConfig } from '../config.mjs';
import { AUTOMATION_LOGIN } from './state.mjs';
import { isCodex } from './codex.mjs';

export const BUILD_TITLE_PREFIX = '[agent-build]';
export const BUILD_LABEL = 'agent-build';
export const REVIEW_LABEL = 'agent-review';
export const REVIEW_COMMAND = '/agent-review';
export const FIX_COMMAND = '/agent-fix';

export const LABELS = {
  [BUILD_LABEL]: { color: '5319e7', description: 'Approved issue: run automated Claude implementation' },
  [REVIEW_LABEL]: { color: '0e8a16', description: 'PR opted in to Codex review and automated remediation' },
};

export class GateError extends Error {}

/** Load config from the default branch and resolve repository defaults. */
export async function loadRepoConfig(client, repo, event) {
  const defaultBranch = event.repository?.default_branch;
  if (!defaultBranch) throw new GateError('event payload has no repository.default_branch');
  let file;
  try {
    file = await client.get(`repos/${repo.full}/contents/${CONFIG_PATH}?ref=${encodeURIComponent(defaultBranch)}`);
  } catch (err) {
    if (err.status === 404) {
      throw new GateError(`${CONFIG_PATH} was not found on the default branch (${defaultBranch}). Run \`agent-workflows install\` and commit the result.`);
    }
    throw err;
  }
  const text = Buffer.from(file.content || '', 'base64').toString('utf8');
  const { config, warnings } = loadConfig(text);
  const resolved = resolveRuntimeConfig(config, {
    defaultBranch,
    owner: event.repository.owner?.login,
    ownerType: event.repository.owner?.type,
  });
  // Derived values used by the workflow YAML (expressions cannot do arithmetic).
  resolved.default_branch = defaultBranch;
  resolved.codex.job_timeout_minutes = resolved.codex.wait_minutes + 10;
  return { config: resolved, warnings };
}

export { ConfigError };

export async function checkTrusted(client, repo, config, login) {
  if (!login) return { trusted: false, reason: 'the triggering user is unknown' };
  const listed = config.trusted_users.some((u) => u.toLowerCase() === login.toLowerCase());
  if (!listed) return { trusted: false, reason: `@${login} is not listed in trusted_users` };
  try {
    const p = await client.get(`repos/${repo.full}/collaborators/${encodeURIComponent(login)}/permission`);
    if (p.permission === 'admin' || p.permission === 'write') return { trusted: true };
    return { trusted: false, reason: `@${login} does not have write access to this repository` };
  } catch (err) {
    return { trusted: false, reason: `could not verify @${login}'s repository permission (${err.status || err.message})` };
  }
}

/** Fetch a PR and decide whether automation may modify its head branch. */
export async function checkPullRequest(client, repo, config, number) {
  const pr = await client.get(`repos/${repo.full}/pulls/${number}`);
  const deny = (reason, extra = {}) => ({ eligible: false, pr, reason, ...extra });
  if (pr.state !== 'open') return deny(`PR #${number} is ${pr.merged ? 'merged' : 'closed'}`);
  const headRepo = pr.head?.repo?.full_name;
  if (!headRepo || headRepo.toLowerCase() !== repo.full.toLowerCase()) {
    return deny('its head branch lives in a fork; agent automation only operates on branches in this repository', { fork: true });
  }
  const head = pr.head.ref;
  if ([config.base_branch, config.default_branch, pr.base?.ref].includes(head)) {
    return deny(`its head branch \`${head}\` is a base/default branch`);
  }
  try {
    const branch = await client.get(`repos/${repo.full}/branches/${encodeURIComponent(head)}`);
    if (branch.protected) return deny(`its head branch \`${head}\` is protected`);
  } catch (err) {
    if (err.status === 404) return deny(`its head branch \`${head}\` no longer exists`);
    throw err;
  }
  return { eligible: true, pr };
}

/** Login of whoever most recently applied `label` to the issue/PR, or null. */
export async function labelAppliedBy(client, repo, number, label) {
  const events = await client.paginate(`repos/${repo.full}/issues/${number}/events`);
  const labeled = events.filter((e) => e.event === 'labeled' && e.label?.name === label);
  return labeled.length ? labeled[labeled.length - 1].actor?.login ?? null : null;
}

export async function checkOptedIn(client, repo, config, pr) {
  if (!(pr.labels || []).some((l) => l.name === REVIEW_LABEL)) {
    return { optedIn: false, reason: `PR #${pr.number} does not carry the ${REVIEW_LABEL} label` };
  }
  const actor = await labelAppliedBy(client, repo, pr.number, REVIEW_LABEL);
  if (actor === AUTOMATION_LOGIN) return { optedIn: true, by: actor };
  const trust = await checkTrusted(client, repo, config, actor);
  if (trust.trusted) return { optedIn: true, by: actor };
  return { optedIn: false, reason: `the ${REVIEW_LABEL} label was applied by an untrusted user (${trust.reason})` };
}

/** First token of the first line, plus everything after it. */
export function parseCommand(body) {
  const text = (body || '').replace(/\r\n/g, '\n').trimStart();
  const m = text.match(/^(\/[a-z-]+)(?=\s|$)/);
  if (!m) return { command: null, argument: '' };
  return { command: m[1], argument: text.slice(m[1].length).trim() };
}

// Gates ----------------------------------------------------------------------------
//
// Each returns { action, reason, refusal?, ...details }. `action` is 'none' when
// nothing should run. `refusal` = { number, message, notify, removeLabel? }: the
// caller removes the label if asked and, when `notify` is true, posts the
// message so a trusted human learns why their request was ignored. Untrusted
// command authors get no reply (no bot amplification on public repositories).

export async function gateImplement({ client, repo, config, event }) {
  const issue = event.issue;
  const none = (reason, refusal) => ({ action: 'none', reason, refusal });
  if (!issue || issue.pull_request) return none('not an issue');

  let actor;
  let explicitLabel = false;
  if (event.action === 'opened') {
    if (!(issue.title || '').startsWith(BUILD_TITLE_PREFIX)) return none(`title does not start with ${BUILD_TITLE_PREFIX}`);
    if ((issue.labels || []).some((l) => l.name === BUILD_LABEL)) {
      return none(`issue was opened with the ${BUILD_LABEL} label; the labeled event starts the run`);
    }
    actor = issue.user?.login;
  } else if (event.action === 'labeled') {
    if (event.label?.name !== BUILD_LABEL) return none(`label is not ${BUILD_LABEL}`);
    actor = event.sender?.login;
    explicitLabel = true;
  } else {
    return none(`issue action "${event.action}" is not a trigger`);
  }

  const refuse = (reason) =>
    none(reason, explicitLabel ? { number: issue.number, message: `Agent implementation was not started: ${reason}.`, notify: true } : undefined);

  if (issue.state !== 'open') return refuse(`issue #${issue.number} is not open`);
  const author = await checkTrusted(client, repo, config, issue.user?.login);
  if (!author.trusted) return refuse(`the issue author must be a trusted user (${author.reason})`);
  if (explicitLabel) {
    const labeler = await checkTrusted(client, repo, config, actor);
    if (!labeler.trusted) return refuse(`the ${BUILD_LABEL} label must be applied by a trusted user (${labeler.reason})`);
  }
  return { action: 'implement', reason: `triggered by @${actor}`, issueNumber: issue.number, actor };
}

export async function gateReview({ client, repo, config, event, eventName }) {
  const none = (reason, refusal) => ({ action: 'none', reason, refusal });

  if (eventName === 'pull_request_review') {
    if (!isCodex(event.review?.user?.login)) return none('review was not submitted by Codex');
    const number = event.pull_request.number;
    const pr = await checkPullRequest(client, repo, config, number);
    if (!pr.eligible) return none(`PR #${number} is not eligible: ${pr.reason}`);
    const opt = await checkOptedIn(client, repo, config, pr.pr);
    if (!opt.optedIn) return none(opt.reason);
    return { action: 'remediate', reason: `Codex review on opted-in PR #${number}`, prNumber: number };
  }

  let number;
  let actor;
  let via;
  if (eventName === 'pull_request') {
    if (event.action !== 'labeled' || event.label?.name !== REVIEW_LABEL) return none('not an agent-review label event');
    number = event.pull_request.number;
    actor = event.sender?.login;
    via = 'label';
  } else if (eventName === 'issue_comment') {
    if (!event.issue?.pull_request) return none('comment is not on a pull request');
    if (parseCommand(event.comment?.body).command !== REVIEW_COMMAND) return none(`comment is not a ${REVIEW_COMMAND} command`);
    number = event.issue.number;
    actor = event.comment.user?.login;
    via = 'command';
  } else {
    return none(`event ${eventName} is not handled`);
  }

  const what = via === 'label' ? `The \`${REVIEW_LABEL}\` label` : `\`${REVIEW_COMMAND}\``;
  const refuse = (reason, notify = true) =>
    none(reason, {
      number,
      message: `${what} was not applied: ${reason}.${via === 'label' ? ' The label has been removed.' : ''}`,
      removeLabel: via === 'label' ? REVIEW_LABEL : undefined,
      // Labels need triage access, so labelers are always told; commenters only when trusted.
      notify,
    });

  const trust = await checkTrusted(client, repo, config, actor);
  if (!trust.trusted) return refuse(`only trusted users can opt a PR in to agent review (${trust.reason})`, via === 'label');
  const pr = await checkPullRequest(client, repo, config, number);
  if (!pr.eligible) return refuse(`PR #${number} is not eligible because ${pr.reason}`);
  return { action: 'start', reason: `opted in by @${actor} via ${via}`, prNumber: number, actor, via };
}

export async function gateHumanFix({ client, repo, config, event }) {
  const none = (reason, refusal) => ({ action: 'none', reason, refusal });
  if (!event.issue?.pull_request) return none('comment is not on a pull request');
  if (parseCommand(event.comment?.body).command !== FIX_COMMAND) return none(`comment is not a ${FIX_COMMAND} command`);
  const number = event.issue.number;
  const actor = event.comment.user?.login;
  const refuse = (reason, notify = true) => none(reason, { number, message: `\`${FIX_COMMAND}\` was not run: ${reason}.`, notify });

  const trust = await checkTrusted(client, repo, config, actor);
  if (!trust.trusted) return refuse(`only trusted users can request agent fixes (${trust.reason})`, false);
  const pr = await checkPullRequest(client, repo, config, number);
  if (!pr.eligible) return refuse(`PR #${number} is not eligible because ${pr.reason}`);
  return { action: 'fix', reason: `requested by @${actor}`, prNumber: number, actor };
}
