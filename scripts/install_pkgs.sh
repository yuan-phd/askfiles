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

install_dir "$ROOT" npm
install_dir "$ROOT/upstream/server" yarn
install_dir "$ROOT/upstream/collector" yarn
install_dir "$ROOT/upstream/frontend" yarn

# Prisma client for the upstream server. Downloads engines from binaries.prisma.sh, which is on the
# default allowlist. Skipped when the server has not been installed.
if [ -d "$ROOT/upstream/server/node_modules" ] && [ -f "$ROOT/upstream/server/prisma/schema.prisma" ]; then
  ( cd "$ROOT/upstream/server" && npx prisma generate ) || echo "[install_pkgs] prisma generate failed"
fi

exit 0
