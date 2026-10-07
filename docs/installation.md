# Installation

This guide installs agent-workflows into a repository from scratch. Budget about
20 minutes, most of it creating credentials.

## What gets installed

```text
.github/agent/config.yml            repository policy (models, budgets, trusted users, docs)
.github/agent/setup.sh              dependency install, run before Claude starts (if needed)
.github/agent/validate.sh           repository validation, run by Claude and by the workflow
.github/workflows/agent-implement.yml   wrapper → implement.yml   (Path A)
.github/workflows/agent-review.yml      wrapper → review.yml      (opt-in, Codex review, remediation)
.github/workflows/agent-human-fix.yml   wrapper → human-fix.yml   (/agent-fix)
```

Nothing else changes. Your `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` and other
documents stay yours; list the ones agents should read in `config.yml`.

## Prerequisites

- The repository is on GitHub with Actions enabled. Private repositories are fine:
  they may call this public repository's reusable workflows.
- Node.js 20 or newer and git on your machine.
- The [GitHub CLI](https://cli.github.com/), authenticated (`gh auth login`).
  Optional, but it lets the installer read the authoritative default branch and
  owner type, and lets `check` verify secrets, labels and branch protection.
- A Claude subscription or Anthropic API key, and a ChatGPT/Codex account with
  GitHub connected.

## 1. Run the installer

From the repository root:

```bash
npx --yes github:quest4ikigai/agent-workflows#v1 install . --dry-run
npx --yes github:quest4ikigai/agent-workflows#v1 install .
```

> The wrappers call `@v1`, which receives every backwards-compatible fix. To
> freeze a release instead, add `--ref v1.0.0`; see [versioning.md](versioning.md).

The installer infers:

| Setting | Source |
| --- | --- |
| GitHub repository | `origin` remote |
| Default branch / `base_branch` | GitHub (via `gh`), else `origin/HEAD` |
| `trusted_users` | the owner, for personal repositories; organizations must pass `--trusted-user` |
| Package manager and install command | `packageManager` field, then lockfiles (npm, Yarn classic/Berry, pnpm, bun) |
| `setup.node_version` | `.nvmrc`, `.node-version`, `volta.node`, `engines.node` |
| `setup.python_version` and install command | `.python-version`; `uv.lock`, `poetry.lock`, `requirements.txt` |
| Validation commands | **only** existing `package.json` scripts: typecheck, lint, format check, check, `*:check`, test, build |
| Context documents | `CLAUDE.md`, `AGENTS.md`, plus whichever of `CONTRIBUTING.md` / `ARCHITECTURE.md` exist |

It never invents validation commands. For non-Node projects it writes a
`validate.sh` with commented suggestions and a marker that `check` flags until you
fill it in.

Useful options:

| Option | Purpose |
| --- | --- |
| `--dry-run` | Print the plan; write nothing |
| `--trusted-user <login>` | Who may trigger agent work (repeatable; required for organizations) |
| `--base-branch <name>` | Target branch for automated PRs if not the default branch |
| `--node-version <ver>` | Pin the Node.js version used by the workflows |
| `--ref <ref>` | agent-workflows release the wrappers call (default `v1`, or the ref already installed) |
| `--force` | Replace wrappers that exist but are unmanaged or locally edited |
| `--offline` | Do not call GitHub |

Re-running is safe. Existing `config.yml`, `setup.sh` and `validate.sh` are never
modified; untouched wrappers are regenerated; edited or foreign wrappers are
reported as `CONFLICT` and left alone unless you pass `--force`.

## 2. Review the generated files

- **`validate.sh`** — the single definition of "acceptable". Make it match CI.
  Claude runs it before reporting success; the workflow runs it again afterwards
  and stops automation if it fails.
- **`setup.sh`** — must leave the checkout ready to build and test (install
  dependencies, generate code, …). It runs before every Claude session, while
  `actions/checkout`'s credential is still configured, so it can fetch submodules
  or private git dependencies. The credential is removed right after it.
- **`config.yml`** — check `trusted_users`, `base_branch` and `context`. See
  [configuration.md](configuration.md).

Both scripts are run with `bash`, from the repository root, on `ubuntu-latest`.
They receive no secrets. `validate.sh` runs after Claude, so it should not need
authenticated git network access.

## 3. Install the Claude GitHub App

Install <https://github.com/apps/claude> on the repository. Claude commits and
pushes with a short-lived token from this app; that is what makes CI run on
Claude's commits. (The workflows request `id-token: write` to obtain it.) Before
Claude starts, the workflows remove the `GITHUB_TOKEN` that `actions/checkout`
leaves in git config, so this token is the only one git can push with. The
workflow `GITHUB_TOKEN` and the PAT stay read-only for code
([why](security.md#why-only-claudes-github-app-token-can-push)).

## 4. Create the secrets

| Secret | Required | What it is |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes, unless `ANTHROPIC_API_KEY` is set | Claude Code OAuth token. Run `claude setup-token` locally and copy the result. |
| `ANTHROPIC_API_KEY` | alternative | An Anthropic API key, if you bill through the API instead. |
| `AGENT_GITHUB_TOKEN` | yes | Fine-grained personal access token, described below. |

Create `AGENT_GITHUB_TOKEN` at <https://github.com/settings/personal-access-tokens/new>:

- **Resource owner / account:** the user whose GitHub account is connected to
  Codex (Codex ignores review requests from other identities).
- **Repository access:** *Only select repositories* → this repository.
- **Repository permissions:**
  - Contents: **Read-only**
  - Issues: **Read and write**
  - Pull requests: **Read and write**
  - (Metadata: read-only is added automatically.)
- **Expiration:** your policy; set a reminder to rotate it.

Why a PAT is still required (and why it is so narrow): Codex rejects
`@codex review` comments from `github-actions[bot]`, and a pull request opened with
the built-in `GITHUB_TOKEN` does not trigger CI. The PAT is used for exactly those
two operations; everything else uses the built-in token. It never needs write
access to code. Do not grant it Contents write to fix a failing push: Claude never
pushes with it (see [Troubleshooting](#troubleshooting)).

Set the secrets:

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN
gh secret set AGENT_GITHUB_TOKEN
```

## 5. Enable Codex code review

In Codex settings (<https://chatgpt.com/codex/settings/code-review>), enable code
review for the repository with the same GitHub account that owns
`AGENT_GITHUB_TOKEN`. **Leave automatic reviews off** — the workflows request each
review explicitly, and automatic reviews would duplicate them.

## 6. Labels and branch protection

`agent-review` is created automatically the first time it is needed. Create
`agent-build` so trusted users can apply it from the issue sidebar:

```bash
gh label create agent-build --color 5319e7 --description "Approved issue: run automated Claude implementation"
gh label create agent-review --color 0e8a16 --description "PR opted in to Codex review and automated remediation"
```

Protect `base_branch` (require pull requests). The automation never pushes there,
but branch protection makes that a guarantee rather than a promise.

## 7. Commit to the default branch

```bash
git add .github/agent .github/workflows/agent-*.yml
git commit -m "Install agent-workflows"
git push
```

Issue and comment events always run the wrappers from the **default branch**, so
the files must be merged there before anything triggers. If `base_branch` differs
from the default branch, merge them into `base_branch` too: PR events run the
wrapper from the PR merge commit, and the Claude GitHub App refuses to issue a
token when that wrapper differs from the default branch's copy.

## 8. Verify

```bash
npx --yes github:quest4ikigai/agent-workflows#v1 check .
```

```text
Workflow installation
  ✓ .github/workflows/agent-implement.yml → quest4ikigai/agent-workflows@v1
  ✓ .github/workflows/agent-review.yml → quest4ikigai/agent-workflows@v1
  ✓ .github/workflows/agent-human-fix.yml → quest4ikigai/agent-workflows@v1
Configuration
  ✓ .github/agent/config.yml valid
  ✓ trusted users: alice
  ✓ validation script .github/agent/validate.sh
GitHub
  ✓ secret CLAUDE_CODE_OAUTH_TOKEN configured
  ✗ secret AGENT_GITHUB_TOKEN not configured
      fine-grained PAT; see docs/installation.md, then: gh secret set AGENT_GITHUB_TOKEN
  ✓ wrappers present on main
  ✓ base branch main is protected
Manual (cannot be verified automatically)
  ? Claude GitHub App is installed on this repository
  ? Codex code review is enabled for this repository; automatic reviews are off
  ? AGENT_GITHUB_TOKEN belongs to a user whose GitHub account is connected to Codex
```

`check` reads secret **names** through the GitHub API (`gh`); values are never
readable. It needs admin access to the repository for that part. GitHub offers no
API to confirm app installations from a user token, so those stay manual.

## 9. First runs

Start with the lowest-risk path:

1. **Path B smoke test.** Push a trivial branch (a typo fix), open a PR, and add
   the `agent-review` label. Expect: a status comment, an `@codex review` comment
   from the PAT owner, and the status moving to "no actionable findings" or to
   remediation.
2. **`/agent-fix`.** On that PR, comment `/agent-fix Add a sentence to the README
   explaining X.` Expect a commit from Claude and a new Codex review.
3. **Path A.** Open a small, unambiguous issue titled `[agent-build] …`. Expect a
   `claude/issue-N-…` branch (the `Implement` job's log names it) and a PR.

Watch the **Actions** tab: every run starts with a `Gate` job whose summary says
why it did or did not act.

## Updating

```bash
npx --yes github:quest4ikigai/agent-workflows#v1 install .            # regenerate wrappers for the installed ref
npx --yes github:quest4ikigai/agent-workflows#v2 install . --ref v2   # move to a new major version
```

Patch and minor releases reach consumers pinned to `@v1` automatically. See
[versioning.md](versioning.md).

## Uninstalling

Delete `.github/workflows/agent-*.yml` and `.github/agent/`, and optionally the
secrets and labels. Open PRs keep their status comments; nothing else remains.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Nothing happens when an issue is opened | Wrappers not on the default branch; title does not start with `[agent-build]`; author not in `trusted_users` (see the `Gate` job summary) |
| `Gate` fails with "config.yml was not found on the default branch" | Commit `.github/agent/config.yml` to the default branch |
| `Gate` fails with "trusted_users must be listed explicitly" | Organization-owned repository: add `trusted_users` |
| Claude reports a failed push: `remote: Write access to repository not granted.` / `403` | git pushed with the workflow `GITHUB_TOKEN` that `actions/checkout` persisted (contents: read) instead of Claude's GitHub App token. agent-workflows removes that credential before Claude starts; update the wrappers to a release that includes the **Remove persisted checkout credentials** step (`install --ref <ref>`), then retry. Do **not** grant `contents: write` to the workflow or the PAT: pushes with `GITHUB_TOKEN` succeed but trigger no CI or Codex review. If the step ran, check that the Claude GitHub App is installed on the repository. |
| **Remove persisted checkout credentials** fails: "git still sends an Authorization header" | A git config outside the repository (the runner's global or system config) sets an `http.<server>.extraheader` Authorization header. Remove it from the file named in the error; the step will not edit configuration outside the repository. |
| Claude step "finished without running Claude" | The Claude GitHub App token exchange rejected the run: the wrapper on the triggering ref differs from the default branch (e.g. a PR that edits the wrappers), or the app is not installed |
| `Missing repository secret …` | Create the secret (step 4) |
| Codex never responds | PAT owner is not connected to Codex, Codex review is not enabled for the repository, or the request is still queued; the status says "still running beyond the monitor window" |
| Status says "Invalid remediation result" (or invalid `/agent-fix` / final-fix result) | Claude's status contradicted the branch, for example `fixed` with no pushed commit. Nothing was counted and no review was requested. Read Claude's summary in the PR comment, then fix the branch yourself or with `/agent-fix <instructions>`, or accept the finding as is |
| Codex threads stay open after automated fixes | Expected. GitHub only lets tokens with Contents: write resolve review threads, and agent-workflows keeps its tokens read-only. The status comment records each verified fix with its commit, so those findings do not block readiness while the commit is in the branch; resolve the threads when you accept. Do not widen token permissions for this |
| Status says "not ready" right after a push | Expected: readiness covers only the commit Codex reviewed, and any push (including a merge from the base branch) withdraws it. Comment `/agent-review` to have Codex review the new head |
| Status still says ready after a workflow pushed to the PR | GitHub starts no workflows for pushes made with a workflow's `GITHUB_TOKEN`, so the push could not withdraw readiness. Compare the commit in "Ready for human acceptance at" with the PR head, and comment `/agent-review` |
| Fixed findings block readiness again after a rebase or force-push | The commits that fixed them are no longer in the branch, so the record proves nothing. Resolve the threads yourself if the fix survived the rewrite, or let remediation handle them again |
| Status says Claude found no change warranted | Claude returned `no_change` for the open Codex findings. Resolve the threads if you agree, or give direction with `/agent-fix <instructions>` |
| `/agent-fix` ignored silently | Commenter is not trusted; untrusted commenters get no reply by design |
| Label removed right after adding it | The labeler is not a trusted user; the explanation is posted on the PR |
| Label opt-in or remediation never starts on one PR | The PR has merge conflicts: GitHub does not run `pull_request`/`pull_request_review` workflows until they are resolved |
| A queued `/agent-fix` run shows as cancelled | GitHub keeps only one pending run per concurrency group; a newer event for the same PR (including a Codex completion signal) replaced it. Comment again once the running job finishes |
| Status stays "awaiting completion signal" | Codex has not reported a result for the requested commit. Check Codex's own summary comment on the PR; if the review failed or never started, comment `/agent-review` to request a new one. With `wait_minutes: 0` nothing polls, so the workflow cannot detect a Codex failure itself |
| Codex finished but the status did not change | The wrappers predate event-driven completion (re-run `install`), the completion was for an older commit, or unresolved Codex threads remain; the `Gate` job summary of the comment's run says which |
