// Prompts and Claude CLI arguments for every agent session.
//
// Prompts are generic: repository-specific engineering guidance belongs in the
// consumer's own CLAUDE.md / AGENTS.md / CONTRIBUTING.md, which are listed via
// config.context. Only documents that actually exist are mentioned.

import { existsSync } from 'node:fs';
import path from 'node:path';

const status = (values) => ({ type: 'string', enum: values });
const text = { type: 'string' };

export const SCHEMAS = {
  implement: {
    type: 'object',
    properties: { status: status(['implemented', 'blocked', 'no_change']), summary: text, validation: text },
    required: ['status', 'summary', 'validation'],
  },
  remediate: {
    type: 'object',
    properties: { status: status(['fixed', 'blocked', 'no_change']), summary: text, validation: text },
    required: ['status', 'summary', 'validation'],
  },
  'human-fix': {
    type: 'object',
    properties: { status: status(['fixed', 'blocked', 'no_change']), summary: text, validation: text },
    required: ['status', 'summary', 'validation'],
  },
  audit: {
    type: 'object',
    properties: {
      status: status(['clean', 'findings', 'blocked']),
      summary: text,
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: { severity: status(['P1', 'P2', 'P3']), location: text, problem: text, recommended_fix: text },
          required: ['severity', 'location', 'problem', 'recommended_fix'],
        },
      },
    },
    required: ['status', 'summary', 'findings'],
  },
  'final-fix': {
    type: 'object',
    properties: { status: status(['fixed', 'blocked', 'no_change']), summary: text, validation: text },
    required: ['status', 'summary', 'validation'],
  },
};

const WRITE_TOOLS = 'Edit,Read,Write,Bash';

/** Claude CLI arguments for a session kind. Values come from validated config. */
export function claudeArgs(kind, config) {
  const settings = {
    implement: [config.implementation.model, config.implementation.max_turns, WRITE_TOOLS],
    remediate: [config.remediation.model, config.remediation.max_turns, WRITE_TOOLS],
    'human-fix': [config.human_fix.model, config.human_fix.max_turns, WRITE_TOOLS],
    audit: [config.escalation.model, config.escalation.audit_max_turns, 'Read,Bash'],
    'final-fix': [config.escalation.model, config.escalation.fix_max_turns, WRITE_TOOLS],
  }[kind];
  if (!settings) throw new Error(`unknown session kind ${kind}`);
  const [model, turns, tools] = settings;
  const lines = [`--model ${model}`, `--max-turns ${turns}`, `--allowedTools ${tools}`];
  if (kind === 'audit') lines.push('--disallowedTools Edit,Write,MultiEdit,NotebookEdit');
  lines.push(`--json-schema '${JSON.stringify(SCHEMAS[kind])}'`);
  return lines.join('\n');
}

// Shared fragments ------------------------------------------------------------------

export function existingContextDocs(root, docs) {
  return docs.filter((d) => existsSync(path.join(root, d)));
}

function contextBlock(docs, intro = 'Before changing code, read these project documents:') {
  if (!docs.length) return 'No project context documents were found; infer conventions from the existing code and tests.';
  return `${intro}\n${docs.map((d) => `- ${d}`).join('\n')}`;
}

function validationBlock(config, scriptExists) {
  const script = config.validation.script;
  if (!script) {
    return [
      '- This repository does not configure a validation script. Run the checks that the',
      '  project documentation describes and report exactly what you ran.',
    ].join('\n');
  }
  if (!scriptExists) {
    return `- The configured validation script \`${script}\` does not exist in this checkout. Stop and return blocked.`;
  }
  return [
    '- Run the repository validation script and make sure it passes before you finish:',
    `    bash ${script}`,
    '  The workflow runs the same script again after you finish and stops automation if it',
    '  fails. If it fails because of your change, fix the change. If it fails for reasons',
    '  unrelated to your change, stop and return blocked with the details.',
  ].join('\n');
}

function commonRules(config, branchRule) {
  return [
    branchRule,
    `- Never merge or approve a pull request, and never push to \`${config.base_branch}\`` +
      (config.default_branch && config.default_branch !== config.base_branch ? ` or \`${config.default_branch}\`.` : '.'),
    '- Do not request reviews or mention @codex; the workflow requests the independent review.',
    '- Never expose credentials, tokens or secret values in code, logs, comments or fixtures.',
  ].join('\n');
}

function fence(body) {
  const content = (body || '').trim() || '(empty)';
  let marker = '````';
  while (content.includes(marker)) marker += '`';
  return `${marker}\n${content}\n${marker}`;
}

function fenced(label, body) {
  return `${label}:\n${fence(body)}`;
}

function findingLocation(f) {
  if (!f.path) return '(no file)';
  if (f.line == null) return f.path;
  return f.startLine && f.startLine !== f.line ? `${f.path}:${f.startLine}-${f.line}` : `${f.path}:${f.line}`;
}

/**
 * The unresolved Codex findings the workflow collected from GitHub (see
 * codexFindings in codex.mjs), or `null` when they could not be collected.
 */
export function codexFindingsBlock(collected, authority) {
  const title = 'CURRENT UNRESOLVED CODEX FINDINGS';
  if (!collected) {
    return `${title}

The workflow could not collect the review threads for this run. Read every unresolved
Codex review thread on the pull request yourself; an empty review body does not imply
there are no findings.`;
  }
  const { findings, outdated = 0, addressed = 0, omitted = 0 } = collected;
  const notes = [];
  if (outdated) notes.push(`${outdated} unresolved Codex thread(s) are outdated (the code they refer to has changed since) and are not listed.`);
  if (addressed) notes.push(`${addressed} Codex thread(s) were fixed by earlier passes and confirmed by a clean Codex review, and are not listed, although they are still open on GitHub.`);
  if (omitted) notes.push(`${omitted} more finding(s) are not shown because of prompt size limits; read them on the pull request.`);
  if (!findings.length) {
    return [title, '', 'None: the pull request has no unresolved, non-outdated Codex review threads.', ...notes].join('\n');
  }
  const items = findings.map((f, i) => {
    const about = [`thread ${f.thread}`];
    if (f.latest !== null && f.latest !== undefined) about.push(f.latest ? 'from the latest review' : 'from an earlier review');
    if (f.replies) about.push(`${f.replies} repl${f.replies === 1 ? 'y' : 'ies'} by others not shown`);
    const heading = `${f.severity ? `${f.severity}: ` : ''}${f.title || '(untitled finding)'}`;
    const fixed = f.fixedBy
      ? `\n   Fixed by commit ${f.fixedBy.slice(0, 7)} in an earlier pass; no clean Codex review has confirmed it yet.\n   Check that it is still fixed, and change code for it only if it is not.`
      : '';
    return `${i + 1}. ${findingLocation(f)}\n   ${heading}\n   (${about.join(', ')})${fixed}\n${fence(f.body)}`;
  });
  return [
    title,
    '',
    authority,
    'The workflow collected this list from GitHub: unresolved review threads opened by Codex',
    'whose code has not changed since.',
    '',
    items.join('\n\n'),
    ...(notes.length ? ['', ...notes] : []),
  ].join('\n');
}

function statusRules(lines) {
  return [
    'Status rules (the workflow compares the pull request head on GitHub before and after this',
    'session, and rejects a status that does not match what happened to the branch):',
    ...lines,
  ].join('\n');
}

// Prompts ---------------------------------------------------------------------------

export function implementPrompt({ config, issue, branch, docs, scriptExists }) {
  return `Implement the approved design contract in issue #${issue.number}.

${fenced('TITLE', issue.title)}

${fenced('DESIGN CONTRACT', issue.body)}

${contextBlock(docs)}

Requirements:
- Treat the issue as the source of truth. Do not broaden scope.
- Preserve existing public behavior unless the issue explicitly changes it.
- Follow existing repository patterns before introducing new abstractions.
- Add or update tests for changed behavior.
${validationBlock(config, scriptExists)}
- You are on \`${branch}\`, created from \`${config.base_branch}\` for this issue. Commit all
  required changes there and push them with \`git push origin ${branch}\`. Do not open a
  pull request; the workflow opens it.
${commonRules(config, `- Only push to \`${branch}\`.`)}
- If the issue is ambiguous in a way that materially affects behavior, stop and return
  blocked rather than inventing a requirement.

Return status "implemented" only when your changes are committed and pushed and validation
passes; "blocked" when you cannot proceed safely (explain why); "no_change" when nothing
needs to change (explain why). The workflow opens a pull request only when \`${branch}\` has
commits ahead of \`${config.base_branch}\` on GitHub, and rejects "no_change" if you pushed
any. Summarize what you changed and list the validation you ran.`;
}

export function remediatePrompt({ config, pr, headRef, reviewBody, codexFindings, docs, scriptExists }) {
  return `You are the remediation agent for PR #${pr} (branch \`${headRef}\`).

Codex has just submitted an independent review. Read:
- the current unresolved Codex findings listed below, and the code they point at,
- the latest Codex review body,
- the pull request description and diff,
- the originating issue/design contract if the PR references one (otherwise treat the PR
  description as the contract),
${docs.map((d) => `- ${d}`).join('\n') || '- the existing code and tests that establish project conventions'}

${fenced('LATEST REVIEW BODY', reviewBody)}

${codexFindingsBlock(
  codexFindings,
  'An empty latest review body does not imply there are no findings. The unresolved finding\nlist below is authoritative for the current remediation pass.',
)}

Address only actionable findings relevant to correctness, regression risk, tests,
documentation, security, compatibility, or the approved design.

Rules:
- Do not redesign the feature.
- If findings are valid, fix them with the smallest complete patch.
- If a finding conflicts with the design contract, cannot be resolved without a product or
  design decision, or would require guessing, stop and return blocked with an explanation.
- Do not make opportunistic refactors or style-only changes.
- Preserve public behavior unless the approved design explicitly changes it.
${validationBlock(config, scriptExists)}
${commonRules(config, `- Commit and push fixes only to the existing pull request branch \`${headRef}\`.`)}

${statusRules([
  `- Return "fixed" only if you changed the repository, committed the change, pushed it to`,
  `  \`${headRef}\`, and the actionable findings you addressed are resolved by the pushed change.`,
  '- If you did not push a commit, you MUST NOT return "fixed".',
  '- Return "blocked" if any valid actionable finding remains but resolving it needs a',
  '  product/design decision, missing information, an unsafe guess, or a capability you do not',
  '  have, or if the requested fix conflicts with the approved contract. If your reasoning',
  '  concludes that a human decision is needed, return "blocked", even if you made no changes.',
  '  If you pushed fixes for other findings first, say which finding remains.',
  '- Return "no_change" only when no repository change is warranted because every relevant',
  '  finding is already resolved, outdated, duplicate, invalid, or non-actionable. Explain why',
  '  for each finding in the summary, and do not push commits. Never use "no_change" for a',
  '  valid finding that needs a human decision; that is "blocked".',
])}`;
}

export function humanFixPrompt({ config, pr, headRef, actor, feedback, codexFindings, docs, scriptExists }) {
  const hasFeedback = !!feedback.trim();
  const feedbackBlock = hasFeedback
    ? fenced('HUMAN FEEDBACK', feedback)
    : 'No feedback text followed the command. Address the unresolved review threads on this PR,\nstarting with the current unresolved Codex findings listed below.';
  const findingsAuthority = hasFeedback
    ? 'The feedback above is the task. These findings are context: address them only where the\nfeedback asks you to.'
    : 'No feedback text followed the command, so these findings are the work for this fix. An\nempty review body does not imply there are no findings.';
  return `You are the human-feedback remediation agent for PR #${pr} (branch \`${headRef}\`).

Trusted user @${actor} deliberately invoked /agent-fix with this feedback:

${feedbackBlock}

${codexFindingsBlock(codexFindings, findingsAuthority)}

Read:
- the full pull request diff and current branch,
- the originating issue/design contract if the PR references one,
- all existing PR review comments and unresolved review threads,
${docs.map((d) => `- ${d}`).join('\n') || '- the existing code and tests that establish project conventions'}

Treat the feedback as accepted direction to address, but not as permission to broaden the
original feature.

Rules:
- Address only the requested feedback and any directly necessary tests/documentation.
- Do not redesign the feature or perform opportunistic refactors.
- Preserve public behavior unless the feedback or approved design requires a change.
- If the feedback conflicts with the approved design or cannot be safely resolved without a
  product decision, stop and return blocked.
${validationBlock(config, scriptExists)}
${commonRules(config, `- Commit and push fixes only to the existing pull request branch \`${headRef}\`.`)}

${statusRules([
  `- Return "fixed" only if you changed the repository, committed the change, pushed it to`,
  `  \`${headRef}\`, and the requested feedback is addressed by the pushed change. If you did not`,
  '  push a commit, you MUST NOT return "fixed". A Codex review is requested only after a',
  '  verified push.',
  '- Return "blocked" if the feedback, or part of it, cannot be addressed safely: it conflicts',
  '  with the approved design, needs a product/design decision or missing information, would',
  '  require guessing, or needs a capability you do not have. If your reasoning concludes that a',
  '  human decision is needed, return "blocked", even if you made no changes.',
  '- Return "no_change" only when no repository change is warranted, for example because the',
  '  requested change is already present. Explain why in the summary and do not push commits.',
])}`;
}

export function auditPrompt({ config, pr, headRef, docs }) {
  return `Perform the one-shot final holistic audit for PR #${pr} (branch \`${headRef}\`,
base \`${config.base_branch}\`).

This PR has already used its ${config.remediation.max_passes} automated Codex → Claude
remediation pass(es) and Codex has submitted another review. Previous reviews may have
surfaced issues incrementally. Do NOT review only the latest patch.

Read and independently audit:
- the COMPLETE current PR diff against \`${config.base_branch}\`,
- the originating issue/design contract if the PR references one (otherwise the PR description),
- every Codex review and inline review thread, including resolved and outdated threads,
- all remediation commits and the resulting code,
- relevant tests,
${docs.map((d) => `- ${d}`).join('\n') || '- the existing code and tests that establish project conventions'}

Audit the whole resulting change for:
- correctness and data-loss risks,
- contract, schema and interface mismatches,
- regression and compatibility risks,
- error handling and partial-failure behavior,
- concurrency and stale-state assumptions,
- validation gaps,
- documentation accuracy,
- missing or misleading tests,
- integration with existing repository conventions.

Read all prior findings, but verify them independently. Limitations explicitly accepted in
the approved design are not bugs merely because they are imperfect.

IMPORTANT:
- This session is REVIEW ONLY. Do not edit, write, commit, or push files. The workflow checks
  that the branch is unchanged afterwards.
- Find as many actionable issues as you can in this one pass rather than stopping after the
  first plausible issue. Group findings by severity (P1/P2/P3).
- If there are no actionable findings, return status "clean" and an empty findings array.
- If actionable findings exist and can be resolved within the approved design, return status
  "findings" with the complete consolidated list.
- If any necessary fix requires a product/design decision outside the approved contract,
  return status "blocked" and explain why.`;
}

export function finalFixPrompt({ config, pr, headRef, findings, auditSummary, docs, scriptExists }) {
  return `Apply the one-shot consolidated final-audit fixes for PR #${pr} (branch \`${headRef}\`).

A separate review session audited the COMPLETE PR and returned this consolidated finding set:

${fenced('FINDINGS (JSON)', findings)}

${fenced('AUDIT SUMMARY', auditSummary)}

Before changing code, independently verify each finding against the current branch, the
originating issue/design contract, prior Codex threads, relevant tests and:
${docs.map((d) => `- ${d}`).join('\n') || '- the existing code and tests that establish project conventions'}

Rules:
- Fix every valid finding in this one consolidated pass.
- Do not broaden the feature or perform opportunistic refactors.
- Preserve documented/accepted limitations unless the audit identified inaccurate wording.
- If a finding is invalid, do not implement it; explain why in the summary.
- If a required fix conflicts with the approved design or needs a new product decision, stop
  and return blocked instead of guessing.
${validationBlock(config, scriptExists)}
${commonRules(config, `- Commit and push all fixes to the existing pull request branch \`${headRef}\`.`)}
- This is the terminal automated stage: no further review will be requested.

${statusRules([
  `- Return "fixed" only if you changed the repository, committed the change, pushed it to`,
  `  \`${headRef}\`, and every valid finding is resolved by the pushed change (explain any finding`,
  '  you judged invalid). If you did not push a commit, you MUST NOT return "fixed".',
  '- Return "blocked" if any valid finding remains unresolved because it needs a product/design',
  '  decision, missing information, an unsafe guess, or a capability you do not have. If your',
  '  reasoning concludes that a human decision is needed, return "blocked", even if you made no',
  '  changes or pushed fixes for other findings.',
  '- Return "no_change" only when, after verification, none of the findings warrants a',
  '  repository change (each is already resolved, duplicate, invalid, or non-actionable). Explain',
  '  why for each finding and do not push commits. A human reviews that conclusion.',
  '- Be conservative: when unsure, return "blocked". A human review is better than declaring the',
  '  automated process complete when it is not.',
])}`;
}
