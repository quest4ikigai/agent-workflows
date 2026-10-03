// `agent-workflows check`: verify an installation without changing anything.
//
// Local checks always run. GitHub checks run through the gh CLI when it is
// installed and authenticated; they read secret *names* only (never values).
// Items GitHub offers no API for are reported as manual (?) reminders.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { CONFIG_PATH, ConfigError, loadConfig, resolveRuntimeConfig } from './config.mjs';
import { NO_VALIDATION_MARKER, WRAPPERS, parseWrapper, renderWrapper } from './templates.mjs';
import { classifyRef } from './version.mjs';
import { LABELS } from './runtime/gate.mjs';


const ok = (message) => ({ status: 'ok', message });
const error = (message, hint) => ({ status: 'error', message, hint });
const warn = (message, hint) => ({ status: 'warn', message, hint });
const manual = (message, hint) => ({ status: 'manual', message, hint });
const info = (message) => ({ status: 'info', message });

/**
 * Returns { sections: [{ title, items }], errors: number }.
 * options: { exec, useGh }
 */
export function runCheck(inspection, { exec, useGh = true } = {}) {
  const root = inspection.root;
  const read = (p) => {
    const full = path.join(root, p);
    return existsSync(full) ? readFileSync(full, 'utf8') : null;
  };
  const sections = [];

  // Repository ----------------------------------------------------------------------
  const repoItems = [];
  if (!inspection.isGitRepo) repoItems.push(error(`${root} is not a git repository`));
  if (inspection.remote) {
    repoItems.push(ok(`GitHub repository ${inspection.remote.slug}`));
  } else {
    repoItems.push(warn('no GitHub "origin" remote found; GitHub checks skipped'));
  }
  if (inspection.defaultBranch) repoItems.push(ok(`default branch ${inspection.defaultBranch} (from ${inspection.defaultBranchSource})`));
  else repoItems.push(warn('default branch unknown'));
  sections.push({ title: 'Repository', items: repoItems });

  // Wrappers ------------------------------------------------------------------------
  const wrapperItems = [];
  const localWrappers = {};
  for (const w of WRAPPERS) {
    const content = read(w.path);
    localWrappers[w.path] = content;
    if (content === null) {
      wrapperItems.push(error(`${w.path} missing`, 'run: agent-workflows install .'));
      continue;
    }
    const parsed = parseWrapper(content);
    if (!parsed.managed) {
      wrapperItems.push(error(`${w.path} is not managed by agent-workflows`, 'run: agent-workflows install . --force'));
      continue;
    }
    if (parsed.template !== w.template) {
      wrapperItems.push(error(`${w.path} contains template "${parsed.template}", expected "${w.template}"`));
      continue;
    }
    if (parsed.modified) {
      wrapperItems.push(warn(`${w.path} was edited locally`, 'local edits are preserved; run install --force to regenerate'));
      continue;
    }
    const expected = renderWrapper(w.template, { ref: parsed.ref, workflowsRepo: parsed.workflowsRepo });
    const kind = classifyRef(parsed.ref);
    if (expected !== content) {
      wrapperItems.push(warn(`${w.path} differs from this CLI's template`, 'run: agent-workflows install . to update'));
    } else if (kind === 'branch') {
      wrapperItems.push(warn(`${w.path} → ${parsed.workflowsRepo}@${parsed.ref} (moving branch; prefer a release tag)`));
    } else {
      wrapperItems.push(ok(`${w.path} → ${parsed.workflowsRepo}@${parsed.ref}`));
    }
  }
  for (const legacy of inspection.legacy) {
    wrapperItems.push(warn(`legacy file ${legacy} should be removed`, 'it is superseded by the agent-workflows wrappers'));
  }
  sections.push({ title: 'Workflow installation', items: wrapperItems });

  // Configuration -------------------------------------------------------------------
  const cfgItems = [];
  let config = null;
  const cfgText = read(CONFIG_PATH);
  if (cfgText === null) {
    cfgItems.push(error(`${CONFIG_PATH} missing`, 'run: agent-workflows install .'));
  } else {
    try {
      const loaded = loadConfig(cfgText);
      config = loaded.config;
      cfgItems.push(ok(`${CONFIG_PATH} valid`));
      loaded.warnings.forEach((w) => cfgItems.push(warn(w)));
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      err.errors.forEach((e) => cfgItems.push(error(e)));
    }
  }
  if (config) {
    try {
      const resolved = resolveRuntimeConfig(config, {
        defaultBranch: inspection.defaultBranch,
        owner: inspection.remote?.owner,
        ownerType: inspection.ownerType ?? 'User',
      });
      cfgItems.push(ok(`trusted users: ${resolved.trusted_users.join(', ') || '(none)'}`));
      cfgItems.push(ok(`automated PRs target ${resolved.base_branch}`));
      if (inspection.defaultBranch && resolved.base_branch !== inspection.defaultBranch) {
        cfgItems.push(info(`base_branch differs from the default branch: wrappers must be committed to both ${inspection.defaultBranch} and ${resolved.base_branch}`));
      }
      if (config.trusted_users === null && !inspection.ownerType) {
        cfgItems.push(warn('trusted_users defaults to the repository owner, which only works for personal repositories'));
      }
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      err.errors.forEach((e) => cfgItems.push(error(e)));
    }
    cfgItems.push(...scriptItems(root, 'setup script', config.setup.script, read));
    cfgItems.push(...scriptItems(root, 'validation script', config.validation.script, read, true));
    if (config.pull_request.footer) {
      cfgItems.push(read(config.pull_request.footer) === null
        ? error(`pull_request.footer ${config.pull_request.footer} not found`)
        : ok(`PR footer ${config.pull_request.footer}`));
    }
    if (inspection.node && !config.setup.node_version) {
      cfgItems.push(warn('Node.js project without setup.node_version: the runner default Node.js will be used'));
    }
    if (config.context.length === 0) cfgItems.push(warn('no context documents configured'));
    for (const doc of config.context) {
      cfgItems.push(read(doc) === null ? warn(`context document ${doc} not found (optional; skipped)`) : ok(`context document ${doc}`));
    }
  }
  sections.push({ title: 'Configuration', items: cfgItems });

  // GitHub ----------------------------------------------------------------------------
  const ghItems = [];
  if (!useGh) {
    ghItems.push(info('skipped (--offline)'));
  } else if (!inspection.remote) {
    ghItems.push(info('skipped (no GitHub remote)'));
  } else if (!inspection.gh.available) {
    ghItems.push(warn('gh CLI not installed; secrets, labels and branch protection not checked'));
  } else if (!inspection.gh.authenticated) {
    ghItems.push(warn('gh CLI not authenticated; run gh auth login to check secrets and labels'));
  } else {
    ghItems.push(...githubItems(inspection, config, localWrappers, exec));
  }
  sections.push({ title: 'GitHub', items: ghItems });

  // Manual ----------------------------------------------------------------------------
  sections.push({
    title: 'Manual (cannot be verified automatically)',
    items: [
      manual('Claude GitHub App is installed on this repository', 'https://github.com/apps/claude'),
      manual('Codex code review is enabled for this repository; automatic reviews are off (reviews are requested explicitly)', 'https://chatgpt.com/codex/settings/code-review'),
      manual('AGENT_GITHUB_TOKEN belongs to a user whose GitHub account is connected to Codex'),
    ],
  });

  const errors = sections.flatMap((s) => s.items).filter((i) => i.status === 'error').length;
  return { sections, errors };
}

function scriptItems(root, label, scriptPath, read, warnIfDisabled = false) {
  if (!scriptPath) {
    return warnIfDisabled ? [warn(`${label} disabled: no deterministic validation will run`)] : [info(`${label} disabled`)];
  }
  const content = read(scriptPath);
  if (content === null) return [error(`${label} ${scriptPath} not found`, 'create it or set the path to null')];
  const items = [];
  if (content.includes(NO_VALIDATION_MARKER)) {
    items.push(warn(`${label} ${scriptPath} has no commands yet`, 'add your checks and remove the marker comment'));
  } else {
    items.push(ok(`${label} ${scriptPath}`));
  }
  const mode = statSync(path.join(root, scriptPath)).mode;
  if (!(mode & 0o111)) items.push(info(`${scriptPath} is not executable (fine: workflows run it with bash)`));
  return items;
}

function githubItems(inspection, config, localWrappers, exec) {
  const items = [];
  const slug = inspection.remote.slug;
  const api = (p, jq) => {
    const args = ['api', p];
    if (jq) args.push('--jq', jq);
    return exec('gh', args, { cwd: inspection.root });
  };

  // Secret names (values are never readable).
  const repoSecrets = api(`repos/${slug}/actions/secrets?per_page=100`, '.secrets[].name');
  if (repoSecrets.code !== 0) {
    items.push(warn('could not list repository secrets (requires admin access to the repository)'));
  } else {
    const names = new Set(repoSecrets.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
    const orgSecrets = api(`repos/${slug}/actions/organization-secrets?per_page=100`, '.secrets[].name');
    if (orgSecrets.code === 0) orgSecrets.stdout.split('\n').map((s) => s.trim()).filter(Boolean).forEach((n) => names.add(n));
    if (names.has('CLAUDE_CODE_OAUTH_TOKEN')) items.push(ok('secret CLAUDE_CODE_OAUTH_TOKEN configured'));
    else if (names.has('ANTHROPIC_API_KEY')) items.push(ok('secret ANTHROPIC_API_KEY configured (used instead of CLAUDE_CODE_OAUTH_TOKEN)'));
    else items.push(error('secret CLAUDE_CODE_OAUTH_TOKEN not configured', 'generate with `claude setup-token`, then: gh secret set CLAUDE_CODE_OAUTH_TOKEN'));
    if (names.has('AGENT_GITHUB_TOKEN')) items.push(ok('secret AGENT_GITHUB_TOKEN configured'));
    else items.push(error('secret AGENT_GITHUB_TOKEN not configured', 'fine-grained PAT; see docs/installation.md, then: gh secret set AGENT_GITHUB_TOKEN'));
  }

  // Labels.
  const labels = api(`repos/${slug}/labels?per_page=100`, '.[].name');
  if (labels.code === 0) {
    const names = new Set(labels.stdout.split('\n').map((s) => s.trim()));
    for (const [name, meta] of Object.entries(LABELS)) {
      if (names.has(name)) items.push(ok(`label ${name} exists`));
      else items.push(warn(`label ${name} missing`, `gh label create ${name} --color ${meta.color} --description "${meta.description}"`));
    }
  }

  // Actions policy.
  const perms = api(`repos/${slug}/actions/permissions`);
  if (perms.code === 0) {
    try {
      const p = JSON.parse(perms.stdout);
      if (p.enabled === false) items.push(error('GitHub Actions is disabled for this repository'));
      else if (p.allowed_actions === 'selected') {
        items.push(warn('Actions are restricted to selected actions', 'allow anthropics/claude-code-action, actions/checkout, actions/setup-node, actions/setup-python and quest4ikigai/agent-workflows'));
      } else items.push(ok(`GitHub Actions enabled (${p.allowed_actions})`));
    } catch {
      // ignore unparsable output
    }
  }

  // Wrappers must be on the default branch (issues/issue_comment run from there)
  // and on the base branch (pull_request/pull_request_review run from the merge commit).
  const branches = new Set([inspection.defaultBranch, config?.base_branch].filter(Boolean));
  for (const branch of branches) {
    const missing = [];
    const differs = [];
    for (const w of WRAPPERS) {
      const remote = api(`repos/${slug}/contents/${w.path}?ref=${encodeURIComponent(branch)}`, '.content');
      if (remote.code !== 0) {
        missing.push(path.basename(w.path));
        continue;
      }
      const decoded = Buffer.from(remote.stdout.replace(/\s/g, ''), 'base64').toString('utf8');
      if (localWrappers[w.path] !== null && decoded !== localWrappers[w.path]) differs.push(path.basename(w.path));
    }
    if (missing.length) items.push(warn(`not yet on ${branch}: ${missing.join(', ')}`, 'commit and push the generated files to activate the workflows'));
    if (differs.length) items.push(warn(`on ${branch} but different from the local checkout: ${differs.join(', ')}`, 'push the local changes, or pull if the remote is newer'));
    if (!missing.length && !differs.length) items.push(ok(`wrappers present on ${branch}`));
  }

  // Base branch protection.
  const base = config?.base_branch || inspection.defaultBranch;
  if (base) {
    const prot = api(`repos/${slug}/branches/${encodeURIComponent(base)}`, '.protected');
    if (prot.code === 0) {
      if (prot.stdout.trim() === 'true') items.push(ok(`base branch ${base} is protected`));
      else items.push(warn(`base branch ${base} is not protected`, 'protect it so no automation can push to it directly'));
    }
  }
  return items;
}

const SYMBOLS = { ok: '✓', error: '✗', warn: '!', manual: '?', info: '·' };

export function formatCheck(result) {
  const out = [];
  for (const section of result.sections) {
    out.push(section.title);
    for (const item of section.items) {
      out.push(`  ${SYMBOLS[item.status]} ${item.message}`);
      if (item.hint) out.push(`      ${item.hint}`);
    }
    out.push('');
  }
  out.push(result.errors ? `${result.errors} problem(s) must be fixed.` : 'No blocking problems found.');
  return out.join('\n');
}
