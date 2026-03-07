#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[sandcode-install] %s\n' "$*"
}

fail() {
  printf '[sandcode-install] ERROR: %s\n' "$*" >&2
  exit 1
}

if ! command -v bun >/dev/null 2>&1; then
  fail "Bun is required. Install Bun first, then re-run this script."
fi

log "Installing sandcode globally with Bun..."
bun add -g sandcode

SANDCODE_BIN="$(command -v sandcode || true)"
if [ -z "$SANDCODE_BIN" ] && [ -x "$HOME/.bun/bin/sandcode" ]; then
  SANDCODE_BIN="$HOME/.bun/bin/sandcode"
fi

if [ -z "$SANDCODE_BIN" ]; then
  fail "Install completed but sandcode is not in PATH."
fi

log "Launching setup..."
"$SANDCODE_BIN" setup
