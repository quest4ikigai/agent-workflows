# Changelog

All notable changes are documented here. Releases follow
[semantic versioning](docs/versioning.md); consumers pin `@vX` or `@vX.Y.Z`.

## Unreleased

### Verified agent results

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
- No permission, secret, wrapper or configuration changes for this part.

### Event-driven Codex completion

Codex review completion is event-driven, and the Agent review status comment
shows where the review stands. On Curious Workbench PR #17, with
`codex.wait_minutes: 0`, Codex finished a clean review but the status kept saying
"requested": a clean review submits no pull request review, so no event reached
the workflow.

- **Wrapper change:** `agent-review.yml` also listens to `issue_comment` `edited`
  and lets Codex's review-summary and clean-result comments through its
  pre-filter. Re-run `install` to regenerate it; older wrappers keep working, but
  without event-driven clean completion. An edited `/agent-review` comment is no
  longer treated as a new command.
- The status comment records the awaited review in hidden markers (`review_sha`
  with the full SHA, status, origin, request time and request comment ID) and
  shows its commit, request time and result. State written by 1.0.0 still parses.
- A new `Record Codex completion` job (Contents read, Issues and Pull requests
  write, like the other jobs that update the status comment; no Claude, no PAT)
  accepts Codex's summary edit or clean-result comment
  only from the Codex bot account, only for the recorded commit, and only while it
  is still the PR head. Unresolved Codex threads or a Codex pull request review of
  that commit keep the PR from being reported ready.
- Completion handling is shared with polling and idempotent: duplicate, stale and
  uncorrelated signals change nothing, and a recorded findings result is never
  turned clean. Codex's pull request review remains the only remediation trigger.
- Polling (`wait_minutes` above 0) still works and records results through the
  same path, so it too requires the Codex bot account and no longer reports a PR
  ready while unresolved Codex threads remain. An expired window is reported as
  the end of monitoring, not as a Codex failure. `/agent-fix` ends the wait for a
  pending review.

### Exact Codex identity

Codex was recognized by login prefix, so on a public repository anyone who
registered an account such as `chatgpt-codex-connector-x` could submit a review
on an opted-in PR and start remediation, with their review threads injected into
Claude's prompt as "authoritative" Codex findings.

- Every Codex check now requires the Codex GitHub App's bot account: REST user
  `chatgpt-codex-connector[bot]` with type `Bot`, or GraphQL actor
  `chatgpt-codex-connector` with type `Bot`. This covers the review gate, review
  counting while polling, the formal-review lookup, the inline findings handed to
  Claude, and Codex thread resolution, as well as completion signals.
- The review wrapper's `pull_request_review` pre-filter also requires a `Bot`
  reviewer. Re-run `install` to regenerate it; the runtime check applies either way.

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
