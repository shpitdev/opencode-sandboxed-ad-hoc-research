# OpenCode Sandboxed Ad Hoc Research

Run OpenCode inside Daytona sandboxes for two workflows: remote OpenCode web sessions and URL-driven repository audits.

<!-- Core Stack -->
[![Daytona SDK](https://img.shields.io/badge/Daytona_SDK-0.143.0-0891B2?logo=databricks&logoColor=white)](https://www.daytona.io/docs)
[![OpenCode](https://img.shields.io/badge/OpenCode-CLI-10B981?logo=terminal&logoColor=white)](https://github.com/opencode-ai/opencode)
[![Bun](https://img.shields.io/badge/Bun-1.3.8-FBF0DF?logo=bun&logoColor=black)](https://bun.sh/docs)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/docs/)

<!-- Tooling -->
[![Biome](https://img.shields.io/badge/Biome-2.4.3-60A5FA?logo=biome&logoColor=white)](https://biomejs.dev/guides/getting-started/)

---

## What is this?

This project automates Daytona sandbox setup and OpenCode execution.

**It ships two entrypoints:**
- `bun run start` - boots OpenCode web in a fresh Daytona sandbox and prints an externally reachable preview URL.
- `bun run analyze` - runs headless OpenCode audits against one or more repository URLs and collects findings locally.

---

## Table of Contents

- [What is this?](#what-is-this)
- [Prerequisites](#prerequisites)
- [Install On New Machine](#install-on-new-machine)
- [Quick Start](#quick-start)
- [Installer & Obsidian Cataloging](#installer--obsidian-cataloging)
- [Commands](#commands)
- [Repository Audit Workflow](#repository-audit-workflow)
- [Output Layout](#output-layout)
- [Development](#development)
- [Compatibility Notes](#compatibility-notes)

---

## Prerequisites

- [Bun](https://bun.sh/) 1.3+
- `DAYTONA_API_KEY`
- `DAYTONA_API_URL` for self-hosted Daytona (example: `https://daytona.example.com/api`)
- Optional but recommended: `OPENCODE_SERVER_PASSWORD`
- Optional: `obsidian` command in `PATH` (for Obsidian note cataloging/open)

---

## Install On New Machine

Use the bootstrap installer:

```bash
curl -fsSL https://raw.githubusercontent.com/shpitdev/opencode-sandboxed-ad-hoc-research/main/scripts/install-gh-package.sh | bash
```

It will:

- ask for (or reuse) a GitHub token with `read:packages`
- configure `~/.npmrc` for GitHub Packages
- install `@shpitdev/opencode-sandboxed-ad-hoc-research` globally
- launch the guided setup flow for Daytona/model credentials

---

## Quick Start

```bash
bun install
bun run start
```

OpenCode will be available on the printed Daytona preview URL.

Stop with `Ctrl+C`.

---

## Installer & Obsidian Cataloging

Run the guided installer:

```bash
bun run setup
```

It sets up:

- `~/.config/opencode/shpit.toml` for shared preferences
- `~/.config/opencode/.env` for optional credential storage

No provider API key is required if you only use free `opencode/*` models (for example `opencode/minimax-m2.5-free`).

`analyze` automatically catalogs findings to Obsidian when enabled in `shpit.toml`.

Example config:

```toml
[obsidian]
enabled = true
command = "obsidian"
vault_path = "/absolute/path/to/vault"
notes_root = "Research/OpenCode"
catalog_mode = "date" # date | repo
open_after_catalog = false
```

Project-level `shpit.toml` or `.shpit.toml` overrides global config.
The configured command must be `obsidian` (not `obs`).

---

## Commands

| Command | Purpose |
|---|---|
| `scripts/install-gh-package.sh` | Bootstrap install from GitHub Packages on a new machine |
| `bun run setup` | Guided setup for shared config/env and Obsidian cataloging |
| `bun run start` | Launch OpenCode web in a Daytona sandbox |
| `bun run analyze -- --input example.md` | Analyze repos listed in a file |
| `bun run analyze -- <url1> <url2>` | Analyze direct repo URLs |
| `bun run build` | Compile distributable CLI files into `dist/` |
| `bun run lint` | Lint with Biome |
| `bun run format` | Format with Biome |
| `bun run check` | Run Biome checks |
| `bun run typecheck` | Run TypeScript checks |

Useful `start` flags:

```bash
bun run start -- --port 3000 --target us --sandbox-name opencode-dev
bun run start -- --keep-sandbox
bun run start -- --no-open
```

---

## Repository Audit Workflow

`src/analyze-repos.ts` supports evidence-based audits at scale.

### What it does

- Creates one Daytona sandbox per URL
- Clones each repo in its sandbox
- Runs OpenCode headlessly to generate findings
- Copies findings plus repo README back to local output
- Deletes sandboxes automatically unless `--keep-sandbox`

### Defaults and behavior

- Default model selection:
  - Standard: `zai-coding-plan/glm-4.7-flash`
  - Vision mode (`--vision`): `zai-coding-plan/glm-4.6v`
- Override with `--model`, `--variant`, `OPENCODE_ANALYZE_MODEL`, or `OPENCODE_ANALYZE_VARIANT`
- Auto-installs missing `git` and `node/npm` inside sandbox
- Forwards provider env vars (`OPENAI_*`, `ANTHROPIC_*`, `XAI_*`, `OPENROUTER_*`, `ZHIPU_*`, `MINIMAX_*`, etc.)
- Syncs local OpenCode config files from `~/.config/opencode` when present
- Auto-catalogs findings into Obsidian when enabled via `shpit.toml`

### Examples

```bash
bun run analyze -- --input example.md
bun run analyze -- https://github.com/owner/repo-one https://github.com/owner/repo-two
bun run analyze -- --out-dir findings --model zai-coding-plan/glm-4.7-flash --target us
bun run analyze -- --vision
bun run analyze -- --analyze-timeout-sec 3600 --keep-sandbox
```

If no URLs and no `--input` are provided, the script uses `example.md` when it exists.

---

## Output Layout

- `<out-dir>/index.md` - summary across all URLs
- `<out-dir>/<NN-slug>/findings.md` - final report for each repository
- `<out-dir>/<NN-slug>/README.*` - copied repository README (if found)
- `<out-dir>/<NN-slug>/opencode-run.log` - raw OpenCode run output

Example retained in this repo:

```bash
bun run analyze -- --input example.md --out-dir findings-confidence-3 --analyze-timeout-sec 3600 --keep-sandbox
```

---

## Development

```bash
bun run lint
bun run format
bun run check
bun run typecheck
```

Project config files:

- `biome.json`
- `.zed/settings.json`
- `.zed/tasks.json`
- `tsconfig.build.json`

---

## Compatibility Notes

- Works with modern Daytona control planes.
- Includes fallback support for older/self-hosted Daytona setups that expose `proxyToolboxUrl` in `/config` but not `/sandbox/:id/toolbox-proxy-url`.
- No Daytona OpenCode plugin is required for this flow.
