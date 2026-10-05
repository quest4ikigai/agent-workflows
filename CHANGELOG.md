# Changelog

All notable changes are documented here. Releases follow
[semantic versioning](docs/versioning.md); consumers pin `@vX` or `@vX.Y.Z`.

## Unreleased (1.0.0)

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
