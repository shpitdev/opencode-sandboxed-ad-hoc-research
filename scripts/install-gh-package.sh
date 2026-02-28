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

is_interactive_tty() {
  [[ -t 0 && -t 1 ]]
}

is_local_package_ref() {
  local ref="$1"
  case "$ref" in
    ./* | ../* | /* | file:* | *.tgz | *.tar.gz | http://* | https://*)
      return 0
      ;;
  esac
  return 1
}

scope_list_contains() {
  local scope_list="$1"
  local scope="$2"
  local normalized=",${scope_list// /},"
  [[ "$normalized" == *",$scope,"* ]]
}

has_package_read_scope() {
  local scope_list="$1"
  scope_list_contains "$scope_list" "read:packages" ||
    scope_list_contains "$scope_list" "write:packages" ||
    scope_list_contains "$scope_list" "delete:packages"
}

get_gh_token_scopes() {
  local token="$1"
  if [[ -z "$token" ]]; then
    return 0
  fi

  GH_TOKEN="$token" gh api -i /user 2>/dev/null |
    tr -d '\r' |
    awk 'BEGIN { IGNORECASE = 1 } /^x-oauth-scopes:/ { sub(/^[^:]*:[[:space:]]*/, ""); print; exit }'
}

ensure_gh_token_has_package_scope() {
  local token="$1"
  local scopes
  scopes="$(get_gh_token_scopes "$token")"

  if has_package_read_scope "$scopes"; then
    printf '%s' "$token"
    return 0
  fi

  log "gh auth token is missing read:packages scope."
  if ! is_interactive_tty; then
    return 1
  fi

  log "Attempting gh auth scope refresh (read:packages)..."
  if ! gh auth refresh -h github.com -s read:packages; then
    return 1
  fi

  token="$(gh auth token 2>/dev/null || true)"
  if [[ -z "$token" ]]; then
    return 1
  fi

  scopes="$(get_gh_token_scopes "$token")"
  if has_package_read_scope "$scopes"; then
    log "gh auth token refreshed with package scope."
    printf '%s' "$token"
    return 0
  fi

  return 1
}

install_global_package() {
  local package_ref="$1"
  local install_output

  if install_output="$(npm install -g "$package_ref" 2>&1)"; then
    printf '%s\n' "$install_output"
    return 0
  fi

  printf '%s\n' "$install_output" >&2
  if grep -Eqi "npm\\.pkg\\.github\\.com|permission_denied|e401|e403|read:packages" <<<"$install_output"; then
    printf '[install] ERROR: GitHub Packages auth failed. Token likely missing read:packages.\n' >&2
    printf '[install] ERROR: Run: gh auth refresh -h github.com -s read:packages\n' >&2
  fi
  return 1
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

remove_npmrc_line() {
  local key_prefix="$1"
  if [[ ! -f "$NPMRC_PATH" ]]; then
    return 0
  fi

  awk -v key_prefix="$key_prefix" '
    index($0, key_prefix) == 1 { next }
    { print }
  ' "$NPMRC_PATH" >"${NPMRC_PATH}.tmp"
  mv "${NPMRC_PATH}.tmp" "$NPMRC_PATH"
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
  local requires_registry_auth="true"
  if is_local_package_ref "$PACKAGE_NAME"; then
    requires_registry_auth="false"
  fi

  local token="${NODE_AUTH_TOKEN:-}"
  local token_source="env"
  if [[ "$requires_registry_auth" == "true" ]] && [[ -z "$token" ]] && command -v gh >/dev/null 2>&1; then
    if gh auth status >/dev/null 2>&1; then
      token="$(gh auth token 2>/dev/null || true)"
      if [[ -n "$token" ]]; then
        log "Using token from gh auth session. Checking package scope..."
        token="$(ensure_gh_token_has_package_scope "$token" || true)"
        token_source="gh"
      fi
    fi
  fi

  if [[ "$requires_registry_auth" == "true" ]] && [[ -z "$token" ]]; then
    if ! is_interactive_tty; then
      fail "No usable token found for GitHub Packages. Set NODE_AUTH_TOKEN with read:packages."
    fi
    log "A GitHub token with read:packages is required to install from GitHub Packages."
    token="$(read_token_interactive)"
    token_source="manual"
  fi

  if [[ "$requires_registry_auth" == "true" ]] && [[ -z "$token" ]]; then
    fail "No GitHub token provided."
  fi

  if [[ "$requires_registry_auth" == "true" ]]; then
    local npmrc_dir
    npmrc_dir="$(dirname "$NPMRC_PATH")"
    mkdir -p "$npmrc_dir"

    upsert_npmrc_line "${PACKAGE_SCOPE}:registry=" "${PACKAGE_SCOPE}:registry=${REGISTRY_URL}"
    upsert_npmrc_line "//${registry_host}/:_authToken=" "//${registry_host}/:_authToken=${token}"
    remove_npmrc_line "always-auth="
    log "Updated ${NPMRC_PATH} for ${PACKAGE_SCOPE}."
  else
    log "Local package reference detected; skipping GitHub Packages auth setup."
  fi

  log "Installing ${PACKAGE_NAME} globally..."
  if ! install_global_package "$PACKAGE_NAME"; then
    if [[ "$requires_registry_auth" == "true" ]] &&
      [[ "$token_source" == "gh" ]] &&
      command -v gh >/dev/null 2>&1 &&
      is_interactive_tty; then
      log "Retrying after gh auth refresh (read:packages)..."
      if gh auth refresh -h github.com -s read:packages; then
        token="$(gh auth token 2>/dev/null || true)"
        if [[ -n "$token" ]]; then
          upsert_npmrc_line "//${registry_host}/:_authToken=" "//${registry_host}/:_authToken=${token}"
          if install_global_package "$PACKAGE_NAME"; then
            log "Install succeeded after token refresh."
          else
            fail "Global install failed after token refresh."
          fi
        else
          fail "Global install failed and gh did not return a token after refresh."
        fi
      else
        fail "Global install failed and gh auth refresh was unsuccessful."
      fi
    else
    fail "Global install failed."
    fi
  fi

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
