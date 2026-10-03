# Architecture

This document explains how agent-workflows is put together and why. Read it
before changing the reusable workflows or the runtime code.

## Goals

- One copy of the orchestration logic, owned by this repository.
- Consumer repositories contain only small wrapper workflows, a short policy
  file, and their own validation/setup scripts and agent instructions.
- Installing into a new repository is deterministic: a CLI writes the same
  files every time, and the files can be checked and updated mechanically.
- The proven behaviour of the original Mealie MCP workflow is preserved:
  Claude implements and remediates, Codex reviews independently, the remediation
  budget is bounded, Opus escalation runs once, and a human always makes the final
  decision.

## Roles

| Actor | Role | Never does |
| --- | --- | --- |
| Human (trusted user) | Writes/approves the design contract, opts work in, gives feedback, accepts and merges | — |
| Claude (Sonnet by default) | Implements approved issues; remediates review findings; applies `/agent-fix` feedback | Merge, approve, push to the base branch, broaden scope |
| Codex | Independent GitHub code review | Push code |
| Claude (Opus by default) | One holistic read-only audit + one consolidated fix after the normal budget is spent | Request further review; continue the loop |
| Automation | Moves state forward, records status, requests reviews | Merge, approve, or claim human acceptance |

## Components

```text
consumer repository                               quest4ikigai/agent-workflows
──────────────────────────────                    ─────────────────────────────────────
.github/workflows/agent-implement.yml  ──uses──▶  .github/workflows/implement.yml
.github/workflows/agent-review.yml     ──uses──▶  .github/workflows/review.yml
.github/workflows/agent-human-fix.yml  ──uses──▶  .github/workflows/human-fix.yml
                                                         │
.github/agent/config.yml   ◀── read via API (default ────┤ fetched at the exact
.github/agent/setup.sh         branch) by the gate job   │ workflow commit:
.github/agent/validate.sh  ◀── run in the checkout       ▼
CLAUDE.md / AGENTS.md / …  ◀── listed in prompts      lib/runtime/*.mjs (gate, prompts,
                                                        results, review state, GitHub client)
```

### Wrappers (consumer)

Each wrapper declares only:

1. the triggering events (reusable workflows cannot declare their own triggers),
2. a cheap `if:` pre-filter so unrelated events never start a runner,
3. the permission ceiling for the called workflow,
4. the explicit secret mapping.

Wrappers are identical across repositories apart from the pinned ref. They
contain no repository policy, so they never need hand editing. The installer
stamps each one with a checksum so it can tell an untouched wrapper (safe to
regenerate) from a locally modified one (left alone unless `--force`).

### Reusable workflows (central)

Every reusable workflow follows the same shape:

```text
gate job (no lock, ~10 s)              run job(s) (serialized per issue / PR)
───────────────────────────            ──────────────────────────────────────────
fetch tooling @ job.workflow_sha       fetch tooling @ job.workflow_sha
load + validate config (API)           re-read dynamic state inside the lock
classify event, check trust,           checkout, runtimes, setup script
check PR/branch eligibility            render prompt → Claude → validate → finalize
explain refusals where useful          request Codex review and wait (bounded)
```

The gate job carries no concurrency lock, so ineligible events finish quickly
without queuing behind real work. The run jobs share concurrency groups:

- `agent-implement-<issue>` for implementation;
- `agent-pr-<number>` for **every** job that changes a PR branch or its review
  state (initial review request, opt-in, remediation, escalation, human fix).

Decisions that depend on mutable state (remediation budget, final-audit state,
duplicate PRs) are made inside the locked job, never in the gate.

### Runtime code

Logic lives in plain Node.js modules (`lib/runtime/`) with no dependencies, run
with the Node.js that ships on GitHub-hosted runners. The YAML only wires steps
together; everything with a branch in it (eligibility, trust, state transitions,
prompt rendering, result parsing, status text) is ordinary, unit-tested code.

The called workflow does not get its own repository checked out — GitHub only
checks out the caller. Each job therefore fetches this repository at
`job.workflow_sha` (the exact commit the caller pinned via `@v1`, `@v1.2.3` or a
SHA). Workflow YAML, prompts and runtime code are always from the same commit.
This requires agent-workflows to be **public**: the consumer's `GITHUB_TOKEN`
cannot read another private repository.

## Event model

| Wrapper | Event | Pre-filter | Reusable workflow action |
| --- | --- | --- | --- |
| agent-implement | `issues.opened` | title starts with `[agent-build]` | implement (Path A) |
| agent-implement | `issues.labeled` | label `agent-build` | implement (Path A, also the retry mechanism) |
| agent-review | `pull_request.labeled` | label `agent-review` | start review cycle (Path B opt-in) |
| agent-review | `issue_comment.created` | PR comment starting `/agent-review` | start/restart review cycle |
| agent-review | `pull_request_review.submitted` | reviewer login starts `chatgpt-codex-connector` | remediation / escalation |
| agent-human-fix | `issue_comment.created` | PR comment starting `/agent-fix` | human-requested fix |

Trigger words and label names are fixed conventions rather than configuration,
because the wrapper pre-filters have to know them without reading the repository.

## The two entry paths

Both paths converge on one review/remediation loop. The loop does not know or
care how the PR was created; it only checks that the PR is **opted in**.

**A PR is opted in when it carries the `agent-review` label, and the most recent
application of that label was made by a trusted user or by the automation itself
(`github-actions[bot]`).** Removing the label opts the PR out (emergency stop).

### Path A — automated implementation

```text
trusted user opens "[agent-build] …" issue   (or adds label agent-build)
  → gate: author + actor trusted, issue open
  → lock agent-implement-<n>; refuse if an open agent PR already exists for the issue
  → Claude (implementation.model, default sonnet) in tag mode creates
    <branch_prefix>issue-<n>-<slug> from base_branch and pushes commits
  → workflow verifies commits exist on that branch, runs validate.sh
  → opens PR with AGENT_GITHUB_TOKEN (so CI runs), labels it agent-review,
    initializes review state (0 / max passes)
  → lock agent-pr-<pr>; request Codex review (origin=initial) and wait
```

### Path B — interactive implementation

```text
human + Claude Desktop/Opus implement locally, push a branch, open a PR
  → trusted user adds label agent-review, or comments /agent-review
  → gate: actor trusted, PR open, same repository, head branch not the
    base/default branch and not protected
  → lock agent-pr-<pr>; label (if needed), reset review state,
    request Codex review (origin=opt-in) and wait
  → from here on, identical to Path A
```

## Review and remediation state machine

State is a single PR comment written by `github-actions[bot]`:

```text
<!-- agent-review-state -->
<!-- passes=1 -->
<!-- final=not_started -->
### Agent review status
**Stage:** …
**Automated remediation:** 1 / 3
**Final audit:** Not started
```

Only comments authored by `github-actions[bot]` are trusted as state, so a human
cannot accidentally (or deliberately) reset the budget by pasting the markers.

Each Codex review request is a comment posted with `AGENT_GITHUB_TOKEN`:

```text
@codex review
<!-- agent-review-request origin=initial|opt-in|remediation|human-fix -->
```

The origin of the most recent request decides whether the resulting review
consumes budget. Requests not posted by the automation's PAT user count as
`manual`.

| Origin | Countable | Meaning |
| --- | --- | --- |
| `initial` | yes | First review of an automated implementation |
| `opt-in` | yes | First review after `agent-review` label or `/agent-review` |
| `remediation` | yes | Re-review after an automated remediation pass |
| `human-fix` | no | Review after an owner-requested `/agent-fix` |
| `manual` | no | Someone typed `@codex review` themselves |

When Codex submits a review on an opted-in PR the remediation job decides,
inside the PR lock:

```text
final ≠ not_started                         → finished (no-op; automation already ended)
countable and passes ≥ max_passes
    escalation.enabled                      → escalate
    otherwise                               → exhausted (final=blocked, human input)
otherwise                                   → remediate
```

**Remediate:** Claude (remediation.model) addresses actionable findings, the
workflow re-runs validation, resolves Codex threads, increments `passes` when the
review was countable, and requests a re-review (origin=remediation).

**Escalate:** Opus runs a read-only holistic audit of the whole PR. The workflow
verifies the audit did not push anything. `clean` → final=complete;
`blocked` → final=blocked; `findings` → a separate Opus session applies every
valid finding in one pass, validation runs, final=complete (or blocked). No
further Codex review is requested — the human is the next gate.

**Resets:** `/agent-review`, the `agent-review` label and `/agent-fix` start a
fresh budget (`passes=0`, `final=not_started`).

**Stops for human input:** Claude returns `blocked`, validation fails after a
pass, a Claude run fails, the budget is exhausted with escalation disabled, or
escalation ends. Each stop updates the status comment and, where useful, posts a
PR comment explaining why.

The best possible terminal message is *"ready for human acceptance"*. The
automation never approves, never merges, and never claims a human reviewed the
work.

## Validation

Validation is repository-owned code, not configuration:

- `.github/agent/setup.sh` (optional) runs once before Claude starts — install
  dependencies here.
- `.github/agent/validate.sh` (optional but recommended) is the single source of
  truth for "is this change acceptable". Claude is told to run it and make it
  pass; the workflow then runs it again deterministically as its own step so
  failures are visible in the run log and block automatic review requests.

Runtimes are selected by `setup.node_version` / `setup.python_version`; anything
else (Go, Rust, Java, …) uses the toolchains preinstalled on `ubuntu-latest` or is
installed by `setup.sh`. Nothing in the orchestration assumes Node.

## Branch trust model

| Situation | Behaviour |
| --- | --- |
| Automated implementation | Always a new `<branch_prefix>issue-<n>-…` branch from `base_branch`; the workflow refuses to open a PR from any other branch |
| Same-repository PR, opted in | Claude may push to the PR head branch only |
| Head branch is the base or default branch | Refused |
| Head branch is protected | Refused |
| Fork PR | Refused (and fork-triggered runs receive no secrets anyway) |
| PR closed or merged | Refused |

Branch protection on the base branch is still strongly recommended: Claude's
GitHub App token can technically push to any unprotected branch, and the prompt
is the only other guard. `agent-workflows check` reports whether the base branch
is protected.

## Why this design

- **Reusable workflows over composite actions.** Composite actions would leave
  job structure, permissions, concurrency and conditionals in every consumer.
  Reusable workflows keep all of that central and leave ~40-line wrappers.
- **Config file over workflow inputs.** Inputs would have to be written into each
  wrapper, making wrappers repository-specific and hand-edited. Reading
  `.github/agent/config.yml` from the default branch keeps wrappers identical and
  keeps policy on the protected branch rather than in a PR that could edit it.
- **Scripts over command lists for validation.** A script is runnable by humans,
  Claude, CI and the workflow alike, needs no quoting rules, and is versioned with
  the code it validates.
- **Labels for opt-in.** Labels are durable, visible, cheap to check on every
  review event, require triage permission to apply, and double as an off switch.
  The `/agent-review` command exists for re-requesting review after manual pushes.
- **Node runtime over shell.** The original helper was bash. Moving the logic to
  dependency-free Node keeps the same GitHub API semantics while making every
  decision unit-testable.

## GitHub Actions constraints that shaped the design

Verified against GitHub documentation in October 2026.

1. **Reusable workflows cannot have their own triggers.** Hence per-repository
   wrappers.
2. **`github` context is the caller's.** The event payload, repository and actor
   are available unchanged in the called workflow.
3. **The called workflow's own repository is not checked out.**
   `job.workflow_repository` / `job.workflow_sha` identify it; the tooling is
   fetched at that SHA. Requires a public repository (and is not available on
   GitHub Enterprise Server).
4. **Secrets must be passed explicitly.** `secrets: inherit` only works within
   one organization/enterprise, so wrappers map the three secrets explicitly.
5. **Permissions can only be reduced by the called workflow.** The wrapper sets
   the ceiling; each called job declares the minimum it needs.
6. **Workflow-level `env` in the caller is not propagated.** Policy therefore
   comes from the config file.
7. **A public reusable workflow can be called from private repositories.**
   A private one cannot be called from public repositories, and private
   repositories need explicit access settings.
8. **Which commit's workflow file runs depends on the event.** `issues` and
   `issue_comment` run the default branch's wrapper; `pull_request` and
   `pull_request_review` run the wrapper from the PR merge commit. Wrappers must
   be present on the default branch and on `base_branch`.
9. **`GITHUB_TOKEN` actions do not trigger workflows.** A PR opened with it would
   not run CI, so PRs are opened with `AGENT_GITHUB_TOKEN`. The automation adds
   labels with `GITHUB_TOKEN` precisely so that its own label does not re-trigger
   the opt-in flow.
10. **Codex ignores `@codex review` from `github-actions[bot]`.** Requests must
    come from a Codex-connected user's token (`AGENT_GITHUB_TOKEN`).
11. **Concurrency groups are repository-global and must not be reused between a
    caller and its called workflow.** Groups are defined only inside the called
    workflows.
12. **Claude GitHub App token exchange validates the caller workflow file against
    the default branch.** A PR that edits a wrapper cannot run agent jobs until the
    edit is merged. Cross-repository reusable workflows have been supported by the
    exchange since August 2025 but must be verified live in the first consumer.
13. **`uses:` cannot be an expression.** Third-party action versions are pinned
    centrally in the reusable workflows.
