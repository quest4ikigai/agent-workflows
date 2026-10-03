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
