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

## Reusable versus repository-specific

What was extracted from the Mealie MCP workflow, and where each concern lives now:

| Concern | Lives in | Notes |
| --- | --- | --- |
| Event handling, job structure, permissions, concurrency | agent-workflows (reusable workflows) | identical for every consumer |
| Trust checks, fork/branch safety, opt-in rules | agent-workflows (`lib/runtime/gate.mjs`) | universal policy |
| Review state, budget, escalation, Codex request/detection, thread resolution | agent-workflows (`lib/runtime/state.mjs`, `codex.mjs`, `flows.mjs`) | generalized from `agent-review-state.sh` |
| Role prompts (implement, remediate, audit, consolidated fix, human fix) | agent-workflows (`lib/runtime/prompts.mjs`) | generic; no project facts |
| Base branch, branch prefix, trusted users, models, turn limits, budgets, timeouts, Codex wait | consumer `.github/agent/config.yml` | was hard-coded (`agent-main`, `sonnet`, `3`, owner check) |
| Runtime versions and dependency installation | consumer `config.yml` (`setup.*`) + `setup.sh` | was `setup-node@22` + `yarn install --immutable` |
| Validation commands | consumer `validate.sh` | was the yarn command list repeated in six prompts |
| Engineering conventions, architecture, review guidance | consumer `CLAUDE.md`, `AGENTS.md`, … (listed in `context`) | was partly inlined in prompts (e.g. `gen:docs`, upstream warnings) |
| PR body extras (contributor acknowledgement) | consumer `pull_request.footer` file | was inlined in the implement workflow |
| Triggers and the permission ceiling | consumer wrappers (generated, identical everywhere) | cannot live in a reusable workflow |

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
classify event, check trust,           checkout, runtimes, setup script,
check PR/branch eligibility            remove checkout's persisted credential
                                       render prompt → Claude → validate → finalize
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
| agent-review | `pull_request_review.submitted` | reviewer is a `Bot` whose login starts `chatgpt-codex-connector` | remediation / escalation |
| agent-review | `issue_comment.created` / `.edited` | Codex bot comment containing its review-summary marker or "find any major issues" | record a completed Codex review |
| agent-human-fix | `issue_comment.created` | PR comment starting `/agent-fix` | human-requested fix |

The gate then requires the exact Codex bot account (see
[security.md](security.md#trust-model)); the pre-filters only keep unrelated
events from starting a runner.

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
  → pick an unused <branch_prefix>issue-<n>-<slug>; check out base_branch and
    create that branch; run setup.sh; remove checkout's persisted credential
  → Claude (implementation.model, default sonnet) commits and pushes to that
    branch with its GitHub App token
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
<!-- review_sha=4d1c0e3164fe92828c917f20da980d75d54bd293 -->
<!-- review_status=requested -->
<!-- review_origin=human-fix -->
<!-- review_requested_at=2026-10-05T18:46:00Z -->
<!-- review_request_id=3412345678 -->
<!-- addressed_threads=PRRT_kwDOUUJ5e86pINYh@53d8ae2…,PRRT_kwDOUUJ5e86pINYp@53d8ae2… -->
### Agent review status
**Stage:** Codex review after owner-requested fix requested; awaiting completion signal.
**Codex review:** Awaiting completion signal
**Commit:** `4d1c0e3`
**Requested:** 2026-10-05 18:46 UTC (review after owner-requested fix)
**Automated remediation:** 1 / 3
**Final audit:** Not started
```

This comment is the authoritative status of the automation. Only comments
authored by `github-actions[bot]` are trusted as state, so a human cannot
accidentally (or deliberately) reset the budget by pasting the markers, and
markers are read only above the heading, so text quoted in the details cannot
add any. The `review_*` markers track the Codex review being awaited, and
`addressed_threads` lists Codex threads fixed by verified pushes, each with the
commit that fixed it (see below); state written before they existed simply has
none.

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

**Remediate:** Claude (remediation.model) addresses the current Codex findings.
When it returns a verified `fixed` (see below) and validation passes, the workflow
records those findings' threads as addressed, increments `passes` when the review
was countable, and requests a re-review (origin=remediation). `blocked`,
`no_change` and invalid results stop for a human without requesting a review.

**Addressed threads:** GitHub's `resolveReviewThread` requires Contents: write
(Pull requests: write is not enough), and no agent-workflows token has it: that
is what keeps pushes on Claude's short-lived App token. So fixed Codex threads
stay open on GitHub, and the state comment records the fix instead. Only
evidence of a fix counts, never a judgement:

| Event | Effect on a Codex finding |
| --- | --- |
| Remediation pass with a verified push and passing validation | the findings Claude was given are recorded as addressed by the pushed head (`thread@sha`) |
| A human resolves the thread on GitHub | addressed (resolved threads are never findings) |
| The read-only final audit judges it invalid, already fixed or non-actionable | nothing; it awaits a human decision |
| The final fix (given the audit's findings, not the threads), `no_change`, `blocked`, an invalid result, or a fix that fails validation | nothing |

A record counts only while the branch still contains its fix: the current head
must be that commit or descend from it, which GitHub's compare API answers.
Merging the base branch keeps the fix as an ancestor. A rebase, squash or
force-push that drops it voids the proof, so the finding is listed in prompts and
blocks readiness again; so does any commit or comparison GitHub cannot answer.
Addressed findings are left out of later prompts and do not block readiness;
any other open, non-outdated Codex thread does. The workflow still tries to
resolve exactly the threads a verified pass fixed, stopping at the first
refusal, and the status comment says how many stay open for the human.

**Budget accounting:** a pass is consumed only when a countable remediation
actually pushes a branch mutation, that is, Claude returns `fixed` and the
workflow has verified that the PR head moved. `blocked`, `no_change`, invalid
results and crashed runs consume nothing. A verified fix whose validation fails
keeps its pass (the branch did change) and pauses for a human.

**Escalate:** Opus runs a read-only holistic audit of the whole PR. The workflow
verifies the audit did not push anything. `clean` → final=complete (open Codex
findings the audit judged non-actionable are left for a human decision, and the
PR is not called ready while any remain);
`blocked` → final=blocked; `findings` → a separate Opus session applies every
valid finding in one pass. Only a verified `fixed` whose validation passes ends
final=complete; `blocked`, `no_change`, an invalid result or failed validation end
final=blocked. No further Codex review is requested — the human is the next gate.

**Resets:** `/agent-review`, the `agent-review` label and `/agent-fix` start a
fresh budget (`passes=0`, `final=not_started`).

**Stops for human input:** Claude returns `blocked` or `no_change`, Claude's
status contradicts the branch, validation fails after a pass, a Claude run fails,
the budget is exhausted with escalation disabled, or escalation ends. Each stop
updates the status comment and, where useful, posts a PR comment explaining why.

### Agent results are verified, not trusted

Every Claude session that may push ends with a structured status.
agent-workflows verifies claimed write outcomes against the remote PR head SHA
(for Path A, against the work branch) before acting on them:

| Status | Sessions | Means | Verified by |
| --- | --- | --- | --- |
| `implemented` | implementation | committed and pushed to the work branch | the work branch has commits ahead of `base_branch` |
| `fixed` | remediation, `/agent-fix`, final fix | committed, pushed to the PR branch, and the findings or feedback being addressed are resolved | the PR head moved during the session |
| `blocked` | all | a valid finding or request remains that needs a product/design decision, missing information, an unsafe guess or an unavailable capability | nothing: a commit is neither required nor expected |
| `no_change` | all | no change is warranted: already resolved, outdated, duplicate, invalid or non-actionable | the branch did not move |

A status that contradicts the branch (`fixed` or `implemented` with nothing
pushed, `no_change` with commits pushed, or a head that could not be read) is an
**invalid result**: the step fails, no pass is consumed, no review is requested,
and the status comment asks for human input. A `blocked` result that did push
commits says so.

| Session | verified `fixed` / `implemented` | `blocked` | verified `no_change` | invalid |
| --- | --- | --- | --- | --- |
| Implementation | validate, open PR, request review | comment on the issue | comment on the issue | fail; no PR |
| Remediation | validate, record the findings as addressed, count the pass, request re-review | stop for a human | stop for a human; Codex threads stay open | stop for a human |
| `/agent-fix` | validate, fresh budget, request review | stop for a human | report that nothing changed; no review | stop for a human |
| Final fix | validate, final=complete | final=blocked | final=blocked | final=blocked |

`no_change` never declares a review clean: the workflow does not resolve Codex
threads on Claude's word, so a human accepts or dismisses them.

The check compares remote heads, so a push by someone else during a session would
count as the session's push. The per-PR lock keeps agents from overlapping; avoid
pushing to a PR by hand while an agent session runs on it.

### Codex findings in the prompt

Codex puts most findings in inline review threads, and its review body can be
empty or boilerplate. So before normal remediation and `/agent-fix`, the workflow
lists the PR's review threads inside the PR lock and includes in the prompt every
**unresolved** thread opened by Codex whose code has not changed since (not
**outdated**): path, line range, severity, title, thread ID, whether it came from
the triggering review, and Codex's full comment text, fenced. Resolved threads are
left out, outdated and already addressed ones are counted but not listed, and
replies by other users are counted, not quoted. The remediation prompt states that this list is
authoritative and that an empty review body does not mean there are no findings.
Without `/agent-fix` feedback the list is the work; with feedback it is context.

The text is capped (4,000 characters per finding, 30,000 in total) because it
travels through step outputs and environment variables. If the threads cannot be
listed, the prompt says so and tells Claude to read them on the PR.

The best possible terminal message is *"ready for human acceptance"*. The
automation never approves, never merges, and never claims a human reviewed the
work.

### Codex review completion

Codex reports a finished review in more than one way, and a clean review submits
no pull request review at all:

| Signal | Arrives as | Read as |
| --- | --- | --- |
| Pull request review with inline findings | `pull_request_review.submitted` | findings; starts remediation (the only remediation trigger) |
| Its persistent summary comment edited to show the **Code Review** row completed for a commit | `issue_comment.edited` | completed (the Security Review row is ignored) |
| "Codex Review: Didn't find any major issues … Reviewed commit: `<sha>`" | `issue_comment.created` | completed, clean |
| 👍 on the `@codex review` request | (seen by polling only) | completed, clean |

Every review request is recorded with the full head SHA (`review_sha`) and
`review_status=requested`. A completion signal changes the state only when, in
the PR lock:

1. the comment's author is the Codex bot account (exact login and type `Bot`),
   whatever the text says;
2. the PR is open, from this repository, and opted in;
3. the commit the signal names (at least 7 hex characters) is a prefix of
   `review_sha`;
4. that review is still `requested`, and automation has not ended;
5. the PR head is still `review_sha`; otherwise the review is recorded as
   `outdated` and the PR is not ready;
6. Codex submitted no pull request review of that commit since the request, and
   no unresolved, non-outdated Codex threads remain apart from those fixed by a
   verified push that is still in the branch; otherwise it is recorded as
   `findings` and the PR is not ready.

Only then is it recorded as `clean`: "Codex review completed with no actionable
findings … ready for human acceptance" when CI passes. Summary parsing is
deliberately strict (table header, one Code Review row, a commit); anything else
is logged and ignored rather than guessed.

```text
requested ──clean signal, checks pass──────────────▶ clean
    │      ──signal, but findings / Codex review ──▶ findings ──▶ remediation …
    │      ──signal, but head moved ───────────────▶ outdated
    ├── Codex pull request review (remediate) ─────▶ findings
    └── /agent-fix starts ─────────────────────────▶ (no review awaited)
any ── new review request ─────────────────────────▶ requested (new SHA)
```

**Stale and duplicate signals change nothing.** A signal for another commit, for
a review already recorded as `clean`, `findings` or `outdated`, or without a
recorded request (state from older versions) is logged and ignored. Codex
usually sends two clean signals per review, so the second is a no-op, as is an
event arriving after polling has recorded the result.

**Formal reviews and summary edits.** Both orders end the same way, because every
write happens in the `agent-pr-<number>` lock:

- review first: remediation planning records `findings`, so the later summary
  edit is a duplicate and "remediation running" stays;
- summary first: the review and its threads already exist, so the state records
  `findings` ("awaiting automated remediation"), and the review event then runs
  remediation as usual.

If Codex ever marked its summary completed *before* submitting a findings review,
`clean` would show until that review's remediation run replaced it. A `/agent-fix`
ends the wait for a pending review, so a late clean signal cannot hide the fix's
outcome.

The gate repeats checks 1–4, and the pull request review part of 6, before
queuing the locked job. GitHub keeps one
pending job per concurrency group and a newly queued job replaces a pending one,
so signals that would change nothing never compete with a queued remediation.

**`codex.wait_minutes: 0` holds no runner open**, yet completion is still
recorded: the status says "awaiting completion signal" until Codex reports. If
Codex never reports, it says so indefinitely; nothing in GitHub lets the workflow
observe a Codex failure or timeout, so it never claims one. With `wait_minutes`
above 0 the requesting job also polls, and an expired window is reported as the
end of monitoring, not as a Codex failure. `/agent-review` requests a fresh
review in either case.

## Git credentials in Claude sessions

Three GitHub credentials exist in a run job, and each has one role:

| Credential | Contents | Role |
| --- | --- | --- |
| Workflow `GITHUB_TOKEN` | read | checkout, API reads, status comments, labels |
| `AGENT_GITHUB_TOKEN` (PAT) | read | opening Path A PRs, posting `@codex review` |
| Claude GitHub App token | write | Claude's commits and pushes (short-lived) |

Only the App token can push. That is deliberate: a push made with
`GITHUB_TOKEN` starts no workflows, so CI and the Codex review loop would
silently skip the agent's commits while the PR still showed the previous green
checks. With `contents: read`, a push that picks up the wrong credential fails
with a visible `403 Write access to repository not granted` instead.

`actions/checkout` persists `GITHUB_TOKEN` for the rest of the job as an
`http.https://github.com/.extraheader` Authorization header. Since checkout v6
(the workflows use v7) it writes the header to
`$RUNNER_TEMP/git-credentials-<uuid>.config` and pulls that file into
`.git/config` with `includeIf.gitdir:<workspace>/.git.path` (plus `…/worktrees/*`
and container-path variants). claude-code-action sets its App token in the
`origin` URL, but git sends the extra header on every request, so the header
wins. claude-code-action@v1 tries to remove it but only follows `include.path`
([anthropics/claude-code-action#1721](https://github.com/anthropics/claude-code-action/issues/1721),
open as of v1.0.241), so Claude's pushes were authenticated as `GITHUB_TOKEN`.

Every job that runs Claude therefore has a **Remove persisted checkout
credentials** step (`lib/runtime/credentials.mjs`), placed after `setup.sh`,
which may still need the credential, and before the first Claude step:

1. It reads the repository's `.git/config` and every file it includes, through
   `include.path` and `includeIf.*.path`, whatever the condition, and follows
   nested includes. Targets that do not exist on the runner, such as checkout's
   container paths, are skipped.
2. From each of those files it removes only the `Authorization` extra headers
   that git would send to `GITHUB_SERVER_URL`. Other headers, other hosts, the
   include entries and the files themselves stay, so checkout's post-job cleanup
   still finds what it created.
3. It then asks git which `Authorization` header it would actually use in the
   repository. If one remains, for example in a runner's global config, the step
   fails rather than letting Claude push with it.

Values are matched by git itself, so the token never appears in arguments or logs;
the step prints only how many headers it removed and from which files. It is
idempotent, and a no-op when nothing was persisted.

The same removal also keeps `GITHUB_TOKEN` away from Claude's `Bash` tool.
Otherwise a prompt-injected session could post as `github-actions[bot]`, the only
author whose review-state comments are trusted.

`persist-credentials: false` is not used instead because `setup.sh` may need the
credential, for example for submodules or private git dependencies.

**All Claude sessions run in claude-code-action's agent mode** (an explicit
`prompt`, no `track_progress`). Tag mode runs `git fetch` before it installs its
own credential, so once checkout's credential is gone that fetch fails on private
repositories (anthropics/claude-code-action#1236, #1711). Agent mode installs the
App token before any git network operation. For that reason Path A creates its
work branch in the workflow rather than letting tag mode create it.

`validate.sh` runs after Claude, so it should not need authenticated git network
access.

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
    exchange since August 2025, and were verified live in Curious Workbench before
    `v1.0.0`.
13. **`uses:` cannot be an expression.** Third-party action versions are pinned
    centrally in the reusable workflows.
14. **`pull_request` and `pull_request_review` workflows do not run while a PR has
    merge conflicts** (there is no merge commit). Label opt-in and remediation
    wait until conflicts are resolved; `/agent-review` and `/agent-fix`
    (`issue_comment`) still run. The original Mealie workflow had the same limit.
15. **`actions/checkout` persists `GITHUB_TOKEN` in a file included through
    `includeIf.gitdir`, and git prefers that header to the credential in the
    remote URL.** claude-code-action@v1 does not remove it (#1721), so the
    workflows do; see [Git credentials in Claude sessions](#git-credentials-in-claude-sessions).
    The `checkout-credentials` CI job checks the layout against the real
    `actions/checkout@v7` on every run.
16. **A clean Codex review submits no pull request review.** It edits Codex's
    summary comment and posts a result comment instead, so the review wrapper also
    listens to `issue_comment` `edited` events and the runtime correlates them;
    see [Codex review completion](#codex-review-completion). Each summary edit
    starts a short gate job.
