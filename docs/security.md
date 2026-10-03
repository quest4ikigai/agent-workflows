# Security

agent-workflows runs AI agents with write access to your repository. This document
explains what each credential can do, who can trigger what, and why the
boundaries are where they are.

## Principles

1. **Explicit opt-in only.** No issue or PR is touched unless a trusted user opts
   it in. Ordinary issues, comments, reviews and PRs are ignored.
2. **Trusted means listed *and* currently authorized.** A trigger counts only if
   the user is in `trusted_users` and the GitHub API confirms write/admin access
   right now. Any API error counts as untrusted (fail closed).
3. **Same-repository branches only.** Forks are never processed.
4. **Least privilege.** Each job declares the minimum permissions; the PAT is
   used for two operations and never reaches an agent.
5. **Humans accept.** Nothing merges, nothing approves, and no status message
   claims human acceptance.

## Credentials

| Credential | Held by | Used for | Never used for |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` (built-in) | every job | reading the repository and config, status comments, labels, resolving review threads, checking permissions | pushing code (contents is **read-only**) |
| Claude GitHub App token | the `claude-code-action` step only | Claude's commits and pushes; short-lived, scoped to this repository, revoked when the step ends | — |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | the `claude-code-action` step | model access | GitHub operations |
| `AGENT_GITHUB_TOKEN` (PAT) | dedicated runtime steps only | opening Path A PRs (so CI runs) and posting `@codex review` (Codex ignores `github-actions[bot]`); polling review status | anything in Claude's environment; pushing code |

The PAT needs only *Contents: read, Issues: read/write, Pull requests: read/write*
on a single repository. It is passed to individual steps through `env:`, never to
job-level environments and never to the Claude step; a test enforces this.

### Why the PAT is still needed

Two GitHub/Codex behaviours make the built-in token insufficient:

- Events created with `GITHUB_TOKEN` do not start workflows, so a PR opened with
  it would not run CI.
- Codex only acts on review requests from users connected to Codex.

Everything else moved off the PAT (the original Mealie workflow used it for every
GitHub call), which also means it no longer needs write access to code.

## Workflow permissions

| Job | contents | issues | pull-requests | actions | id-token |
| --- | --- | --- | --- | --- | --- |
| Gate (all workflows) | read | write | write¹ | — | — |
| Implement | read | write | write | read | write² |
| Request Codex review (Path A) | read | write | write | — | — |
| Start review cycle | read | write | write | — | — |
| Remediate / escalate | read | write | write | read | write² |
| Apply feedback (`/agent-fix`) | read | write | write | read | write² |

¹ to explain refusals and remove an untrusted `agent-review` label (implement's
gate needs only `issues: write`).
² to obtain the Claude GitHub App token via OIDC.

Wrappers set `permissions: {}` at the top and grant the ceiling only to the job
that calls the reusable workflow; called jobs can only reduce it.

## Trust model

| Trigger | Checks |
| --- | --- |
| `[agent-build]` issue opened | issue author trusted |
| `agent-build` label | labeler trusted **and** issue author trusted (the design contract must come from a trusted user, and cannot be swapped by an untrusted author later) |
| `agent-review` label | labeler trusted; otherwise the label is removed and the reason posted |
| `/agent-review`, `/agent-fix` | commenter trusted; untrusted commenters are ignored without a reply, so the bot cannot be used to amplify spam |
| Codex review | reviewer login is the Codex app, and the PR is opted in |

**Opted in** means the PR carries `agent-review` and the most recent application
of that label (from the issue events API) was by a trusted user or by
`github-actions[bot]` (the automation itself, after Path A or `/agent-fix`).
Re-labelling by an untrusted user therefore revokes the opt-in. Removing the label
stops all automation on the PR.

### Why label opt-in is safe

- Applying labels already requires triage access; the workflow additionally
  requires `trusted_users` membership and write access.
- The label is durable and visible, so every later Codex review can re-verify it
  cheaply, and anyone can see which PRs are under automation.
- The automation adds labels with `GITHUB_TOKEN`, whose events do not trigger
  workflows, so it never re-triggers itself.

## Branch model

| Situation | Behaviour |
| --- | --- |
| Automated implementation | Claude works on a fresh `<branch_prefix>issue-<n>-…` branch created from `base_branch`. Before opening a PR the workflow verifies the branch has the prefix, is not `base_branch`, and has commits ahead of it. |
| Duplicate trigger | Refused while an open PR for the same issue exists. |
| Opted-in PR | Claude may push to the PR head branch only: the workflow checks out only that branch and the prompt forbids any other push target. |
| Head branch is the base/default branch | Refused. |
| Head branch protected | Refused. |
| Fork PR | Refused before any checkout. Runs triggered from forks also receive no secrets. |
| Closed or merged PR | Refused. |

Claude's app token could technically push to any unprotected branch. **Protect
`base_branch`** so the guarantee does not rest on prompts alone; `check` reports
it.

## Review-state integrity

- The status comment is trusted only when authored by `github-actions[bot]`. A
  human pasting `<!-- passes=0 -->` cannot reset the remediation budget.
- The origin of a Codex review (which decides whether it consumes budget) is taken
  only from `@codex review` comments posted by the PAT owner with an origin
  marker; any other request counts as `manual`.
- All state transitions happen inside a per-PR concurrency lock
  (`agent-pr-<number>`), shared by opt-in, remediation, escalation and
  `/agent-fix`, so two agents never edit one branch at once.

## Fork behaviour

`pull_request` and `pull_request_review` runs triggered by forks get a read-only
token and no secrets; the gate refuses them anyway. `issue_comment` runs **do**
have secrets even when the PR is from a fork, which is why every command path
checks `head.repo == this repository` before doing anything. `pull_request_target`
is never used.

## Prompt injection

Inputs reaching Claude: the issue body (trusted author), PR descriptions and
review comments, Codex review text, and `/agent-fix` feedback (trusted author).
Mitigations:

- user text is passed through files/outputs, never interpolated into shell;
  prompts fence it, and `$GITHUB_OUTPUT` uses random heredoc delimiters;
- Claude holds no long-lived credential: the PAT is absent from its environment
  and its GitHub token is short-lived and repository-scoped;
- the read-only audit runs without edit tools, and the workflow verifies the
  branch head did not move during the audit;
- every Claude change is followed by deterministic validation, independent Codex
  review, and human acceptance.

## Why automatic merging is prohibited

Each automated stage reduces risk but none eliminates it: Claude can misread a
design, Codex can miss a defect, validation only proves what it tests. Merging is
the point at which a change affects users, so it stays a deliberate human
decision. The workflows never call merge or approve APIs (enforced by tests), the
best status they report is *"ready for human acceptance"*, and PR bodies state
that the PR must not be merged automatically. If you enable auto-merge on the
repository, a human must still approve under your branch protection rules.

## Supply chain

- Consumers pin this repository by tag or SHA; each job fetches the runtime at
  the exact commit GitHub resolved (`job.workflow_sha`), so YAML and code cannot
  drift apart.
- Third-party actions are pinned centrally: `actions/checkout@v7`,
  `actions/setup-node@v7`, `actions/setup-python@v7`,
  `anthropics/claude-code-action@v1`. The runtime has no npm dependencies.
- Pinning `claude-code-action` to a SHA instead of `@v1` is a one-line central
  change if you prefer immutability over automatic fixes.

## Reporting

Open a private security advisory on this repository for vulnerabilities.
