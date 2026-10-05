#!/usr/bin/env node
// Entry point for the reusable workflows:  node lib/runtime/main.mjs <command> [kind]
//
// Inputs arrive as environment variables set by the workflow step; results are
// written to $GITHUB_OUTPUT. See .github/workflows/*.yml for the wiring.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigError } from '../config.mjs';
import { Outputs, log, readEvent, repoFromEnv, runUrl, summary } from './actions.mjs';
import { CredentialError, removeCheckoutCredentials } from './credentials.mjs';
import { createClient } from './github.mjs';
import { GateError, gateHumanFix, gateImplement, gateReview, loadRepoConfig, parseCommand } from './gate.mjs';
import * as flows from './flows.mjs';
import {
  SCHEMAS,
  auditPrompt,
  claudeArgs,
  existingContextDocs,
  finalFixPrompt,
  humanFixPrompt,
  implementPrompt,
  remediatePrompt,
} from './prompts.mjs';
import { parseResult } from './results.mjs';

const GATES = { implement: gateImplement, review: gateReview, 'human-fix': gateHumanFix };

/** Commands and, where applicable, the kinds they accept. Used by tests to verify the YAML wiring. */
export const COMMANDS = {
  gate: Object.keys(GATES),
  prompt: Object.keys(SCHEMAS),
  result: Object.keys(SCHEMAS),
  'preflight-implement': null,
  'finish-implement': null,
  'review-cycle': null,
  'start-review': null,
  'plan-remediation': null,
  'finish-remediation': null,
  'finish-audit': null,
  'finish-final-fix': null,
  'prepare-human-fix': null,
  'finish-human-fix': null,
  'remove-checkout-credentials': null,
};

export function buildContext(env = process.env) {
  const apiUrl = env.GITHUB_API_URL || 'https://api.github.com';
  return {
    env,
    repo: repoFromEnv(env),
    event: readEvent(env),
    eventName: env.GITHUB_EVENT_NAME,
    // Steps that only render prompts or parse results receive no token.
    client: env.GITHUB_TOKEN ? createClient({ token: env.GITHUB_TOKEN, apiUrl }) : null,
    agentClient: env.AGENT_GITHUB_TOKEN ? createClient({ token: env.AGENT_GITHUB_TOKEN, apiUrl }) : null,
    config: env.AW_CONFIG ? JSON.parse(env.AW_CONFIG) : null,
    outputs: new Outputs(),
    log,
    runUrl: runUrl(env),
    workspace: env.GITHUB_WORKSPACE || process.cwd(),
  };
}

const claudeInputs = (env) => ({
  claudeOutcome: env.CLAUDE_OUTCOME,
  claudeConclusion: env.CLAUDE_CONCLUSION,
  rawResult: env.RAW_RESULT,
  validationOutcome: env.VALIDATION_OUTCOME,
  validationResult: env.VALIDATION_RESULT,
});

async function runGate(ctx, kind) {
  const { config, warnings } = await loadRepoConfig(ctx.client, ctx.repo, ctx.event);
  warnings.forEach((w) => ctx.log.warning(`config: ${w}`));
  ctx.config = config;
  const gate = GATES[kind];
  if (!gate) throw new Error(`unknown gate ${kind}`);
  const decision = await gate({ client: ctx.client, repo: ctx.repo, config, event: ctx.event, eventName: ctx.eventName });

  ctx.log.info(`Gate (${kind}): ${decision.action} — ${decision.reason}`);
  summary(`**agent-workflows ${kind} gate:** \`${decision.action}\` — ${decision.reason}`, ctx.env);
  if (decision.refusal) {
    const r = decision.refusal;
    if (r.removeLabel) await flows.removeLabel(ctx, r.number, r.removeLabel);
    if (r.notify) await flows.comment(ctx, r.number, r.message);
  }
  ctx.outputs.set('config', JSON.stringify(config));
  ctx.outputs.set('action', decision.action);
  ctx.outputs.set('eligible', decision.action !== 'none' ? 'true' : 'false');
  ctx.outputs.set('issue_number', decision.issueNumber ?? '');
  ctx.outputs.set('pr_number', decision.prNumber ?? '');
  ctx.outputs.set('actor', decision.actor ?? '');
  ctx.outputs.set('via', decision.via ?? '');
  return 0;
}

function scriptExists(ctx) {
  const script = ctx.config.validation.script;
  return !!script && existsSync(path.join(ctx.workspace, script));
}

function runPrompt(ctx, kind) {
  const { env, event, config } = ctx;
  const docs = existingContextDocs(ctx.workspace, config.context);
  const common = { config, docs, scriptExists: scriptExists(ctx) };
  const pr = env.PR_NUMBER;
  const headRef = env.HEAD_REF;
  let prompt;
  switch (kind) {
    case 'implement':
      if (!env.WORK_BRANCH) throw new Error('WORK_BRANCH is required for the implement prompt');
      prompt = implementPrompt({ ...common, issue: event.issue, branch: env.WORK_BRANCH });
      break;
    case 'remediate':
      prompt = remediatePrompt({ ...common, pr, headRef, reviewBody: event.review?.body ?? '' });
      break;
    case 'human-fix': {
      const { argument } = parseCommand(event.comment?.body);
      prompt = humanFixPrompt({ ...common, pr, headRef, actor: event.comment?.user?.login, feedback: argument });
      break;
    }
    case 'audit':
      prompt = auditPrompt({ ...common, pr, headRef });
      break;
    case 'final-fix':
      prompt = finalFixPrompt({ ...common, pr, headRef, findings: env.AUDIT_FINDINGS, auditSummary: env.AUDIT_SUMMARY });
      break;
    default:
      throw new Error(`unknown prompt kind ${kind}`);
  }
  ctx.outputs.set('prompt', prompt);
  ctx.outputs.set('claude_args', claudeArgs(kind, config));
  ctx.log.info(`Context documents: ${docs.join(', ') || '(none found)'}`);
  return 0;
}

function runResult(ctx, kind) {
  const result = parseResult(kind, ctx.env.RAW_RESULT);
  if (!result.ok) ctx.log.warning(result.error);
  else ctx.log.info(`Claude result: ${result.status}`);
  ctx.outputs.set('status', result.status);
  return 0;
}

const OFFLINE_COMMANDS = new Set(['prompt', 'result', 'remove-checkout-credentials']);

export async function run(command, kind, ctx) {
  const env = ctx.env;
  const pr = env.PR_NUMBER;
  if (!ctx.client && command in COMMANDS && !OFFLINE_COMMANDS.has(command)) {
    throw new Error(`GITHUB_TOKEN is required for ${command}`);
  }
  switch (command) {
    case 'gate':
      return runGate(ctx, kind);
    case 'prompt':
      return runPrompt(ctx, kind);
    case 'result':
      return runResult(ctx, kind);
    case 'preflight-implement':
      return flows.preflightImplement(ctx, { issueNumber: env.ISSUE_NUMBER });
    case 'finish-implement':
      return flows.finishImplement(ctx, {
        ...claudeInputs(env),
        issueNumber: env.ISSUE_NUMBER,
        issueTitle: ctx.event.issue?.title,
        preflight: env.PREFLIGHT,
        setupOutcome: env.SETUP_OUTCOME,
        branch: env.WORK_BRANCH,
      });
    case 'review-cycle':
      return flows.reviewCycle(ctx, { pr, origin: env.ORIGIN });
    case 'start-review':
      return flows.startReview(ctx, { pr, actor: env.ACTOR, via: env.VIA });
    case 'plan-remediation':
      return flows.planRemediation(ctx, { pr });
    case 'finish-remediation':
      return flows.finishRemediation(ctx, { ...claudeInputs(env), pr, passes: env.PASSES, countable: env.COUNTABLE, headSha: env.HEAD_SHA });
    case 'finish-audit':
      return flows.finishAudit(ctx, { ...claudeInputs(env), pr, headSha: env.HEAD_SHA });
    case 'finish-final-fix':
      return flows.finishFinalFix(ctx, { ...claudeInputs(env), pr, auditSummary: env.AUDIT_SUMMARY });
    case 'prepare-human-fix':
      return flows.prepareHumanFix(ctx, { pr, actor: env.ACTOR });
    case 'finish-human-fix':
      return flows.finishHumanFix(ctx, { ...claudeInputs(env), pr, proceed: env.PROCEED, setupOutcome: env.SETUP_OUTCOME });
    case 'remove-checkout-credentials':
      removeCheckoutCredentials({ cwd: ctx.workspace, serverUrl: env.GITHUB_SERVER_URL || 'https://github.com', log: ctx.log });
      return 0;
    default:
      throw new Error(`unknown command ${command}`);
  }
}

async function cli() {
  const [command, kind] = process.argv.slice(2);
  let ctx;
  try {
    ctx = buildContext();
    const code = await run(command, kind, ctx);
    ctx.outputs.flush();
    process.exitCode = code;
  } catch (err) {
    if (ctx) ctx.outputs.flush();
    if (err instanceof ConfigError || err instanceof GateError || err instanceof CredentialError) {
      log.error(err.message);
    } else {
      log.error(`agent-workflows ${command}${kind ? ` ${kind}` : ''} failed: ${err.message}`);
      process.stderr.write(`${err.stack}\n`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) cli();
