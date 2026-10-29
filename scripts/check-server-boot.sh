#!/bin/bash
# Boots the built upstream server under Electron's Node (ELECTRON_RUN_AS_NODE) with the canvas
# module made unloadable, and waits for 200 from /api/ping. Proves that the server does not need
# canvas to start (it only uses it for chat export thumbnails and Telegram charts).
#
# Usage: scripts/check-server-boot.sh [electron-binary]
#   default binary: node_modules/electron/dist/electron (Linux) or the one inside Electron.app (macOS)
#   on the Mac after packaging: scripts/check-server-boot.sh /Applications/AskFiles.app/Contents/MacOS/AskFiles
#
# Runs against upstream/server in this repository, not inside the app bundle: until Session C's
# patches land, the server writes its SQLite DB to upstream/server/storage and may rewrite
# upstream/server/.env (docs/upstream-analysis.md risk 1), which must never happen inside a signed app.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$ROOT/upstream/server"
if [ -n "${1:-}" ]; then
  ELECTRON="$1"
elif [ "$(uname -s)" = "Darwin" ]; then
  ELECTRON="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
else
  ELECTRON="$ROOT/node_modules/electron/dist/electron"
fi
PORT="${CHECK_PORT:-3901}"
TIMEOUT="${CHECK_TIMEOUT:-90}"

fail() { echo "[check-server-boot] FAIL: $*" >&2; exit 1; }

[ -x "$ELECTRON" ] || fail "Electron binary not found at $ELECTRON (run: node node_modules/electron/install.js)"
[ -f "$SERVER/public/_index.html" ] || fail "upstream/server is not built (run: make build)"

WORK="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# Loaded with -r before index.js: any require of canvas throws, as it would if its binary failed to load.
cat > "$WORK/block-canvas.js" <<'EOF'
const Module = require('module');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'canvas' || request.startsWith('canvas/')) {
    throw new Error('canvas blocked by check-server-boot');
  }
  return load.call(this, request, ...rest);
};
console.log('[check-server-boot] canvas is blocked in this process');
EOF

export ELECTRON_RUN_AS_NODE=1
export CHECKPOINT_DISABLE=1
export NODE_ENV=production
export SERVER_PORT="$PORT"
export STORAGE_DIR="$WORK/storage"
export JWT_SECRET="check-$RANDOM-$RANDOM" SIG_KEY="check-key-$RANDOM-$RANDOM" SIG_SALT="check-salt-$RANDOM-$RANDOM"
export DISABLE_TELEMETRY=true VECTOR_DB=lancedb
export LLM_PROVIDER=ollama OLLAMA_BASE_PATH=http://127.0.0.1:11434
export EMBEDDING_ENGINE=ollama EMBEDDING_BASE_PATH=http://127.0.0.1:11434
mkdir -p "$STORAGE_DIR"

echo "[check-server-boot] electron $("$ELECTRON" -p 'process.versions.electron + " node " + process.versions.node')"
(cd "$SERVER" && "$ELECTRON" node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma) \
  > "$WORK/migrate.log" 2>&1 || { cat "$WORK/migrate.log"; fail "prisma migrate deploy"; }
echo "[check-server-boot] prisma migrate deploy ok"

(cd "$SERVER" && exec "$ELECTRON" -r "$WORK/block-canvas.js" index.js) > "$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq "$TIMEOUT"); do
  if curl -fs "http://127.0.0.1:$PORT/api/ping" > "$WORK/ping.json" 2>/dev/null; then
    grep -q 'canvas is blocked' "$WORK/server.log" || fail "canvas block was not loaded"
    echo "[check-server-boot] ok: /api/ping returned $(cat "$WORK/ping.json") with canvas blocked"
    exit 0
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -40 "$WORK/server.log"; fail "server exited during boot"; }
  sleep 1
done
tail -40 "$WORK/server.log"
fail "no answer from /api/ping within ${TIMEOUT}s"
