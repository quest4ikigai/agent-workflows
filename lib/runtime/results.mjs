// Parsing of Claude's structured output and of step outcomes.

import { SCHEMAS } from './prompts.mjs';

/**
 * Parse claude-code-action's `structured_output` for a session kind.
 * Returns { ok, status, summary, validation, findings, error }.
 */
export function parseResult(kind, raw) {
  const schema = SCHEMAS[kind];
  if (!schema) throw new Error(`unknown session kind ${kind}`);
  const empty = { ok: false, status: '', summary: '', validation: '', findings: [] };
  if (!raw || !String(raw).trim()) return { ...empty, error: 'Claude returned no structured result' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...empty, error: 'Claude returned a structured result that is not valid JSON' };
  }
  if (!data || typeof data !== 'object') return { ...empty, error: 'structured result is not an object' };
  const allowed = schema.properties.status.enum;
  if (!allowed.includes(data.status)) {
    return { ...empty, error: `structured result has unexpected status ${JSON.stringify(data.status)}` };
  }
  return {
    ok: true,
    status: data.status,
    summary: typeof data.summary === 'string' ? data.summary : '',
    validation: typeof data.validation === 'string' ? data.validation : '',
    findings: Array.isArray(data.findings) ? data.findings : [],
  };
}

// Statuses that claim the session pushed commits, and those that claim it pushed none.
// `blocked` claims neither: a session may stop before or after pushing.
const CLAIMS_PUSH = new Set(['implemented', 'fixed']);
const CLAIMS_NO_PUSH = new Set(['no_change']);

/** Whether a branch head moved between two SHAs; null when either is unknown. */
export function headMoved(before, after) {
  return before && after ? before !== after : null;
}

/**
 * Check a write session's status against what GitHub shows happened to its
 * branch, instead of trusting the label. `moved` is true when the remote branch
 * gained commits during the session, false when it did not, and null when that
 * could not be determined (which never confirms a claim).
 * Returns { ok, error }.
 */
export function verifyWriteResult({ status, moved, branch }) {
  const where = branch ? ` to \`${branch}\`` : '';
  if (CLAIMS_PUSH.has(status) && moved !== true) {
    return {
      ok: false,
      error:
        moved === false
          ? `Claude returned \`${status}\`, but no commit was pushed${where}.`
          : `Claude returned \`${status}\`, but the workflow could not confirm that a commit was pushed${where}.`,
    };
  }
  if (CLAIMS_NO_PUSH.has(status) && moved !== false) {
    return {
      ok: false,
      error:
        moved === true
          ? `Claude returned \`${status}\`, but commits were pushed${where}.`
          : `Claude returned \`${status}\`, but the workflow could not confirm that nothing was pushed${where}.`,
    };
  }
  return { ok: true };
}

/** Map a validation step's outcome/output to passed | failed | not-configured | not-run. */
export function validationStatus(outcome, result) {
  if (outcome === 'failure') return 'failed';
  if (outcome === 'success') return result === 'skipped' ? 'not-configured' : 'passed';
  return 'not-run';
}

export const VALIDATION_TEXT = {
  passed: '✅ passed',
  failed: '❌ failed',
  'not-configured': '⚪ no validation script configured',
  'not-run': '⚪ not run',
};

/**
 * True only when the Claude step ran to completion. claude-code-action can exit
 * successfully without running Claude (e.g. when the GitHub App token exchange
 * rejects the workflow), so the action's own `conclusion` output must agree.
 */
export function claudeSucceeded(outcome, conclusion) {
  return outcome === 'success' && conclusion === 'success';
}

export function describeClaudeFailure(outcome, conclusion) {
  if (outcome === 'success') {
    return 'claude-code-action finished without running Claude (no conclusion). The Claude GitHub App token exchange may have rejected this workflow — wrapper files must match the default branch.';
  }
  if (outcome === 'cancelled') return 'the Claude step was cancelled (job timeout or manual cancellation)';
  if (outcome === 'skipped') return 'the Claude step did not run because an earlier step failed';
  return `the Claude step failed (conclusion: ${conclusion || 'unknown'})`;
}
