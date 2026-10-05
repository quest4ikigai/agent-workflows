# Changelog

All notable changes are documented here. Releases follow
[semantic versioning](docs/versioning.md); consumers pin `@vX` or `@vX.Y.Z`.

## Unreleased

Claude's structured results are verified against GitHub instead of trusted. In
Curious Workbench, remediation returned `fixed` for a finding it had deliberately
left for a design decision, pushed nothing, and still consumed a remediation pass.

- Remediation and the final fix gain `no_change` next to `fixed` and `blocked`
  (Path A and `/agent-fix` already had it). The prompts define each status: `fixed`
  requires a pushed commit, and a needed human decision is `blocked`, even with no
  changes.
- Every write session's status is checked against the remote branch: `fixed` or
  `implemented` without a pushed commit, or `no_change` with one, is an invalid
  result that stops for human input. This covers Path A, remediation, `/agent-fix`
  and the final fix, which can no longer declare automation complete without a
  verified push. `/agent-fix` requests a Codex review only after a verified push.
- A remediation pass is consumed only when a countable remediation actually pushes
  a branch mutation. `blocked`, `no_change` and invalid results consume nothing.
- `no_change` never declares a review clean: remediation stops for a human and
  leaves the Codex threads open, and the final fix ends blocked.
- The workflow collects the PR's unresolved, non-outdated Codex inline review
  threads and lists them in the remediation and `/agent-fix` prompts, so an empty
  review body no longer reads as "no findings".
- No permission, secret, wrapper or configuration changes.

## 1.0.0 — 2026-10-05

Initial version, extracted and generalized from the mealie-mcp-server agent
workflow.

- Reusable workflows: `implement.yml` (Path A), `review.yml` (opt-in, Codex review,
  bounded remediation, one-shot escalation), `human-fix.yml` (`/agent-fix`).
- Path B: opt any same-repository PR in with the `agent-review` label or
  `/agent-review`.
- Repository policy in `.github/agent/config.yml`; repository-defined
  `setup.sh` / `validate.sh`, with deterministic validation after every agent pass.
- `agent-workflows install` / `check` CLI with repository inspection, idempotent
  managed wrappers, dry-run and conflict detection.
- PAT narrowed to opening PRs and requesting Codex reviews (Contents read-only).
- Every job that runs Claude removes the `GITHUB_TOKEN` that `actions/checkout`
  persists before Claude starts. It covers the `includeIf.gitdir` layout of
  checkout v6+, which claude-code-action@v1 misses
  (anthropics/claude-code-action#1721). Without this, Claude's pushes used the
  read-only token and failed with `403 Write access to repository not granted`.
  `GITHUB_TOKEN` and the PAT stay Contents read-only; Claude pushes with its
  GitHub App token.
- Path A runs claude-code-action in agent mode. The workflow creates the
  `<branch_prefix>issue-<n>-<slug>` branch, because tag mode fetches before it
  installs its own credential. Path A no longer posts claude-code-action's
  progress-tracking comment on the issue.
