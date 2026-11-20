#!/bin/bash
# Prepares the patched copy of upstream/ that dev runs, tests and packaging use; upstream/ itself is
# only read (scripts/lib/upstream-copy.mjs). Into upstream-build/run it copies the tracked upstream/
# files and applies patches/, builds the frontend into server/public, installs production
# dependencies for server and collector, generates the Prisma client and checks that dev
# dependencies are gone. run is never pruned, so it still runs on the build machine. With a
# PACKAGE_TARGET it then rebuilds upstream-build/package from run (an APFS clone on the Mac) and
# removes Prisma engines and other files there for that target (scripts/prune.mjs).
# Idempotent: every step can run again on an already built tree, and a run with nothing changed
# takes seconds.
#
# electron-builder then copies upstream-build/package/server and upstream-build/package/collector as
# plain folders into Contents/Resources (electron-builder.yml, extraResources), so the tree left
# there is what ships.
#
# PACKAGE_TARGET=mac-arm64  keep only darwin-arm64 Prisma engines and prune for darwin-arm64
#                           (set by npm run package:mac).
# PACKAGE_TARGET=linux-x64  prune for linux-x64 but keep every Prisma engine: the Linux packaging a
#                           cloud session measures and boot-checks (docs/bundle-report.md).
# PACKAGE_TARGET=win-x64    keep only the Windows Prisma engines and prune for win32-x64 (set by
#                           npm run package:win, on a Windows machine under Git Bash; never cross-built).
# Unset                     upstream-build/run only; upstream-build/package is left as it is.
#
# The frontend build is skipped when run/frontend/dist was built from the same sources: the hash of
# upstream/frontend and patches/ is stamped into dist/.askfiles-source-hash.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# What this script builds; upstream/ is only read, for the sources and their hashes.
RUN="$ROOT/upstream-build/run"
PKG="$ROOT/upstream-build/package"
START=$(date +%s)
PACKAGE_TARGET="${PACKAGE_TARGET:-}"

# upstream/collector depends on puppeteer; the product does not scrape the web, so skip Chromium.
export PUPPETEER_SKIP_DOWNLOAD=1
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
# Prisma CLI telemetry and update check (docs/upstream-analysis.md Q2).
export CHECKPOINT_DISABLE=1

# Same value as upstream's own production build (upstream/frontend/.env.example, docker/Dockerfile):
# the frontend is served by the server, so it calls its API on the same origin.
VITE_API_BASE="/api"

step() { echo "[build] == $* =="; }
fail() { echo "[build] ERROR: $*" >&2; exit 1; }

for tool in node yarn git; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not on PATH"
done
NODE_BIN="$(command -v node)"

case "$PACKAGE_TARGET" in
  "") PRUNE_TARGET="" ;;
  mac-arm64)
    # electron-builder copies resources/ollama into the bundle; without it the app has no engine.
    [ -x "$ROOT/resources/ollama/ollama" ] || fail "resources/ollama/ollama is missing; see docs/packaging.md step 2"
    PRUNE_TARGET="darwin-arm64"
    ;;
  linux-x64) PRUNE_TARGET="linux-x64" ;;
  win-x64)
    # Native modules and the Prisma engines come from this machine's yarn install and prisma generate.
    case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) ;; *) fail "PACKAGE_TARGET=win-x64 builds on Windows only" ;; esac
    [ -f "$ROOT/resources/ollama/ollama.exe" ] || fail "resources/ollama/ollama.exe is missing; see docs/windows.md, Building"
    PRUNE_TARGET="win32-x64"
    ;;
  *) fail "unknown PACKAGE_TARGET '$PACKAGE_TARGET' (expected mac-arm64, linux-x64, win-x64 or unset)" ;;
esac

step "1/7 copy upstream/ into upstream-build/run and apply patches"
node "$ROOT/scripts/lib/upstream-copy.mjs" sync "$ROOT" || fail "preparing upstream-build/run failed; see the message above"

step "2/7 build frontend (VITE_API_BASE=$VITE_API_BASE)"
# Tracked blob hashes plus any uncommitted change, so an edit invalidates the stamp without a commit.
FRONTEND_HASH=$( (echo "VITE_API_BASE=$VITE_API_BASE"; git -C "$ROOT" ls-files -s -- upstream/frontend patches;
  git -C "$ROOT" diff HEAD -- upstream/frontend patches) |
  "$NODE_BIN" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(0)).digest("hex"))')
STAMP="$RUN/frontend/dist/.askfiles-source-hash"
# The frontend's packages as this build bundled them, for THIRD-PARTY-NOTICES: a reused dist comes
# without frontend/node_modules (the mac workflow caches dist alone).
NOTICES_SNAPSHOT="$RUN/frontend/dist/.askfiles-notices.json"
if [ -f "$RUN/frontend/dist/_index.html" ] && [ -f "$NOTICES_SNAPSHOT" ] &&
  [ "$(cat "$STAMP" 2>/dev/null)" = "$FRONTEND_HASH" ]; then
  echo "[build] frontend sources unchanged since the last build, reusing frontend/dist"
else
  rm -rf "$RUN/frontend/dist"
  (cd "$RUN/frontend" && yarn install --frozen-lockfile --non-interactive --network-timeout 100000)
  # vite.config.js defines process.env as the whole build environment, which ends up in the shipped
  # JavaScript. Build with an empty environment so no token, proxy or home path leaks into the bundle.
  # Windows processes need SystemRoot to start children (esbuild); it holds no user data.
  SYSTEM_ROOT="${SYSTEMROOT:-${SystemRoot:-}}"
  (cd "$RUN/frontend" && env -i PATH=/usr/bin:/bin VITE_API_BASE="$VITE_API_BASE" \
    ${SYSTEM_ROOT:+SYSTEMROOT="$SYSTEM_ROOT"} \
    "$NODE_BIN" node_modules/vite/bin/vite.js build --logLevel warn)
  (cd "$RUN/frontend" && "$NODE_BIN" scripts/postbuild.js)
  [ -f "$RUN/frontend/dist/_index.html" ] || fail "frontend build did not produce dist/_index.html"
  "$NODE_BIN" "$ROOT/scripts/third-party-notices.mjs" --snapshot frontend || fail "could not record the frontend packages"
  printf '%s' "$FRONTEND_HASH" > "$STAMP"
fi
rm -rf "$RUN/server/public"
cp -R "$RUN/frontend/dist" "$RUN/server/public"
rm -f "$RUN/server/public/.askfiles-source-hash" "$RUN/server/public/.askfiles-notices.json"

# Everything that decides what steps 3 to 5 leave in server and collector node_modules, plus each
# tree's .yarn-integrity, which any later yarn install rewrites. Step 5 writes it into
# <pkg>/node_modules/.askfiles-build-stamp; when both stamps still match, the trees are the output
# of an earlier build with the same inputs (the CI cache restores them) and steps 3 and 4 are skipped.
# The package target is not part of it: run is never pruned.
STAMP_PATHS=(upstream/server/package.json upstream/server/yarn.lock upstream/server/prisma
  upstream/collector/package.json upstream/collector/yarn.lock patches scripts/build.sh)
tree_hash() {
  (echo "node=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
    git -C "$ROOT" ls-files -s -- "${STAMP_PATHS[@]}"
    git -C "$ROOT" diff HEAD -- "${STAMP_PATHS[@]}"
    # Missing before the first install; pipefail would otherwise end the script here without a message.
    cat "$RUN/server/node_modules/.yarn-integrity" "$RUN/collector/node_modules/.yarn-integrity" 2>/dev/null || true) |
    "$NODE_BIN" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(0)).digest("hex"))'
}
TREE_HASH=$(tree_hash)
REUSE=0
if [ "$(cat "$RUN/server/node_modules/.askfiles-build-stamp" 2>/dev/null)" = "$TREE_HASH" ] &&
  [ "$(cat "$RUN/collector/node_modules/.askfiles-build-stamp" 2>/dev/null)" = "$TREE_HASH" ]; then
  REUSE=1
fi

step "3/7 install server and collector production dependencies"
if [ "$REUSE" = 1 ]; then
  echo "[build] server and collector node_modules match their build stamp, skipping the installs"
else
  for pkg in server collector; do
    rm -f "$RUN/$pkg/node_modules/.askfiles-build-stamp"
    # --check-files puts back files missing from node_modules; yarn's integrity check alone does not
    # look at the files.
    (cd "$RUN/$pkg" && yarn install --production --frozen-lockfile --check-files --non-interactive --network-timeout 100000)
  done
fi

step "4/7 prisma generate"
# A reused client must also match the patched schema: the build stamp cannot tell a client
# generated from another schema from a good one.
if [ "$REUSE" = 1 ] && node "$ROOT/scripts/lib/prisma-client.mjs" check "$RUN/server" >/dev/null 2>&1; then
  echo "[build] reusing node_modules/.prisma/client"
else
  [ "$REUSE" = 1 ] && echo "[build] node_modules/.prisma/client does not match prisma/schema.prisma, generating again"
  (cd "$RUN/server" && "$NODE_BIN" node_modules/prisma/build/index.js generate --schema prisma/schema.prisma)
fi
[ -f "$RUN/server/node_modules/.prisma/client/index.js" ] || fail "prisma generate did not produce node_modules/.prisma/client"
node "$ROOT/scripts/lib/prisma-client.mjs" check "$RUN/server" || fail "the generated Prisma client does not match the patched schema; see the message above"

step "5/7 check dev dependencies"
# yarn install --production in step 3 removes dev-only packages; this confirms it.
for pkg in server collector; do
  node "$ROOT/scripts/lib/dev-deps.mjs" "$RUN/$pkg"
done
TREE_HASH=$(tree_hash)
for pkg in server collector; do printf '%s' "$TREE_HASH" > "$RUN/$pkg/node_modules/.askfiles-build-stamp"; done

step "6/7 upstream-build/package for the package target"
if [ -n "$PACKAGE_TARGET" ]; then
  rm -rf "$PKG"
  mkdir -p "$PKG"
  # Only server and collector ship. A clone shares the file blocks with run until pruning removes
  # files, so on the Mac this costs seconds and almost no disk.
  for pkg in server collector; do
    case "$(uname -s)" in
      Darwin) cp -c -R "$RUN/$pkg" "$PKG/$pkg" 2>/dev/null || { rm -rf "$PKG/$pkg"; cp -R "$RUN/$pkg" "$PKG/$pkg"; } ;;
      Linux) cp -R --reflink=auto "$RUN/$pkg" "$PKG/$pkg" ;;
      *) cp -R "$RUN/$pkg" "$PKG/$pkg" ;;
    esac
  done
  if [ "$PACKAGE_TARGET" = "mac-arm64" ]; then
    node "$ROOT/scripts/lib/prisma-engines.mjs" "$PKG/server/node_modules" --keep darwin-arm64
  elif [ "$PACKAGE_TARGET" = "win-x64" ]; then
    # query_engine-windows.dll.node and schema-engine-windows.exe.
    node "$ROOT/scripts/lib/prisma-engines.mjs" "$PKG/server/node_modules" --keep windows
  else
    echo "[build] PACKAGE_TARGET is neither mac-arm64 nor win-x64, keeping all engines"
    node "$ROOT/scripts/lib/prisma-engines.mjs" "$PKG/server/node_modules"
  fi
  node "$ROOT/scripts/prune.mjs" "$PKG" --target "$PRUNE_TARGET" || fail "pruning failed; see the message above"
else
  echo "[build] PACKAGE_TARGET not set, upstream-build/package left as it is"
fi

step "7/7 summary"
ELAPSED=$(( $(date +%s) - START ))
echo "[build] patches:            $(find "$ROOT/patches" -maxdepth 1 -type f \( -name '*.patch' -o -name '*.diff' \) | wc -l | tr -d ' ')"
echo "[build] server/public:      $(du -sh "$RUN/server/public" | cut -f1) in $(find "$RUN/server/public" -type f | wc -l | tr -d ' ') files"
echo "[build] run server/node_modules:    $(du -sh "$RUN/server/node_modules" | cut -f1)"
echo "[build] run collector/node_modules: $(du -sh "$RUN/collector/node_modules" | cut -f1)"
if [ -n "$PACKAGE_TARGET" ]; then
  echo "[build] package server/node_modules:    $(du -sh "$PKG/server/node_modules" | cut -f1)"
  echo "[build] package collector/node_modules: $(du -sh "$PKG/collector/node_modules" | cut -f1)"
fi
echo "[build] package target:     ${PACKAGE_TARGET:-none (upstream-build/run only)}"
echo "[build] elapsed:            ${ELAPSED}s"
echo "[build] done"
