// Rendering of every file the installer writes into a consumer repository.
//
// Wrappers carry a "managed" header with a checksum of their own contents so
// the installer can tell an untouched wrapper (safe to regenerate) from one a
// human edited (left alone unless --force).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SETUP_SCRIPT, DEFAULT_VALIDATION_SCRIPT } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = path.join(HERE, '..', 'templates', 'workflows');
export const DEFAULT_WORKFLOWS_REPO = 'quest4ikigai/agent-workflows';
export const MANAGED_PREFIX = '# agent-workflows: managed';
export const NO_VALIDATION_MARKER = '# agent-workflows: no validation commands detected';

export const WRAPPERS = [
  { template: 'agent-implement', path: '.github/workflows/agent-implement.yml', reusable: 'implement.yml' },
  { template: 'agent-review', path: '.github/workflows/agent-review.yml', reusable: 'review.yml' },
  { template: 'agent-human-fix', path: '.github/workflows/agent-human-fix.yml', reusable: 'human-fix.yml' },
];

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

// Wrappers ---------------------------------------------------------------------

/**
 * Render a wrapper. `uses` may be "remote" (default) or "local", which points at
 * ./.github/workflows/<file> and is only used to lint wrappers inside this repo.
 */
export function renderWrapper(template, { ref, workflowsRepo = DEFAULT_WORKFLOWS_REPO, uses = 'remote' }) {
  const wrapper = WRAPPERS.find((w) => w.template === template);
  if (!wrapper) throw new Error(`unknown wrapper template ${template}`);
  if (!REF_RE.test(ref || '') || ref.includes('..')) throw new Error(`invalid ref "${ref}"`);
  if (!REPO_RE.test(workflowsRepo)) throw new Error(`invalid workflows repository "${workflowsRepo}"`);
  let body = readFileSync(path.join(TEMPLATE_DIR, `${template}.yml`), 'utf8');
  const target = uses === 'local' ? `./.github/workflows/${wrapper.reusable}` : `${workflowsRepo}/.github/workflows/${wrapper.reusable}@${ref}`;
  body = body.replace(/__AW_REPO__\/\.github\/workflows\/[a-z-]+\.yml@__AW_REF__/g, target);
  if (/__AW_[A-Z]+__/.test(body)) throw new Error(`unreplaced placeholder in ${template}`);
  return `${managedHeader(template, body)}\n${body}`;
}

function managedHeader(template, body) {
  return `${MANAGED_PREFIX} template=${template} checksum=${checksum(body)}`;
}

export function checksum(body) {
  return `sha256:${createHash('sha256').update(body.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)}`;
}

/**
 * Inspect an existing wrapper file. Returns
 *   { managed: false }                                      – no header
 *   { managed: true, template, modified, ref, workflowsRepo }
 */
export function parseWrapper(content) {
  const text = content.replace(/\r\n/g, '\n');
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  if (!first.startsWith(MANAGED_PREFIX)) return { managed: false };
  const fields = Object.fromEntries(
    first
      .slice(MANAGED_PREFIX.length)
      .trim()
      .split(/\s+/)
      .map((kv) => kv.split('='))
      .filter((kv) => kv.length === 2),
  );
  const body = nl < 0 ? '' : text.slice(nl + 1);
  const usesMatch = body.match(/^\s*uses:\s*([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/\.github\/workflows\/[A-Za-z0-9._-]+@(\S+)\s*$/m);
  return {
    managed: true,
    template: fields.template ?? null,
    modified: fields.checksum !== checksum(body),
    workflowsRepo: usesMatch ? usesMatch[1] : null,
    ref: usesMatch ? usesMatch[2] : null,
  };
}

// Config -------------------------------------------------------------------------

/**
 * values: {
 *   baseBranch, trustedUsers (array|null), nodeVersion, pythonVersion,
 *   setupScript (path|null), validationScript (path|null), context (array)
 * }
 */
export function renderConfig(values) {
  const q = (s) => JSON.stringify(String(s));
  const lines = [
    '# agent-workflows configuration',
    '#',
    '# Read by the agent workflows from the repository DEFAULT branch.',
    '# Every setting is documented in docs/configuration.md of agent-workflows:',
    '# https://github.com/quest4ikigai/agent-workflows/blob/main/docs/configuration.md',
    '# Validate locally with: agent-workflows check .',
    'version: 1',
    '',
  ];
  lines.push('# Branch that automated implementation PRs target.');
  if (values.baseBranch) lines.push(`base_branch: ${values.baseBranch}`);
  else lines.push('# base_branch: (defaults to the repository default branch)');
  lines.push(
    '',
    '# Prefix for branches created by automated implementation.',
    'branch_prefix: claude/',
    '',
    '# GitHub users allowed to trigger agent work. Each must also have write access.',
  );
  if (values.trustedUsers && values.trustedUsers.length) {
    lines.push('trusted_users:', ...values.trustedUsers.map((u) => `  - ${u}`));
  } else {
    lines.push('# trusted_users: (defaults to the repository owner for personal repositories)');
  }
  lines.push(
    '',
    '# Path A: Claude implements an approved [agent-build] issue.',
    'implementation:',
    '  model: sonnet',
    '  max_turns: 40',
    '  timeout_minutes: 75',
    '',
    '# Claude addresses Codex findings, up to max_passes automated passes.',
    'remediation:',
    '  model: sonnet',
    '  max_turns: 30',
    '  max_passes: 3',
    '  timeout_minutes: 90',
    '',
    '# One holistic audit + consolidated fix once the remediation budget is spent.',
    'escalation:',
    '  enabled: true',
    '  model: opus',
    '  audit_max_turns: 40',
    '  fix_max_turns: 45',
    '',
    '# Owner-requested fixes via a "/agent-fix <feedback>" PR comment.',
    'human_fix:',
    '  model: sonnet',
    '  max_turns: 30',
    '  timeout_minutes: 75',
    '',
    '# How long a workflow waits for Codex to finish a review (0 = do not wait).',
    'codex:',
    '  wait_minutes: 15',
    '',
    '# Environment prepared before Claude starts.',
    'setup:',
  );
  if (values.nodeVersion) lines.push(`  node_version: ${q(values.nodeVersion)}`);
  if (values.pythonVersion) lines.push(`  python_version: ${q(values.pythonVersion)}`);
  lines.push(`  script: ${values.setupScript ?? 'null'}`);
  lines.push(
    '',
    '# Single source of truth for "is this change acceptable".',
    'validation:',
    `  script: ${values.validationScript ?? 'null'}`,
    '',
    '# Project documents agents should read before working (missing files are skipped).',
  );
  if (values.context && values.context.length) {
    lines.push('context:', ...values.context.map((c) => `  - ${c}`));
  } else {
    lines.push('context: []');
  }
  return `${lines.join('\n')}\n`;
}

// Scripts ------------------------------------------------------------------------

export function renderSetupScript(commands) {
  return [
    '#!/usr/bin/env bash',
    '# Environment setup for agent-workflows.',
    '#',
    '# Runs once in the workflow before Claude starts, after the language runtime',
    '# selected in .github/agent/config.yml (setup.node_version / setup.python_version)',
    '# is installed. Install dependencies here so Claude can build and test.',
    '#',
    `# Generated by \`agent-workflows install\`; edit freely (it is never overwritten).`,
    'set -euo pipefail',
    '',
    ...commands,
    '',
  ].join('\n');
}

/**
 * commands: shell lines to run. suggestions: commented-out hints shown when no
 * commands were detected.
 */
export function renderValidateScript(commands, suggestions = []) {
  const head = [
    '#!/usr/bin/env bash',
    '# Repository validation for agent-workflows.',
    '#',
    '# Claude runs this script before reporting success, and the agent workflows',
    '# run it again as a separate step after every implementation or remediation',
    '# pass. Keep it equivalent to your CI checks. Exit non-zero on failure.',
    '#',
    `# Generated by \`agent-workflows install\`; edit freely (it is never overwritten).`,
    'set -euo pipefail',
    '',
  ];
  if (commands.length) return [...head, ...commands, ''].join('\n');
  return [
    ...head,
    NO_VALIDATION_MARKER,
    '# TODO: add the commands that prove a change is correct and remove this marker.',
    ...(suggestions.length ? ['# Suggestions based on the repository contents:', ...suggestions.map((s) => `#   ${s}`)] : []),
    `echo "::warning::No validation commands are configured in ${DEFAULT_VALIDATION_SCRIPT}"`,
    '',
  ].join('\n');
}

export { DEFAULT_SETUP_SCRIPT, DEFAULT_VALIDATION_SCRIPT };
