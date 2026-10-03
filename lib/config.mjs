// Schema, defaults and validation for .github/agent/config.yml.
//
// `loadConfig` turns YAML text into a fully-populated, validated object.
// `resolveRuntimeConfig` fills the values that depend on the live repository
// (base branch, trusted users). Both the CLI and the reusable workflows use
// these functions, so there is exactly one definition of the schema.

import { parseYaml, YamlError } from './yaml.mjs';

export const CONFIG_PATH = '.github/agent/config.yml';
export const DEFAULT_SETUP_SCRIPT = '.github/agent/setup.sh';
export const DEFAULT_VALIDATION_SCRIPT = '.github/agent/validate.sh';
export const DEFAULT_CONTEXT = ['CLAUDE.md', 'AGENTS.md'];

export class ConfigError extends Error {
  constructor(errors) {
    super(`Invalid agent-workflows configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const PATH_RE = /^[A-Za-z0-9_.][A-Za-z0-9._/-]*$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._*^~<>=/ |-]{0,49}$/;

// Field helpers -------------------------------------------------------------

const int = (min, max, dflt) => ({ kind: 'int', min, max, default: dflt });
const model = (dflt) => ({ kind: 'model', default: dflt });
const bool = (dflt) => ({ kind: 'bool', default: dflt });
const optionalPath = (dflt) => ({ kind: 'optionalPath', default: dflt });
const version = () => ({ kind: 'version', default: null });

export const SCHEMA = {
  version: { kind: 'int', min: 1, max: 1, default: 1 },
  base_branch: { kind: 'branch', default: null },
  branch_prefix: { kind: 'branchPrefix', default: 'claude/' },
  trusted_users: { kind: 'logins', default: null },
  implementation: {
    kind: 'object',
    fields: { model: model('sonnet'), max_turns: int(1, 500, 40), timeout_minutes: int(5, 360, 75) },
  },
  remediation: {
    kind: 'object',
    fields: {
      model: model('sonnet'),
      max_turns: int(1, 500, 30),
      max_passes: int(0, 10, 3),
      timeout_minutes: int(5, 360, 90),
    },
  },
  escalation: {
    kind: 'object',
    fields: {
      enabled: bool(true),
      model: model('opus'),
      audit_max_turns: int(1, 500, 40),
      fix_max_turns: int(1, 500, 45),
    },
  },
  human_fix: {
    kind: 'object',
    fields: { model: model('sonnet'), max_turns: int(1, 500, 30), timeout_minutes: int(5, 360, 75) },
  },
  codex: {
    kind: 'object',
    fields: { wait_minutes: int(0, 60, 15) },
  },
  setup: {
    kind: 'object',
    fields: {
      node_version: version(),
      python_version: version(),
      script: optionalPath(DEFAULT_SETUP_SCRIPT),
    },
  },
  validation: {
    kind: 'object',
    fields: { script: optionalPath(DEFAULT_VALIDATION_SCRIPT) },
  },
  context: { kind: 'paths', default: DEFAULT_CONTEXT },
  pull_request: {
    kind: 'object',
    fields: { footer: { kind: 'optionalPath', default: null } },
  },
};

// Public API ------------------------------------------------------------------

/**
 * Parse and validate config text. Returns { config, warnings }.
 * Throws ConfigError (with every problem found) or YamlError-derived ConfigError.
 */
export function loadConfig(text) {
  let raw;
  try {
    raw = parseYaml(text);
  } catch (err) {
    if (err instanceof YamlError) throw new ConfigError([`${CONFIG_PATH}: ${err.message}`]);
    throw err;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError([`${CONFIG_PATH} must be a mapping of settings`]);
  }
  return validateConfig(raw);
}

export function validateConfig(raw) {
  const errors = [];
  const warnings = [];
  const config = validateObject(raw, SCHEMA, '', errors);
  if (errors.length) throw new ConfigError(errors);

  const minRemediation = config.codex.wait_minutes + 15;
  if (config.remediation.timeout_minutes < minRemediation) {
    warnings.push(
      `remediation.timeout_minutes (${config.remediation.timeout_minutes}) leaves little room after ` +
        `codex.wait_minutes (${config.codex.wait_minutes}); consider at least ${minRemediation}.`,
    );
  }
  if (config.human_fix.timeout_minutes < minRemediation) {
    warnings.push(
      `human_fix.timeout_minutes (${config.human_fix.timeout_minutes}) leaves little room after ` +
        `codex.wait_minutes (${config.codex.wait_minutes}); consider at least ${minRemediation}.`,
    );
  }
  if (config.remediation.max_passes === 0 && !config.escalation.enabled) {
    warnings.push('remediation.max_passes is 0 and escalation is disabled: Codex findings will never be remediated automatically.');
  }
  if (config.trusted_users && config.trusted_users.length === 0) {
    warnings.push('trusted_users is empty: nobody can trigger agent work.');
  }
  return { config, warnings };
}

/**
 * Fill repository-dependent defaults.
 *   repo: { defaultBranch, owner, ownerType }
 */
export function resolveRuntimeConfig(config, repo) {
  const resolved = structuredClone(config);
  if (!resolved.base_branch) {
    if (!repo.defaultBranch) throw new ConfigError(['base_branch is not set and the default branch is unknown']);
    resolved.base_branch = repo.defaultBranch;
  }
  if (resolved.trusted_users === null) {
    if (repo.ownerType === 'User' && repo.owner) {
      resolved.trusted_users = [repo.owner];
    } else {
      throw new ConfigError([
        'trusted_users must be listed explicitly for organization-owned repositories ' +
          '(only personal repositories default to the repository owner)',
      ]);
    }
  }
  return resolved;
}

// Validation internals --------------------------------------------------------

function validateObject(raw, fields, prefix, errors) {
  const out = {};
  const value = raw ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${prefix.slice(0, -1)} must be a mapping`);
    return defaultsFor(fields);
  }
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      const hint = suggest(key, Object.keys(fields));
      errors.push(`unknown setting "${prefix}${key}"${hint ? ` (did you mean "${prefix}${hint}"?)` : ''}`);
    }
  }
  for (const [key, spec] of Object.entries(fields)) {
    const name = `${prefix}${key}`;
    const present = Object.prototype.hasOwnProperty.call(value, key);
    if (spec.kind === 'object') {
      out[key] = validateObject(present ? value[key] : {}, spec.fields, `${name}.`, errors);
      continue;
    }
    out[key] = validateField(present ? value[key] : undefined, present, spec, name, errors);
  }
  return out;
}

function defaultsFor(fields) {
  const out = {};
  for (const [key, spec] of Object.entries(fields)) {
    out[key] = spec.kind === 'object' ? defaultsFor(spec.fields) : cloneDefault(spec.default);
  }
  return out;
}

function cloneDefault(v) {
  return Array.isArray(v) ? [...v] : v;
}

function validateField(v, present, spec, name, errors) {
  if (!present) return cloneDefault(spec.default);
  switch (spec.kind) {
    case 'int':
      if (!Number.isInteger(v) || v < spec.min || v > spec.max) {
        errors.push(`${name} must be an integer between ${spec.min} and ${spec.max} (got ${show(v)})`);
        return spec.default;
      }
      return v;
    case 'bool':
      if (typeof v !== 'boolean') {
        errors.push(`${name} must be true or false (got ${show(v)})`);
        return spec.default;
      }
      return v;
    case 'model':
      if (typeof v !== 'string' || !MODEL_RE.test(v)) {
        errors.push(`${name} must be a model name such as "sonnet", "opus" or a full model id (got ${show(v)})`);
        return spec.default;
      }
      return v;
    case 'branch':
      if (v === null) return null;
      if (!isValidBranch(v)) {
        errors.push(`${name} must be a valid branch name (got ${show(v)})`);
        return spec.default;
      }
      return v;
    case 'branchPrefix':
      if (typeof v !== 'string' || !isValidBranch(v.replace(/[/-]$/, '') || 'x') || v.length > 50) {
        errors.push(`${name} must be a branch name prefix such as "claude/" (got ${show(v)})`);
        return spec.default;
      }
      return v;
    case 'logins': {
      if (v === null) return null;
      if (!Array.isArray(v)) {
        errors.push(`${name} must be a list of GitHub usernames`);
        return spec.default;
      }
      const out = [];
      for (const item of v) {
        if (typeof item !== 'string' || !LOGIN_RE.test(item)) {
          errors.push(`${name} contains an invalid GitHub username: ${show(item)}`);
        } else if (!out.some((x) => x.toLowerCase() === item.toLowerCase())) {
          out.push(item);
        }
      }
      return out;
    }
    case 'paths': {
      if (v === null) return [];
      if (!Array.isArray(v)) {
        errors.push(`${name} must be a list of repository-relative file paths`);
        return cloneDefault(spec.default);
      }
      const out = [];
      for (const item of v) {
        if (!isValidPath(item)) errors.push(`${name} contains an invalid path: ${show(item)}`);
        else if (!out.includes(item)) out.push(item);
      }
      return out;
    }
    case 'optionalPath':
      // null / "" explicitly disable the file; a set path must exist when used.
      if (v === null || v === '') return null;
      if (!isValidPath(v)) {
        errors.push(`${name} must be a repository-relative path without ".." or spaces (got ${show(v)})`);
        return spec.default;
      }
      return v;
    case 'version':
      if (v === null || v === '') return null;
      if (Number.isInteger(v)) return String(v);
      if (typeof v !== 'string' || !VERSION_RE.test(v)) {
        errors.push(`${name} must be a version string such as "22" or "3.12" (got ${show(v)})`);
        return null;
      }
      return v;
    default:
      throw new Error(`unknown schema kind ${spec.kind}`);
  }
}

export function isValidBranch(v) {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(v) &&
    !v.startsWith('-') &&
    !v.startsWith('/') &&
    !v.endsWith('/') &&
    !v.endsWith('.') &&
    !v.endsWith('.lock') &&
    !v.includes('..') &&
    !v.includes('//') &&
    !v.includes('/.')
  );
}

export function isValidPath(v) {
  return (
    typeof v === 'string' &&
    v.length <= 300 &&
    PATH_RE.test(v) &&
    !v.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
  );
}

function show(v) {
  return v === undefined ? 'nothing' : JSON.stringify(v);
}

function suggest(word, candidates) {
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(word, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
