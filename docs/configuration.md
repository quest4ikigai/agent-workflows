# Configuration

Repository policy lives in **`.github/agent/config.yml`**. The wrappers contain no
policy at all, so this file is the only place to change behaviour.

- The reusable workflows always read the file from the repository's **default
  branch** (through the API), never from a pull request. A PR therefore cannot
  change who is trusted or which models run on itself.
- Validate it locally with `agent-workflows check .` — the workflows use the same
  parser and schema, so a config that passes locally behaves identically in CI.
- Unknown keys are errors (with "did you mean" suggestions). Every problem is
  reported at once. A malformed config fails the `Gate` job with the list of
  errors.

## Minimal example

```yaml
version: 1
trusted_users:
  - alice
```

Everything else has a default. The installer writes every field explicitly so
the file documents itself.

## Reference

### Top level

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | integer | `1` | Schema version. Only `1` exists. |
| `base_branch` | branch name | repository default branch | Branch automated implementation PRs target and branch from. Claude never pushes here. |
| `branch_prefix` | string | `claude/` | Prefix for branches created by automated implementation: `<prefix>issue-<n>-<slug>`. |
| `trusted_users` | list of logins | repository owner (personal repositories only) | Users allowed to trigger agent work. A user must **also** hold write or admin access at the moment of the trigger. Required for organization-owned repositories. An empty list disables all triggers. |
| `context` | list of paths | `[CLAUDE.md, AGENTS.md]` | Project documents agents are told to read. Missing files are skipped silently in prompts and reported as warnings by `check`. |

### `implementation` — Path A

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | model | `sonnet` | Claude model for implementing an approved issue. |
| `max_turns` | 1–500 | `40` | Claude turn limit. |
| `timeout_minutes` | 5–360 | `75` | Job timeout (setup + Claude + validation + PR creation). |

### `remediation` — fixing Codex findings

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | model | `sonnet` | Claude model for normal remediation passes. Set to `opus` to use Opus for every pass. |
| `max_turns` | 1–500 | `30` | Claude turn limit per pass. |
| `max_passes` | 0–10 | `3` | Automated remediation passes before escalation. `0` escalates on the first findings. Passes after `/agent-fix` or a manual `@codex review` do not count. |
| `timeout_minutes` | 5–360 | `90` | Job timeout. Covers remediation **and** a possible escalation, plus waiting for the Codex re-review. |

### `escalation` — one holistic audit

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | When `false`, an exhausted budget stops for human input instead of escalating. |
| `model` | model | `opus` | Model for the read-only audit and the consolidated fix. |
| `audit_max_turns` | 1–500 | `40` | Turn limit for the audit. |
| `fix_max_turns` | 1–500 | `45` | Turn limit for the consolidated fix. |

### `human_fix` — `/agent-fix`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | model | `sonnet` | Model that applies the human's feedback. |
| `max_turns` | 1–500 | `30` | Turn limit. |
| `timeout_minutes` | 5–360 | `75` | Job timeout, including the Codex review wait. |

### `codex`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `wait_minutes` | 0–60 | `15` | How long a job keeps polling for a Codex review after requesting one, to keep the status comment current. Reviews that arrive later still trigger remediation. `0` requests and exits immediately (cheapest). |

### `setup` — environment before Claude starts

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `node_version` | version string | none (runner default) | Installs Node.js with `actions/setup-node` (`"22"`, `"22.12.0"`, `"lts/*"`). |
| `python_version` | version string | none (runner default) | Installs Python with `actions/setup-python` (`"3.12"`). Quote it: write `"3.10"`, not `3.10`. |
| `script` | path or `null` | `.github/agent/setup.sh` | Bash script run from the repository root before every Claude session, e.g. dependency installation. `null` disables it. |

Other toolchains (Go, Rust, Java, …) are preinstalled on `ubuntu-latest`, or can be
installed by `setup.sh`.

### `validation`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `script` | path or `null` | `.github/agent/validate.sh` | The repository's definition of an acceptable change. Claude is instructed to run it and make it pass; the workflow re-runs it after every implementation/remediation/fix and stops automation (without requesting review) if it fails. `null` disables deterministic validation and tells Claude to follow the project docs. |

### `pull_request`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `footer` | path or `null` | `null` | Markdown appended to the body of PRs opened by Path A (for example a contributor acknowledgement checklist). |

### Paths and model names

- Paths are repository-relative, use `/`, and may not contain `..`, spaces or a
  leading `/`.
- When a path field is set explicitly, the file must exist; `check` reports
  missing files as errors and the workflow fails clearly.
- Model names are passed to Claude Code as `--model`: aliases such as `sonnet`,
  `opus`, `haiku`, or full model IDs. Only `[A-Za-z0-9._:[]-]` is accepted, so a
  config value can never inject other CLI flags.

## Fixed conventions (not configurable)

The wrapper `if:` pre-filters run before any configuration can be read, so these
are fixed:

| Convention | Value |
| --- | --- |
| Issue title prefix | `[agent-build]` |
| Issue label | `agent-build` |
| PR opt-in label | `agent-review` |
| Commands | `/agent-review`, `/agent-fix` |
| Codex reviewer login | starts with `chatgpt-codex-connector` |
| Status comment marker | `<!-- agent-review-state -->` |

## YAML subset

`config.yml` is parsed by a deliberately small, strict YAML subset parser:

- supported: mappings, lists of plain values (block `- x` or flow `[a, b]`),
  plain/single-quoted/double-quoted strings, `true`/`false`, `null`/`~`,
  integers, comments;
- rejected with an error: tabs, anchors/aliases, multi-line strings (`|`, `>`),
  `{…}` mappings, lists of mappings, duplicate keys, multiple documents;
- numbers with a decimal point are read as strings, so `3.10` never becomes `3.1`.

## Derived values

The `Gate` job adds two values the workflow YAML needs (GitHub expressions cannot
do arithmetic); they are not settable:

- `default_branch` — the repository default branch,
- `codex.job_timeout_minutes` — `codex.wait_minutes + 10`, the timeout of jobs
  that only request and wait for a review.

## Examples

Generated by `agent-workflows install`:

- [Yarn/TypeScript (Mealie MCP)](examples/mealie-mcp-server/config.yml)
- [npm/Astro (Curious Workbench)](examples/curious-workbench/config.yml)

Cost-conscious setup (no waiting runners, no escalation):

```yaml
version: 1
trusted_users: [alice]
codex:
  wait_minutes: 0
escalation:
  enabled: false
```

Opus everywhere:

```yaml
version: 1
trusted_users: [alice]
implementation:
  model: opus
remediation:
  model: opus
human_fix:
  model: opus
```
