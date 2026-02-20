# Remote OpenCode on Daytona

Launches an OpenCode web session inside a remote Daytona sandbox and prints a Daytona preview URL for the UI.
By default it auto-opens the URL:
- macOS: tries OpenCode desktop app first, then browser.
- Linux/Windows: opens browser.

## Prerequisites

- Bun 1.3+
- `DAYTONA_API_KEY` exported
- `DAYTONA_API_URL` exported for self-hosted Daytona (example: `https://fucksap.com/api`)
- Optional but recommended: `OPENCODE_SERVER_PASSWORD` exported (protects OpenCode web UI)

## Install

```bash
bun install
```

## Run

```bash
bun run start
```

OpenCode will be available on the printed preview URL.

Stop with `Ctrl+C`.

Compatibility:
- Works with newer Daytona control planes.
- Includes a fallback for older/self-hosted Daytona versions that expose `proxyToolboxUrl` in `/config` but do not expose `/sandbox/:id/toolbox-proxy-url`.

## Useful options

```bash
bun run start -- --port 3000 --target us --sandbox-name opencode-dev
bun run start -- --keep-sandbox
bun run start -- --no-open
```

## Repository audit helper

`src/analyze-repos.ts` is a URL-driven helper for remote audits:
- one Daytona sandbox per URL
- clone repo in sandbox
- run OpenCode headlessly for an evidence-based audit
- copy generated findings markdown + repo README to local output
- delete sandbox automatically (unless `--keep-sandbox`)
- defaults to `--model opencode/gpt-5-nano` for out-of-the-box runs
- auto-installs `git` and `node/npm` inside sandbox when missing
- forwards common model-provider env vars (`OPENAI_*`, `ANTHROPIC_*`, `XAI_*`, etc.) into sandbox runs
- syncs local OpenCode config files from `~/.config/opencode` when available

Run from URL list (for example `example.md`):

```bash
bun run analyze -- --input example.md
```

Run with direct URLs:

```bash
bun run analyze -- https://github.com/owner/repo-one https://github.com/owner/repo-two
```

If no URLs and no `--input` are provided, it falls back to `example.md` when that file exists.

Useful flags:

```bash
bun run analyze -- --out-dir findings --model openai/gpt-5 --target us
bun run analyze -- --analyze-timeout-sec 3600 --keep-sandbox
```

Notes:
- first OpenCode run in a fresh sandbox can spend time on one-time DB migration, so short timeouts may fail.
- use a larger `--analyze-timeout-sec` (for example `1800` or `3600`) for deeper audits.

Output layout:
- `<out-dir>/index.md`: run summary across all URLs
- `<out-dir>/<NN-slug>/findings.md`: final audit report for each repo
- `<out-dir>/<NN-slug>/README.*`: copied README from analyzed repo (if found)
- `<out-dir>/<NN-slug>/opencode-run.log`: raw OpenCode run output

Successful example retained in this repo:
- output folder: `findings-confidence-3`
- command used:
```bash
bun run analyze -- --input example.md --out-dir findings-confidence-3 --analyze-timeout-sec 3600 --keep-sandbox
```

## Dev tooling

```bash
bun run lint
bun run format
bun run check
bun run typecheck
```

- Biome config: `biome.json`
- Zed project settings: `.zed/settings.json`
- Zed tasks: `.zed/tasks.json`

## Do I need a Daytona plugin for OpenCode?

No, not for this flow.
- This script runs OpenCode directly inside the sandbox (`opencode web`) and writes an OpenCode config with Daytona-aware prompt defaults.
- Daytona plugin/integration packages are optional ecosystem tooling, not required for running OpenCode web in a Daytona sandbox.
