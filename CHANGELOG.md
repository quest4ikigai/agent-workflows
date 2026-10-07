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

### Codex threads fixed by remediation no longer block readiness

On Curious Workbench PR #17, a verified remediation pass fixed Codex's findings,
but every attempt to resolve the threads failed (`Resolved 0/9`), so the next clean
Codex review was not reported ready. GitHub's `resolveReviewThread` requires
Contents: write, which `GITHUB_TOKEN` and the PAT deliberately lack; thread
resolution had never worked.

- After a remediation pass with a verified push and passing validation, the
  findings Claude was given are recorded as fixed, each bound to the pushed commit
  (`fixed_threads=<thread>@<sha>`). A clean Codex review of a head containing that
  commit confirms them (`addressed_threads`). Nothing else records or confirms a
  fix: not the read-only final audit's verdict, not the final fix (which is given
  the audit's findings, not the threads), not `no_change`, not a review that
  completes with findings.
- A record counts only while the PR head is its commit or descends from it
  (GitHub's compare API). A merge from the base keeps it; a rebase or force-push
  that drops the fix voids it, and the finding counts again.
- Fixes in the branch do not block a clean review's readiness. Later prompts leave
  confirmed fixes out and list unconfirmed ones, marked with their fix commit, for
  Claude to check. At the end of escalation only confirmed fixes count, and any
  other open Codex finding is reported as awaiting a human decision instead of
  calling the PR ready.
- "Ready for human acceptance" is recorded with the head it covers (`ready_sha`)
  and withdrawn by any later push. **Wrapper change:** `agent-review.yml` also
  listens to `pull_request` `synchronize` on opted-in PRs; re-run `install`. A
  new `Record head change` job (same permissions as `Record Codex completion`)
  marks the old review outdated; readiness returns only through a Codex review of
  the new head. It compares against the PR head GitHub reports inside the lock,
  never the event's, so a late job for an older push cannot touch newer state,
  and every job that records readiness re-reads the head after writing, so a
  push that lands meanwhile is not lost to the gate's unlocked pre-filter. Pushes
  made with another workflow's `GITHUB_TOKEN` start no workflows (a GitHub rule)
  and so cannot withdraw readiness.
- Readiness is also bound to the base branch tip (`review_base_sha` with each
  Codex request, `ready_base_sha` with the claim, the tip at the start of
  escalation for the final audit and fix), read from `GET branches/{base}`
  because the PR's `base.sha` is a snapshot that does not follow the branch. A
  review is not clean, and escalation does not establish readiness, if the tip
  moved meanwhile; every locked check of a claim withdraws it for a newer tip. A
  base push sends PRs no event and is not scanned for, so it is noticed at the
  next check; "Require branches to be up to date before merging" enforces it at
  merge time.
- Only the threads a verified pass fixed are resolved on GitHub, never all open
  Codex threads; the attempt stops at the first refusal with one log line, and the
  status says how many stay open for the human. No permissions change.

### Finding disclosure in the status comment

The status comment said only how many fixed Codex threads were still open ("3
earlier findings confirmed"), not which.

- Whenever a review completes or escalation ends, the status lists the open Codex
  threads behind the decision, from the same read of GitHub: **Confirmed fixed,
  still open on GitHub** (title, `path:line`, fix commit, the head of the
  confirming clean review, link to the thread) and **Still requires action** (no
  verified fix; fixed but not yet confirmed; or fixed by a commit no longer in
  the branch).
- Confirmed records also store the confirming review's head
  (`addressed_threads=<thread>@<fix>@<confirmed-by>`); records written before
  still parse and show "head not recorded". Evidence and readiness are unchanged.
- Lists are sorted by path and line (code-point order), capped at 25 entries each,
  and Codex's text is rendered inert.

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
