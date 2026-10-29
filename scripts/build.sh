#!/bin/bash
# Prepares upstream/ for packaging: applies patches, builds the frontend into server/public,
# installs production dependencies for server and collector, generates the Prisma client,
# prunes Prisma engines for the package target and checks that dev dependencies are gone.
# Idempotent: every step can run again on an already built tree.
#
# PACKAGE_TARGET=mac-arm64  keep only darwin-arm64 Prisma engines (set by npm run package:mac).
# Unset                     keep every engine, so the result still runs on the build machine.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM="$ROOT/upstream"
START=$(date +%s)
PACKAGE_TARGET="${PACKAGE_TARGET:-}"

# upstream/collector depends on puppeteer; the product does not scrape the web, so skip Chromium.
export PUPPETEER_SKIP_DOWNLOAD=1
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1

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
  "") ;;
  mac-arm64)
    # electron-builder copies resources/ollama into the bundle; without it the app has no engine.
    [ -x "$ROOT/resources/ollama/ollama" ] || fail "resources/ollama/ollama is missing; see docs/packaging.md step 2"
    ;;
  *) fail "unknown PACKAGE_TARGET '$PACKAGE_TARGET' (expected mac-arm64 or unset)" ;;
esac

step "1/7 apply patches"
node "$ROOT/scripts/lib/patches.mjs" apply "$ROOT" || fail "patching upstream failed; see the message above"

step "2/7 build frontend (VITE_API_BASE=$VITE_API_BASE)"
(cd "$UPSTREAM/frontend" && yarn install --frozen-lockfile --non-interactive --network-timeout 100000)
# vite.config.js defines process.env as the whole build environment, which ends up in the shipped
# JavaScript. Build with an empty environment so no token, proxy or home path leaks into the bundle.
(cd "$UPSTREAM/frontend" && env -i PATH=/usr/bin:/bin VITE_API_BASE="$VITE_API_BASE" \
  "$NODE_BIN" node_modules/vite/bin/vite.js build --logLevel warn)
(cd "$UPSTREAM/frontend" && "$NODE_BIN" scripts/postbuild.js)
[ -f "$UPSTREAM/frontend/dist/_index.html" ] || fail "frontend build did not produce dist/_index.html"
rm -rf "$UPSTREAM/server/public"
cp -R "$UPSTREAM/frontend/dist" "$UPSTREAM/server/public"

step "3/7 install server and collector production dependencies"
for pkg in server collector; do
  # scripts/install_pkgs.sh stamps full dev installs; this install changes node_modules, so drop the
  # stamp and let the next cloud session reinstall dev dependencies if it needs them.
  rm -f "$UPSTREAM/$pkg/node_modules/.install_pkgs.sha256"
  (cd "$UPSTREAM/$pkg" && yarn install --production --frozen-lockfile --non-interactive --network-timeout 100000)
done

step "4/7 prisma generate"
(cd "$UPSTREAM/server" && "$NODE_BIN" node_modules/prisma/build/index.js generate --schema prisma/schema.prisma)

step "5/7 prisma engines"
if [ "$PACKAGE_TARGET" = "mac-arm64" ]; then
  node "$ROOT/scripts/lib/prisma-engines.mjs" "$UPSTREAM/server/node_modules" --keep darwin-arm64
else
  echo "[build] PACKAGE_TARGET not set, keeping all engines"
  node "$ROOT/scripts/lib/prisma-engines.mjs" "$UPSTREAM/server/node_modules"
fi

step "6/7 prune dev dependencies"
# yarn install --production in step 3 removes dev-only packages; this confirms it.
for pkg in server collector; do
  node "$ROOT/scripts/lib/dev-deps.mjs" "$UPSTREAM/$pkg"
done

step "7/7 summary"
ELAPSED=$(( $(date +%s) - START ))
echo "[build] patches:            $(find "$ROOT/patches" -maxdepth 1 -type f \( -name '*.patch' -o -name '*.diff' \) | wc -l | tr -d ' ')"
echo "[build] server/public:      $(du -sh "$UPSTREAM/server/public" | cut -f1) in $(find "$UPSTREAM/server/public" -type f | wc -l | tr -d ' ') files"
echo "[build] server/node_modules:    $(du -sh "$UPSTREAM/server/node_modules" | cut -f1)"
echo "[build] collector/node_modules: $(du -sh "$UPSTREAM/collector/node_modules" | cut -f1)"
echo "[build] package target:     ${PACKAGE_TARGET:-none (all engines kept)}"
echo "[build] elapsed:            ${ELAPSED}s"
echo "[build] done"
