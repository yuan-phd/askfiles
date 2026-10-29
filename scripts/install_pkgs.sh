#!/bin/bash
# Runs at the start of every cloud session (SessionStart hook in .claude/settings.json).
# Exits immediately on a local machine. In the cloud it installs dependencies for the shell and
# for the vendored upstream packages, skipping any directory whose package.json, lock file and
# this script are unchanged since the last successful install.

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

set -u
cd "${CLAUDE_PROJECT_DIR:?CLAUDE_PROJECT_DIR is not set}" || exit 1
ROOT="$(pwd)"
SELF="$ROOT/scripts/install_pkgs.sh"

# upstream/collector depends on puppeteer, which would download Chromium on every install.
export PUPPETEER_SKIP_DOWNLOAD=1

install_dir() {
  local dir="$1"
  local tool="$2"
  [ -f "$dir/package.json" ] || return 0

  local stamp="$dir/node_modules/.install_pkgs.sha256"
  local inputs=("$SELF" "$dir/package.json")
  [ -f "$dir/package-lock.json" ] && inputs+=("$dir/package-lock.json")
  [ -f "$dir/yarn.lock" ] && inputs+=("$dir/yarn.lock")

  if sha256sum --check --status "$stamp" 2>/dev/null; then
    echo "[install_pkgs] $dir unchanged, skipping"
    return 0
  fi

  # Remove the old stamp first so a failed install runs again next time.
  rm -f "$stamp"
  echo "[install_pkgs] installing in $dir with $tool"
  if [ "$tool" = "yarn" ]; then
    ( cd "$dir" && { yarn install --frozen-lockfile || yarn install; } )
  else
    ( cd "$dir" && npm install )
  fi
  if [ $? -eq 0 ]; then
    # Re-collect inputs: a lock file may exist only after the first install.
    inputs=("$SELF" "$dir/package.json")
    [ -f "$dir/package-lock.json" ] && inputs+=("$dir/package-lock.json")
    [ -f "$dir/yarn.lock" ] && inputs+=("$dir/yarn.lock")
    mkdir -p "$dir/node_modules"
    sha256sum "${inputs[@]}" > "$stamp" || rm -f "$stamp"
    echo "[install_pkgs] done: $dir"
  else
    echo "[install_pkgs] install FAILED in $dir"
  fi
}

# @vscode/ripgrep (an upstream server dependency) asks api.github.com for its release during postinstall.
# The cloud GitHub proxy only serves API requests for repositories attached to the session, so that call
# gets a 403. The installer skips the API call when the asset is already in its cache directory, so seed
# the cache from the release download URL, which the proxy does allow.
seed_ripgrep_cache() {
  local lock="$ROOT/upstream/server/yarn.lock"
  [ -f "$lock" ] || return 0
  local pkgver
  pkgver=$(awk '/^"@vscode\/ripgrep@/{f=1} f&&/version/{gsub(/"/,"",$2);print $2;exit}' "$lock")
  [ -n "$pkgver" ] || return 0
  # VERSION constant inside @vscode/ripgrep lib/postinstall.js for 1.17.x. Re-check after an upstream upgrade.
  local rgver="v15.0.1"
  local dir="${TMPDIR:-/tmp}/vscode-ripgrep-cache-$pkgver"
  local asset="ripgrep-$rgver-x86_64-unknown-linux-musl.tar.gz"
  [ -f "$dir/$asset" ] && return 0
  mkdir -p "$dir"
  if curl -fsSL -o "$dir/$asset" "https://github.com/microsoft/ripgrep-prebuilt/releases/download/$rgver/$asset"; then
    echo "[install_pkgs] seeded ripgrep cache at $dir/$asset"
  else
    rm -f "$dir/$asset"
    echo "[install_pkgs] ripgrep cache seed failed; will fall back to the system rg"
  fi
}

# Fallback for the same problem: if the server install still fails, give @vscode/ripgrep a bin/ directory
# with the system rg so its postinstall exits early, then install again.
install_server_with_fallback() {
  local dir="$ROOT/upstream/server"
  [ -f "$dir/package.json" ] || return 0
  install_dir "$dir" yarn
  if [ ! -f "$dir/node_modules/.install_pkgs.sha256" ] && [ -d "$dir/node_modules/@vscode/ripgrep" ] && command -v rg >/dev/null 2>&1; then
    echo "[install_pkgs] retrying server install with the system rg linked into @vscode/ripgrep/bin"
    mkdir -p "$dir/node_modules/@vscode/ripgrep/bin"
    ln -sf "$(command -v rg)" "$dir/node_modules/@vscode/ripgrep/bin/rg"
    install_dir "$dir" yarn
  fi
}

install_dir "$ROOT" npm
seed_ripgrep_cache
install_server_with_fallback
install_dir "$ROOT/upstream/collector" yarn
install_dir "$ROOT/upstream/frontend" yarn

# Prisma client for the upstream server. Downloads engines from binaries.prisma.sh, which is on the
# default allowlist. Skipped when the server has not been installed.
if [ -d "$ROOT/upstream/server/node_modules" ] && [ -f "$ROOT/upstream/server/prisma/schema.prisma" ]; then
  ( cd "$ROOT/upstream/server" && npx prisma generate ) || echo "[install_pkgs] prisma generate failed"
fi

# Start Ollama for integration tests. The environment cache keeps files, not running processes.
if command -v ollama >/dev/null 2>&1 && ! curl -fs http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  (setsid nohup ollama serve > /tmp/ollama.log 2>&1 &)
  echo "[install_pkgs] started ollama serve in the background"
fi

exit 0
