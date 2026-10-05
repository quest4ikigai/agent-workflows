# Example configurations

Both were produced by running `agent-workflows install` against copies of the
real repositories' current layout; neither repository has been changed.

| Example | Stack | Notable settings |
| --- | --- | --- |
| [mealie-mcp-server](mealie-mcp-server/) | Yarn 1 (via `packageManager`), TypeScript, Node 22 | `base_branch: agent-main`; full validation suite from existing scripts; four context docs; PR footer added by hand |
| [curious-workbench](curious-workbench/) | npm, Astro, Node 22 | validation runs the project's `check` (`astro check`) and `build` scripts; `codex.wait_minutes: 0` set by hand so no runner waits on Codex |

Each directory contains the files that would live in `.github/agent/`.
