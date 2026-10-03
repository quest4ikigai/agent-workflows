// Install / update planning.
//
// `planInstall` is pure: given an inspection result and options it decides what
// every file should become and why. `applyPlan` writes the files. Keeping the
// two apart gives us dry-run for free and makes the policy easy to test.
//
// Ownership rules:
//   - wrappers are managed: created, regenerated when untouched, never
//     overwritten after local edits (or when unmanaged) unless --force;
//   - config.yml, setup.sh and validate.sh belong to the repository: created
//     when missing, never modified afterwards.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

import { CONFIG_PATH, DEFAULT_CONTEXT, loadConfig } from './config.mjs';
import {
  DEFAULT_SETUP_SCRIPT,
  DEFAULT_VALIDATION_SCRIPT,
  DEFAULT_WORKFLOWS_REPO,
  WRAPPERS,
  parseWrapper,
  renderConfig,
  renderSetupScript,
  renderValidateScript,
  renderWrapper,
} from './templates.mjs';
import { DEFAULT_REF, classifyRef } from './version.mjs';

export class InstallError extends Error {}

/**
 * options: {
 *   ref, workflowsRepo, force, baseBranch, trustedUsers (array), nodeVersion
 * }
 */
export function planInstall(inspection, options = {}) {
  const root = inspection.root;
  const read = (p) => {
    const full = path.join(root, p);
    return existsSync(full) ? readFileSync(full, 'utf8') : null;
  };
  const files = [];
  const notes = [];

  // Wrapper ref / repository: explicit option > existing managed wrapper > default.
  const existingWrappers = WRAPPERS.map((w) => ({ ...w, content: read(w.path) }));
  const existingManaged = existingWrappers.map((w) => (w.content ? parseWrapper(w.content) : null)).find((p) => p?.managed && p.ref);
  const ref = options.ref || existingManaged?.ref || DEFAULT_REF;
  const workflowsRepo = options.workflowsRepo || existingManaged?.workflowsRepo || DEFAULT_WORKFLOWS_REPO;

  // Repository-owned files --------------------------------------------------------
  const values = deriveValues(inspection, options, notes);

  if (inspection.agentFiles.config) {
    files.push({ path: CONFIG_PATH, action: 'keep', reason: 'exists; repository-owned (never modified)' });
    try {
      const { warnings } = loadConfig(read(CONFIG_PATH));
      warnings.forEach((w) => notes.push(`config: ${w}`));
    } catch (err) {
      notes.push(`existing ${CONFIG_PATH} is invalid — fix it before relying on the workflows:\n${err.message}`);
    }
  } else {
    files.push({ path: CONFIG_PATH, action: 'create', content: renderConfig(values), reason: 'new configuration' });
  }

  if (values.setupScript) {
    if (inspection.agentFiles.setup) {
      files.push({ path: DEFAULT_SETUP_SCRIPT, action: 'keep', reason: 'exists; repository-owned' });
    } else {
      files.push({
        path: DEFAULT_SETUP_SCRIPT,
        action: 'create',
        content: renderSetupScript(values.setupCommands),
        mode: 0o755,
        reason: `dependency install (${values.setupSource})`,
      });
    }
  } else if (inspection.agentFiles.setup) {
    files.push({ path: DEFAULT_SETUP_SCRIPT, action: 'keep', reason: 'exists; repository-owned' });
  }

  if (inspection.agentFiles.validate) {
    files.push({ path: DEFAULT_VALIDATION_SCRIPT, action: 'keep', reason: 'exists; repository-owned' });
  } else {
    files.push({
      path: DEFAULT_VALIDATION_SCRIPT,
      action: 'create',
      content: renderValidateScript(values.validationCommands, values.validationSuggestions),
      mode: 0o755,
      reason: values.validationCommands.length
        ? `${values.validationCommands.length} command(s) from package.json scripts`
        : 'no validation commands detected — fill in before relying on validation',
    });
  }

  // Wrappers ----------------------------------------------------------------------
  for (const w of existingWrappers) {
    const desired = renderWrapper(w.template, { ref, workflowsRepo });
    if (w.content === null) {
      files.push({ path: w.path, action: 'create', content: desired, reason: `wrapper → ${workflowsRepo}@${ref}` });
      continue;
    }
    const parsed = parseWrapper(w.content);
    if (w.content === desired) {
      files.push({ path: w.path, action: 'unchanged', reason: `managed, ${workflowsRepo}@${ref}` });
    } else if (!parsed.managed) {
      files.push(
        options.force
          ? { path: w.path, action: 'overwrite', content: desired, reason: 'unmanaged file replaced (--force)' }
          : { path: w.path, action: 'conflict', reason: 'exists but is not managed by agent-workflows (use --force to replace)' },
      );
    } else if (parsed.modified) {
      files.push(
        options.force
          ? { path: w.path, action: 'overwrite', content: desired, reason: 'local edits discarded (--force)' }
          : { path: w.path, action: 'conflict', reason: 'managed file was edited locally (use --force to regenerate)' },
      );
    } else {
      const why = parsed.ref !== ref ? `ref ${parsed.ref} → ${ref}` : 'template updated';
      files.push({ path: w.path, action: 'update', content: desired, reason: why });
    }
  }

  for (const legacy of inspection.legacy) {
    notes.push(`legacy file ${legacy} is superseded by agent-workflows; remove it in the same change.`);
  }
  if (classifyRef(ref) === 'branch') {
    notes.push(`wrappers reference "${ref}", a moving branch — use a release tag (e.g. ${DEFAULT_REF}) once one exists.`);
  }

  return { files, notes, values, ref, workflowsRepo };
}

function deriveValues(inspection, options, notes) {
  const values = {
    baseBranch: options.baseBranch || inspection.defaultBranch || null,
    trustedUsers: null,
    nodeVersion: null,
    pythonVersion: null,
    setupScript: null,
    setupCommands: [],
    setupSource: null,
    validationScript: DEFAULT_VALIDATION_SCRIPT,
    validationCommands: [],
    validationSuggestions: [],
    context: [],
  };

  if (!values.baseBranch) {
    notes.push('default branch unknown (no origin/HEAD and gh unavailable); base_branch left to the runtime default. Pass --base-branch to pin it.');
  }

  // Trusted users: explicit > personal-repository owner. Never guessed for orgs.
  if (options.trustedUsers && options.trustedUsers.length) {
    values.trustedUsers = options.trustedUsers;
  } else if (inspection.ownerType === 'User' && inspection.remote) {
    values.trustedUsers = [inspection.remote.owner];
  } else if (inspection.ownerType === 'Organization') {
    throw new InstallError(
      `${inspection.remote.slug} is owned by an organization; pass --trusted-user <login> (repeatable) to choose who may trigger agent work.`,
    );
  } else {
    notes.push('could not determine whether the repository owner is a user or an organization; trusted_users left to the runtime default (repository owner, personal repositories only). Pass --trusted-user to set it explicitly.');
  }

  const setupLines = [];
  const sources = [];
  if (inspection.node) {
    if (inspection.node.error) throw new InstallError(inspection.node.error);
    values.nodeVersion = options.nodeVersion || inspection.node.nodeVersion;
    if (!values.nodeVersion) {
      notes.push('no Node.js version found (.nvmrc, .node-version, engines.node); the runner default Node.js will be used. Pass --node-version to pin one.');
    }
    if (inspection.node.packageManager === 'bun') {
      setupLines.push('# TODO: make bun available on the runner (it is not preinstalled), then:');
      setupLines.push(...inspection.node.installCommands.map((c) => `# ${c}`));
      notes.push('bun detected: complete .github/agent/setup.sh so bun is installed before dependencies.');
    } else {
      setupLines.push(...inspection.node.installCommands);
    }
    sources.push(`${inspection.node.packageManager} via ${inspection.node.packageManagerSource}`);
    values.validationCommands = inspection.node.validationScripts.map((s) => `${inspection.node.runPrefix} ${s}`);
    for (const s of inspection.node.skippedScripts) notes.push(`package.json script "${s.name}" not used for validation: ${s.reason}.`);
  }
  if (inspection.python) {
    values.pythonVersion = inspection.python.pythonVersion;
    if (inspection.python.installCommands.length) {
      setupLines.push(...inspection.python.installCommands);
      sources.push(inspection.python.installSource);
    }
    values.validationSuggestions.push('python -m pytest');
  }
  if (inspection.ecosystems.includes('go')) values.validationSuggestions.push('go vet ./...', 'go test ./...');
  if (inspection.ecosystems.includes('rust')) values.validationSuggestions.push('cargo test --locked');

  if (setupLines.length) {
    values.setupScript = DEFAULT_SETUP_SCRIPT;
    values.setupCommands = setupLines;
    values.setupSource = sources.join(', ');
  } else if (inspection.agentFiles.setup) {
    values.setupScript = DEFAULT_SETUP_SCRIPT;
  }

  const ctx = [...DEFAULT_CONTEXT];
  for (const doc of inspection.contextDocs) if (!ctx.includes(doc)) ctx.push(doc);
  values.context = ctx;
  return values;
}

/** Write every create/update/overwrite entry. Returns the list of written paths. */
export function applyPlan(root, plan) {
  const written = [];
  for (const f of plan.files) {
    if (!['create', 'update', 'overwrite'].includes(f.action)) continue;
    const full = path.join(root, f.path);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, f.content);
    if (f.mode) chmodSync(full, f.mode);
    written.push(f.path);
  }
  return written;
}
