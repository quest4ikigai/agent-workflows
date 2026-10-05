# Versioning and releases

## What consumers reference

Wrappers call the reusable workflows by ref:

```yaml
uses: quest4ikigai/agent-workflows/.github/workflows/review.yml@v1
```

| Ref style | Behaviour | Use when |
| --- | --- | --- |
| `@v1` (moving major tag) | Receives every backwards-compatible fix | Default |
| `@v1.2.3` (release tag) | Frozen | You want to upgrade deliberately |
| `@<40-char SHA>` | Frozen, immune to tag moves | Strictest supply-chain policy, or testing an unreleased commit |
| `@main` | Follows every change | Never in normal use; `check` warns |

Whatever the ref, every job fetches this repository's runtime at the exact commit
GitHub resolved for the workflow file (`job.workflow_sha`), so the YAML, prompts
and code a run uses always come from one commit.

## Compatibility promise within a major version

A new major version is required for any change that would break an installed
consumer:

- wrapper changes (triggers, inputs, secrets, permission ceiling),
- incompatible `config.yml` schema changes (removing or changing the meaning of a
  field; adding optional fields is fine),
- new required secrets or GitHub settings,
- changed trigger conventions (labels, commands, title prefix).

Prompt wording, bug fixes, new optional config fields and new checks are minor or
patch releases.

## Release procedure

1. Make sure CI is green on `main`.
2. Update `version` in `package.json` and add an entry to `CHANGELOG.md`.
3. Tag and push the release, then move the major tag:

   ```bash
   git tag -a v1.2.3 -m "v1.2.3"
   git push origin v1.2.3
   git tag -f v1 v1.2.3
   git push -f origin v1
   ```

4. For a new major version, release `v2.0.0` and create `v2`; leave `v1` where it
   is so existing consumers keep working.

The installer's default ref is `v<major of package.json version>`, so a CLI run
from the `v2` tag installs wrappers that call `@v2`.

## Testing before a release

Install into a consumer with an exact commit:

```bash
npx --yes github:quest4ikigai/agent-workflows#<sha> install . --ref <sha>
```

or cut a pre-release tag (`v1.3.0-rc.1`) and install with `--ref v1.3.0-rc.1`.

## Upgrading a consumer

```bash
npx --yes github:quest4ikigai/agent-workflows#v2 install . --ref v2
npx --yes github:quest4ikigai/agent-workflows#v2 check .
```

`install` rewrites only untouched wrappers; it reports anything you edited.

A consumer pinned to a commit SHA (for example while testing an unreleased
commit) moves to a release the same way:

```bash
npx --yes github:quest4ikigai/agent-workflows#v1 install . --ref v1
```

## Release history

Release notes are in [CHANGELOG.md](../CHANGELOG.md). `v1.0.0` was the first
release, tagged after Path A, Path B, Codex review and `/agent-fix` had been
exercised end to end in Curious Workbench.
