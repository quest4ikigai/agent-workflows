// Minimal GitHub Actions runtime helpers (outputs, annotations, summaries).

import { appendFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export function readEvent(env = process.env) {
  if (!env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is not set');
  return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
}

export function repoFromEnv(env = process.env) {
  const full = env.GITHUB_REPOSITORY;
  if (!full || !full.includes('/')) throw new Error('GITHUB_REPOSITORY is not set');
  const [owner, name] = full.split('/');
  return { owner, name, full };
}

export function runUrl(env = process.env) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  return `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

/** Collects step outputs; `flush` writes them to $GITHUB_OUTPUT. */
export class Outputs {
  constructor() {
    this.values = {};
  }
  set(name, value) {
    this.values[name] = value === undefined || value === null ? '' : String(value);
  }
  flush(env = process.env) {
    const file = env.GITHUB_OUTPUT;
    const lines = [];
    for (const [name, value] of Object.entries(this.values)) {
      if (!value.includes('\n')) {
        lines.push(`${name}=${value}`);
        continue;
      }
      // Random delimiter: values may contain arbitrary user text (issue bodies).
      let delim;
      do delim = `AW_EOF_${randomBytes(12).toString('hex')}`;
      while (value.includes(delim));
      lines.push(`${name}<<${delim}`, value, delim);
    }
    if (file) appendFileSync(file, `${lines.join('\n')}\n`);
    else for (const l of lines) process.stdout.write(`[output] ${l}\n`);
  }
}

const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export const log = {
  info: (msg) => process.stdout.write(`${msg}\n`),
  notice: (msg) => process.stdout.write(`::notice::${escapeData(msg)}\n`),
  warning: (msg) => process.stdout.write(`::warning::${escapeData(msg)}\n`),
  error: (msg) => process.stdout.write(`::error::${escapeData(msg)}\n`),
};

export function summary(markdown, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
