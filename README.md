# agent-workflows

Reusable GitHub Actions orchestration for AI-assisted development:

- **Claude** implements approved issues and remediates review findings,
- **Codex** reviews every change independently,
- remediation is **bounded**, with a single **Opus** escalation when the normal
  budget runs out,
- a **human** always makes the final decision. Nothing here merges or approves.

The orchestration lives once, in this repository. A consumer repository gets three
~40-line wrapper workflows, a short policy file, and its own setup/validation
scripts, installed by a dependency-free CLI.

```text
consumer repository
.github/
├── agent/
│   ├── config.yml        # policy: models, budgets, trusted users, context docs
│   ├── setup.sh          # install dependencies (optional)
│   └── validate.sh       # what "this change is acceptable" means
└── workflows/
    ├── agent-implement.yml   ─┐
    ├── agent-review.yml       ├─ thin wrappers → quest4ikigai/agent-workflows@v1
    └── agent-human-fix.yml   ─┘
```

## Lifecycle

```text
          Path A — automated                         Path B — interactive
  ┌───────────────────────────────┐        ┌────────────────────────────────────┐
  │ human + ChatGPT approve a      │        │ human + Claude Desktop/Opus build   │
  │ design contract in an issue    │        │ the change live, open a PR          │
  │ titled "[agent-build] …"       │        │                                     │
  │ (or label it agent-build)      │        │ trusted user adds the agent-review  │
  │            │                   │        │ label (or comments /agent-review)   │
  │            ▼                   │        └─────────────────┬──────────────────┘
  │ Claude (sonnet) implements on  │                          │
  │ claude/issue-N-…, workflow     │                          │
  │ validates, opens PR, labels it │                          │
  │ agent-review                   │                          │
  └────────────┬──────────────────┘                          │
               └──────────────────────┬───────────────────────┘
                                      ▼
                    Codex independent review ("@codex review")
                                      │
                 clean ◄──────────────┼──────────────► findings
                   │                                       │
                   │                 Claude (sonnet) remediates, workflow validates,
                   │                 resolves threads, requests re-review
                   │                 … up to remediation.max_passes (default 3)
                   │                                       │
                   │                        budget spent and Codex still has findings
                   │                                       ▼
                   │                 Opus: one read-only holistic audit, then one
                   │                 consolidated fix; automation ends
                   ▼                                       ▼
        "ready for human acceptance"  ──────►  human tests, decides, merges
```

At any point a trusted user can comment `/agent-fix <feedback>` on the PR to have
Claude apply specific feedback (this resets the budget and requests a new Codex
review), `/agent-review` to restart the review cycle, or remove the
`agent-review` label to stop automation on that PR.

## Quick start

Prerequisites: Node.js 20+, git, and (recommended) an authenticated
[GitHub CLI](https://cli.github.com/).

```bash
cd /path/to/your/repository
npx --yes github:quest4ikigai/agent-workflows#v1 install .
```

Until `v1` is tagged (see [Versioning](#versioning)), install from a commit or
branch instead, for example:

```bash
npx --yes github:quest4ikigai/agent-workflows#main install . --ref main
```

Or work from a clone:

```bash
git clone https://github.com/quest4ikigai/agent-workflows.git
node agent-workflows/bin/agent-workflows.mjs install /path/to/repository
```

The installer inspects the repository (GitHub remote, default branch, package
manager, Node version, existing `package.json` scripts, existing agent docs),
writes the files above, and prints what it did. Then:

1. Review `.github/agent/validate.sh` and `.github/agent/config.yml`.
2. Commit the files to the default branch.
3. Add repository secrets `CLAUDE_CODE_OAUTH_TOKEN` and `AGENT_GITHUB_TOKEN`.
4. Install the [Claude GitHub App](https://github.com/apps/claude) and enable
   Codex code review for the repository.
5. Run `agent-workflows check .` until it reports no problems.

Full instructions: [docs/installation.md](docs/installation.md).

## Commands

| Command | What it does |
| --- | --- |
| `agent-workflows install [path]` | Create missing files and regenerate untouched wrappers. Never modifies an existing `config.yml`, `setup.sh` or `validate.sh`; never touches GitHub. `--dry-run` shows the plan; `--force` replaces unmanaged or edited wrappers; `--ref` pins a release. |
| `agent-workflows check [path]` | Read-only verification: wrappers, config validity, scripts, context docs, and (through `gh`) secret names, labels, wrappers on the default branch, branch protection. Exit code 1 on problems. |

Re-running `install` is safe; it reports each file as `create`, `update`,
`unchanged`, `keep` or `CONFLICT`.

## Triggers

| Trigger | Who | Effect |
| --- | --- | --- |
| Open an issue titled `[agent-build] …` | trusted user | Path A implementation |
| Add label `agent-build` to an issue | trusted user (issue author must also be trusted) | Path A implementation; also the retry mechanism |
| Add label `agent-review` to a PR | trusted user | Path B opt-in: review cycle starts |
| Comment `/agent-review` on a PR | trusted user | Start or restart the review cycle (fresh budget) |
| Codex submits a review on an opted-in PR | Codex | Remediation or escalation |
| Comment `/agent-fix <feedback>` on a PR | trusted user | Claude applies the feedback, then Codex re-reviews |

A *trusted user* is listed in `trusted_users` **and** currently has write or
admin access. Arbitrary issues and PRs are never touched.

## Security model (summary)

- No secrets in this repository. Consumers pass exactly three secrets explicitly.
- Every job declares least-privilege permissions; `GITHUB_TOKEN` is read-only for
  contents. Claude pushes with its own short-lived GitHub App token.
- The PAT (`AGENT_GITHUB_TOKEN`) is used only to open PRs and request Codex
  reviews, and is never exposed to Claude's environment.
- Fork PRs, closed PRs, protected head branches and base/default branches are
  refused. Untrusted command authors get no response.
- Review state is only trusted from `github-actions[bot]` comments, so the
  remediation budget cannot be forged.
- Automation never merges and never approves.

Details: [docs/security.md](docs/security.md).

## Versioning

Consumers pin a release: `uses: quest4ikigai/agent-workflows/.github/workflows/review.yml@v1`.

- `vX.Y.Z` tags are immutable releases; `vX` is a moving tag pointing at the
  latest `vX.*.*` (the GitHub Actions convention).
- Each job fetches this repository's runtime at the exact commit the caller
  resolved, so workflow YAML, prompts and code always match.
- Breaking changes to wrappers, config schema, secrets or triggers require a new
  major version. `agent-workflows install --ref v2` upgrades a consumer.

See [docs/versioning.md](docs/versioning.md) for the release procedure. `v1` has
not been tagged yet: it will be cut after the workflows have been exercised in the
first consumer repositories.

## Documentation

- [docs/architecture.md](docs/architecture.md) — design, event model, state machine, GitHub constraints
- [docs/installation.md](docs/installation.md) — step-by-step installation, secrets, Codex, checks
- [docs/configuration.md](docs/configuration.md) — every configuration field and default
- [docs/security.md](docs/security.md) — permissions, secrets, trust, forks, why no auto-merge
- [docs/migration-mealie.md](docs/migration-mealie.md) — converting the original Mealie MCP workflow
- [docs/versioning.md](docs/versioning.md) — releases and upgrades
- [docs/examples/](docs/examples/) — example configurations

## Development

```bash
npm test          # node:test, no dependencies, no network
```

CI also runs [actionlint](https://github.com/rhysd/actionlint) over the reusable
workflows and over wrappers rendered to call them locally, and a self-test that
fetches the runtime at the workflow commit exactly as consumers do.
