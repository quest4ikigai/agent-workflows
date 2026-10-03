// Command-line interface: `agent-workflows install|check [path]`.

import { inspectRepository, defaultExec } from './inspect.mjs';
import { InstallError, applyPlan, planInstall } from './install.mjs';
import { formatCheck, runCheck } from './check.mjs';
import { VERSION, DEFAULT_REF } from './version.mjs';

const USAGE = `agent-workflows ${VERSION}

Usage:
  agent-workflows install [path] [options]   Install or update the agent workflows
  agent-workflows check [path] [--offline]   Verify an installation (read-only)
  agent-workflows --version

Install options:
  --dry-run               Show what would change without writing files
  --force                 Replace wrappers that are unmanaged or edited locally
  --ref <ref>             agent-workflows ref for the wrappers (default: existing, else ${DEFAULT_REF})
  --workflows-repo <o/r>  Repository hosting the reusable workflows
  --base-branch <name>    Branch automated PRs target (default: repository default branch)
  --trusted-user <login>  User allowed to trigger agent work (repeatable)
  --node-version <ver>    Node.js version for the workflow runner
  --offline               Do not query GitHub through the gh CLI

install never modifies an existing .github/agent/config.yml, setup.sh or
validate.sh, and never changes anything on GitHub.`;

export function parseArgs(argv) {
  const opts = { command: null, path: '.', trustedUsers: [], dryRun: false, force: false, offline: false };
  const valueFlags = {
    '--ref': 'ref',
    '--workflows-repo': 'workflowsRepo',
    '--base-branch': 'baseBranch',
    '--node-version': 'nodeVersion',
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.command = 'help';
    else if (a === '--version' || a === '-v') opts.command = 'version';
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--offline') opts.offline = true;
    else if (a === '--trusted-user') opts.trustedUsers.push(requireValue(argv, ++i, a));
    else if (valueFlags[a]) opts[valueFlags[a]] = requireValue(argv, ++i, a);
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else positional.push(a);
  }
  if (!opts.command) opts.command = positional.shift() ?? 'help';
  if (positional.length) opts.path = positional.shift();
  if (positional.length) throw new UsageError(`unexpected argument ${positional[0]}`);
  return opts;
}

function requireValue(argv, i, flag) {
  if (i >= argv.length || argv[i].startsWith('--')) throw new UsageError(`${flag} requires a value`);
  return argv[i];
}

class UsageError extends Error {}

const ACTION_LABELS = {
  create: 'create   ',
  update: 'update   ',
  overwrite: 'overwrite',
  unchanged: 'unchanged',
  keep: 'keep     ',
  conflict: 'CONFLICT ',
};

export function formatPlan(inspection, plan, { dryRun }) {
  const out = [];
  const node = inspection.node;
  out.push('Detected');
  out.push(`  repository       ${inspection.remote?.slug ?? '(no GitHub remote)'}`);
  out.push(`  default branch   ${inspection.defaultBranch ?? '(unknown)'}`);
  if (node) {
    out.push(`  package manager  ${node.packageManager} (${node.packageManagerSource})`);
    out.push(`  node version     ${node.nodeVersion ? `${node.nodeVersion} (${node.nodeVersionSource})` : '(not pinned)'}`);
  }
  if (inspection.ecosystems.length) out.push(`  ecosystems       ${inspection.ecosystems.join(', ')}`);
  out.push(`  validation       ${plan.values.validationCommands.length ? plan.values.validationCommands.join(' && ') : '(none detected)'}`);
  out.push(`  context docs     ${inspection.contextDocs.join(', ') || '(none)'}`);
  out.push(`  wrappers use     ${plan.workflowsRepo}@${plan.ref}`);
  out.push('');
  out.push(dryRun ? 'Plan (dry run — nothing written)' : 'Changes');
  for (const f of plan.files) out.push(`  ${ACTION_LABELS[f.action]} ${f.path}  — ${f.reason}`);
  if (plan.notes.length) {
    out.push('');
    out.push('Notes');
    for (const n of plan.notes) out.push(`  - ${n.replace(/\n/g, '\n    ')}`);
  }
  return out.join('\n');
}

const NEXT_STEPS = `
Next steps
  1. Review the generated files (especially .github/agent/validate.sh and config.yml).
  2. Commit them to the default branch (and to base_branch if different).
  3. Configure repository secrets CLAUDE_CODE_OAUTH_TOKEN and AGENT_GITHUB_TOKEN.
  4. Install the Claude GitHub App and enable Codex code review for the repository.
  5. Run: agent-workflows check .`;

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, exec = defaultExec } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`error: ${err.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw err;
  }

  if (opts.command === 'help') {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (opts.command === 'version') {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!['install', 'check'].includes(opts.command)) {
    stderr.write(`error: unknown command "${opts.command}"\n\n${USAGE}\n`);
    return 2;
  }

  let inspection;
  try {
    inspection = inspectRepository(opts.path, { exec, useGh: !opts.offline });
  } catch (err) {
    stderr.write(`error: ${err.message}\n`);
    return 1;
  }

  if (opts.command === 'check') {
    const result = runCheck(inspection, { exec, useGh: !opts.offline });
    stdout.write(`agent-workflows check ${inspection.root}\n\n${formatCheck(result)}\n`);
    return result.errors ? 1 : 0;
  }

  if (!inspection.isGitRepo) {
    stderr.write(`error: ${inspection.root} is not a git repository\n`);
    return 1;
  }
  let plan;
  try {
    plan = planInstall(inspection, {
      ref: opts.ref,
      workflowsRepo: opts.workflowsRepo,
      force: opts.force,
      baseBranch: opts.baseBranch,
      trustedUsers: opts.trustedUsers,
      nodeVersion: opts.nodeVersion,
    });
  } catch (err) {
    if (err instanceof InstallError || /invalid (ref|workflows repository)/.test(err.message)) {
      stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  stdout.write(`agent-workflows install ${inspection.root}\n\n${formatPlan(inspection, plan, opts)}\n`);
  const conflicts = plan.files.filter((f) => f.action === 'conflict');
  if (!opts.dryRun) {
    const written = applyPlan(inspection.root, plan);
    stdout.write(written.length ? `\nWrote ${written.length} file(s).\n` : '\nEverything is already up to date.\n');
    if (written.length) stdout.write(`${NEXT_STEPS}\n`);
  }
  if (conflicts.length) {
    stderr.write(`\n${conflicts.length} file(s) left untouched because of conflicts (see above).\n`);
    return 1;
  }
  return 0;
}
