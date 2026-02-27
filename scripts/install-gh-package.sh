#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="${OPENCODE_PACKAGE:-@shpitdev/opencode-sandboxed-ad-hoc-research}"
PACKAGE_SCOPE="${OPENCODE_SCOPE:-@shpitdev}"
REGISTRY_URL="${OPENCODE_REGISTRY:-https://npm.pkg.github.com}"
SETUP_BIN="${OPENCODE_SETUP_BIN:-opencode-sandboxed-research-setup}"
NPMRC_PATH="${HOME}/.npmrc"

log() {
  printf '[install] %s\n' "$*"
}

fail() {
  printf '[install] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command not found: $1"
  fi
}

upsert_npmrc_line() {
  local key_prefix="$1"
  local line_value="$2"

  touch "$NPMRC_PATH"

  if grep -Fq "$key_prefix" "$NPMRC_PATH"; then
    awk -v key_prefix="$key_prefix" -v line_value="$line_value" '
      index($0, key_prefix) == 1 {
        print line_value
        next
      }
      { print }
    ' "$NPMRC_PATH" >"${NPMRC_PATH}.tmp"
    mv "${NPMRC_PATH}.tmp" "$NPMRC_PATH"
  else
    printf '%s\n' "$line_value" >>"$NPMRC_PATH"
  fi
}

read_token_interactive() {
  local token=""
  printf 'GitHub token (read:packages): '
  read -r -s token
  printf '\n' >&2
  printf '%s' "$token"
}

main() {
  require_command npm

  local registry_host="${REGISTRY_URL#https://}"
  registry_host="${registry_host#http://}"
  registry_host="${registry_host%%/}"

  local token="${NODE_AUTH_TOKEN:-}"
  if [[ -z "$token" ]] && command -v gh >/dev/null 2>&1; then
    if gh auth status >/dev/null 2>&1; then
      token="$(gh auth token 2>/dev/null || true)"
      if [[ -n "$token" ]]; then
        log "Using token from gh auth session."
      fi
    fi
  fi

  if [[ -z "$token" ]]; then
    log "A GitHub token with read:packages is required to install from GitHub Packages."
    token="$(read_token_interactive)"
  fi

  if [[ -z "$token" ]]; then
    fail "No GitHub token provided."
  fi

  local npmrc_dir
  npmrc_dir="$(dirname "$NPMRC_PATH")"
  mkdir -p "$npmrc_dir"

  upsert_npmrc_line "${PACKAGE_SCOPE}:registry=" "${PACKAGE_SCOPE}:registry=${REGISTRY_URL}"
  upsert_npmrc_line "//${registry_host}/:_authToken=" "//${registry_host}/:_authToken=${token}"
  upsert_npmrc_line "always-auth=" "always-auth=true"
  log "Updated ${NPMRC_PATH} for ${PACKAGE_SCOPE}."

  log "Installing ${PACKAGE_NAME} globally..."
  npm install -g "$PACKAGE_NAME"

  if ! command -v "$SETUP_BIN" >/dev/null 2>&1; then
    fail "Install completed but ${SETUP_BIN} is not in PATH."
  fi

  log "Installed successfully."

  local run_setup=""
  printf 'Run guided setup now? [Y/n]: '
  read -r run_setup
  run_setup="${run_setup:-Y}"
  if [[ "$run_setup" =~ ^([yY]|[yY][eE][sS])$ ]]; then
    "$SETUP_BIN"
  else
    log "You can run setup later with: ${SETUP_BIN}"
  fi
}

main "$@"
