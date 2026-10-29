#!/bin/bash
# Prepares upstream/ for packaging: applies patches, builds the frontend into server/public,
# installs production dependencies for server and collector, generates the Prisma client,
# prunes Prisma engines and other files for the package target (scripts/prune.mjs) and checks that
# dev dependencies are gone. Idempotent: every step can run again on an already built tree.
#
# electron-builder then copies upstream/server and upstream/collector as plain folders into
# Contents/Resources (electron-builder.yml, extraResources), so the tree left here is what ships.
#
# PACKAGE_TARGET=mac-arm64  keep only darwin-arm64 Prisma engines and prune for darwin-arm64
#                           (set by npm run package:mac).
# PACKAGE_TARGET=linux-x64  prune for linux-x64 but keep every Prisma engine: the Linux packaging a
#                           cloud session measures and boot-checks (docs/bundle-report.md).
# Unset                     no pruning, so the result still runs on the build machine.
#
# The frontend build is skipped when upstream/frontend/dist was built from the same sources: the
# hash of upstream/frontend and patches/ is stamped into dist/.askfiles-source-hash.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM="$ROOT/upstream"
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
  *) fail "unknown PACKAGE_TARGET '$PACKAGE_TARGET' (expected mac-arm64, linux-x64 or unset)" ;;
esac

step "1/8 apply patches"
node "$ROOT/scripts/lib/patches.mjs" apply "$ROOT" || fail "patching upstream failed; see the message above"

step "2/8 build frontend (VITE_API_BASE=$VITE_API_BASE)"
# Tracked blob hashes plus any uncommitted change, so an edit invalidates the stamp without a commit.
FRONTEND_HASH=$( (echo "VITE_API_BASE=$VITE_API_BASE"; git -C "$ROOT" ls-files -s -- upstream/frontend patches;
  git -C "$ROOT" diff HEAD -- upstream/frontend patches) |
  "$NODE_BIN" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(0)).digest("hex"))')
STAMP="$UPSTREAM/frontend/dist/.askfiles-source-hash"
if [ -f "$UPSTREAM/frontend/dist/_index.html" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$FRONTEND_HASH" ]; then
  echo "[build] frontend sources unchanged since the last build, reusing frontend/dist"
else
  rm -rf "$UPSTREAM/frontend/dist"
  (cd "$UPSTREAM/frontend" && yarn install --frozen-lockfile --non-interactive --network-timeout 100000)
  # vite.config.js defines process.env as the whole build environment, which ends up in the shipped
  # JavaScript. Build with an empty environment so no token, proxy or home path leaks into the bundle.
  (cd "$UPSTREAM/frontend" && env -i PATH=/usr/bin:/bin VITE_API_BASE="$VITE_API_BASE" \
    "$NODE_BIN" node_modules/vite/bin/vite.js build --logLevel warn)
  (cd "$UPSTREAM/frontend" && "$NODE_BIN" scripts/postbuild.js)
  [ -f "$UPSTREAM/frontend/dist/_index.html" ] || fail "frontend build did not produce dist/_index.html"
  printf '%s' "$FRONTEND_HASH" > "$STAMP"
fi
rm -rf "$UPSTREAM/server/public"
cp -R "$UPSTREAM/frontend/dist" "$UPSTREAM/server/public"
rm -f "$UPSTREAM/server/public/.askfiles-source-hash"

# Everything that decides what steps 3 to 7 leave in server and collector node_modules, plus each
# tree's .yarn-integrity, which any later yarn install rewrites. Step 7 writes it into
# <pkg>/node_modules/.askfiles-build-stamp; when both stamps still match, the trees are the output
# of an earlier build with the same inputs (the CI cache restores them) and steps 3 to 5 are skipped.
STAMP_PATHS=(upstream/server/package.json upstream/server/yarn.lock upstream/server/prisma
  upstream/collector/package.json upstream/collector/yarn.lock patches scripts/build.sh scripts/prune.mjs
  scripts/lib/prisma-engines.mjs)
tree_hash() {
  (echo "PACKAGE_TARGET=$PACKAGE_TARGET node=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
    git -C "$ROOT" ls-files -s -- "${STAMP_PATHS[@]}"
    git -C "$ROOT" diff HEAD -- "${STAMP_PATHS[@]}"
    cat "$UPSTREAM/server/node_modules/.yarn-integrity" "$UPSTREAM/collector/node_modules/.yarn-integrity" 2>/dev/null) |
    "$NODE_BIN" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(0)).digest("hex"))'
}
TREE_HASH=$(tree_hash)
REUSE=0
if [ "$(cat "$UPSTREAM/server/node_modules/.askfiles-build-stamp" 2>/dev/null)" = "$TREE_HASH" ] &&
  [ "$(cat "$UPSTREAM/collector/node_modules/.askfiles-build-stamp" 2>/dev/null)" = "$TREE_HASH" ]; then
  REUSE=1
fi

step "3/8 install server and collector production dependencies"
if [ "$REUSE" = 1 ]; then
  echo "[build] server and collector node_modules match their build stamp, skipping steps 3 to 5"
else
  for pkg in server collector; do
    # scripts/install_pkgs.sh stamps full dev installs; this install changes node_modules, so drop the
    # stamp and let the next cloud session reinstall dev dependencies if it needs them.
    rm -f "$UPSTREAM/$pkg/node_modules/.install_pkgs.sha256" "$UPSTREAM/$pkg/node_modules/.askfiles-build-stamp"
    # --check-files puts back what an earlier step 7 pruned; yarn's integrity check alone does not
    # look at the files.
    (cd "$UPSTREAM/$pkg" && yarn install --production --frozen-lockfile --check-files --non-interactive --network-timeout 100000)
  done
fi

step "4/8 prisma generate"
if [ "$REUSE" = 1 ]; then
  echo "[build] reusing node_modules/.prisma/client"
else
  (cd "$UPSTREAM/server" && "$NODE_BIN" node_modules/prisma/build/index.js generate --schema prisma/schema.prisma)
fi
[ -f "$UPSTREAM/server/node_modules/.prisma/client/index.js" ] || fail "prisma generate did not produce node_modules/.prisma/client"

step "5/8 prisma engines"
if [ "$PACKAGE_TARGET" = "mac-arm64" ]; then
  node "$ROOT/scripts/lib/prisma-engines.mjs" "$UPSTREAM/server/node_modules" --keep darwin-arm64
else
  echo "[build] PACKAGE_TARGET is not mac-arm64, keeping all engines"
  node "$ROOT/scripts/lib/prisma-engines.mjs" "$UPSTREAM/server/node_modules"
fi

step "6/8 check dev dependencies"
# yarn install --production in step 3 removes dev-only packages; this confirms it.
for pkg in server collector; do
  node "$ROOT/scripts/lib/dev-deps.mjs" "$UPSTREAM/$pkg"
done

step "7/8 prune for the package target"
if [ -n "$PRUNE_TARGET" ]; then
  # Safe to run again on its own output; a reused tree prunes nothing.
  node "$ROOT/scripts/prune.mjs" "$UPSTREAM" --target "$PRUNE_TARGET" || fail "pruning failed; see the message above"
else
  echo "[build] PACKAGE_TARGET not set, nothing pruned"
fi
TREE_HASH=$(tree_hash)
for pkg in server collector; do printf '%s' "$TREE_HASH" > "$UPSTREAM/$pkg/node_modules/.askfiles-build-stamp"; done

step "8/8 summary"
ELAPSED=$(( $(date +%s) - START ))
echo "[build] patches:            $(find "$ROOT/patches" -maxdepth 1 -type f \( -name '*.patch' -o -name '*.diff' \) | wc -l | tr -d ' ')"
echo "[build] server/public:      $(du -sh "$UPSTREAM/server/public" | cut -f1) in $(find "$UPSTREAM/server/public" -type f | wc -l | tr -d ' ') files"
echo "[build] server/node_modules:    $(du -sh "$UPSTREAM/server/node_modules" | cut -f1)"
echo "[build] collector/node_modules: $(du -sh "$UPSTREAM/collector/node_modules" | cut -f1)"
echo "[build] package target:     ${PACKAGE_TARGET:-none (nothing pruned)}"
echo "[build] elapsed:            ${ELAPSED}s"
echo "[build] done"
