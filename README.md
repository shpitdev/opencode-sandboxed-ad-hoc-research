# Sandcode

Sandcode is a Bun CLI for ad hoc software research with OpenCode running inside Daytona sandboxes.

It does three things well:

- `sandcode analyze` runs evidence-based repository audits from URLs or link files.
- `sandcode start` boots an OpenCode web session in a fresh Daytona sandbox.
- `sandcode setup` launches an OpenTUI wizard for Obsidian integration and local credentials.

## Install

One-off use:

```bash
bunx sandcode --help
```

Global install:

```bash
bun add -g sandcode
```

Bootstrap script:

```bash
curl -fsSL https://raw.githubusercontent.com/shpitdev/sandcode/main/scripts/install.sh | bash
```

## Quick Start

First-run setup:

```bash
bunx sandcode setup
```

Analyze a repository:

```bash
bunx sandcode https://github.com/octocat/Hello-World
```

Analyze repositories from a link file:

```bash
bunx sandcode links.md
```

Launch a remote OpenCode web session:

```bash
bunx sandcode start
```

## Requirements

- Bun 1.3+
- `DAYTONA_API_KEY`
- `OPENCODE_API_KEY` for the built-in `opencode-go/*` model defaults
- Optional `DAYTONA_API_URL` for self-hosted Daytona
- Optional `OPENCODE_SERVER_PASSWORD` for `sandcode start`
- Optional `obsidian` CLI for desktop note opening
- Optional `ob` CLI for headless Obsidian Sync workflows

## Commands

```bash
sandcode --help
sandcode analyze --help
sandcode start --help
sandcode setup --help
```

Examples:

```bash
sandcode analyze --input example.md
sandcode analyze --out-dir findings --model opencode-go/kimi-k2.5 https://github.com/owner/repo
sandcode start --port 3000 --target us --keep-sandbox
sandcode setup --yes --vault-path ~/vaults/research --obsidian-integration headless
```

## Setup UX

`sandcode setup` uses an OpenTUI wizard by default when a TTY is available.

It writes:

- `~/.config/sandcode/sandcode.toml`
- `~/.config/sandcode/.env`

Project-level overrides are supported with:

- `sandcode.toml`
- `.sandcode.toml`

Default Obsidian notes root:

```toml
[obsidian]
notes_root = "Research/Sandcode"
```

Headless mode runs a real `ob sync-list-remote` preflight before it saves.

## Repository Audit Workflow

`sandcode analyze`:

- creates one Daytona sandbox per target
- clones the repo inside the sandbox
- installs OpenCode inside the sandbox
- runs a headless audit prompt
- writes findings locally
- optionally catalogs findings into Obsidian

Default output layout:

- `<out-dir>/index.md`
- `<out-dir>/<YYYY-MM-DD-NN-slug>/findings.md`
- `<out-dir>/<YYYY-MM-DD-NN-slug>/README.*`
- `<out-dir>/<YYYY-MM-DD-NN-slug>/opencode-run.log`

If no URLs and no `--input` are provided, `example.md` is used when it exists.

## Publishing

The package is intended for npm distribution as `sandcode`.

Release automation, dist-tags, verification, and rollback notes live in [RELEASE.md](./RELEASE.md).

## Development

```bash
bun install
bun run check
bun run typecheck
bun test
bun run build
```
