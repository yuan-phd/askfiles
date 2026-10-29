#!/bin/bash
# Smoke test of the packaged app on macOS, run by the smoke job in .github/workflows/mac.yml.
# Launches AskFiles.app, waits for <data>/ports.json, checks /api/ping, pulls the test models into
# the app's own Ollama, uploads a PDF, asks one question, takes a screenshot and quits the app.
# Mac only. Usage: scripts/smoke-mac.sh path/to/AskFiles.app path/to/out-dir
#
# Until Session E writes presets on first run, this script writes the server .env itself with the
# test models; the process manager keeps an existing .env as it is.

set -euo pipefail

APP="${1:?usage: smoke-mac.sh AskFiles.app out-dir}"
OUT="${2:?usage: smoke-mac.sh AskFiles.app out-dir}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${ASKFILES_DATA_DIR:-$HOME/Library/Application Support/AskFiles}"
LOGS="$HOME/Library/Logs/AskFiles"
CHAT_MODEL="${SMOKE_CHAT_MODEL:-qwen3:0.6b}"
EMBED_MODEL="${SMOKE_EMBED_MODEL:-all-minilm:latest}"
PDF="$ROOT/test/fixtures/handbook.pdf"
QUESTION="How many days of paid annual leave does an employee get per year?"
START_TIMEOUT="${SMOKE_START_TIMEOUT:-600}"

log() { echo "[smoke] $*"; }
fail() {
  echo "[smoke] FAIL: $*" >&2
  for f in "$LOGS"/*.log; do
    [ -f "$f" ] || continue
    echo "----- last 40 lines of $f -----" >&2
    tail -n 40 "$f" >&2
  done
  exit 1
}
# Reads one value from JSON on stdin with a JavaScript expression over `d`.
json() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);const v=('"$1"');process.stdout.write(v===undefined||v===null?"":String(v))})'; }

[ "$(uname -s)" = "Darwin" ] || fail "macOS only"
[ -x "$APP/Contents/MacOS/AskFiles" ] || fail "no app at $APP"
mkdir -p "$OUT"

log "writing $DATA/server/.env with $CHAT_MODEL and $EMBED_MODEL"
mkdir -p "$DATA/server"
secret() { openssl rand -base64 32; }
cat >"$DATA/server/.env" <<EOF
JWT_SECRET="$(secret)"
SIG_KEY="$(secret)"
SIG_SALT="$(secret)"
DISABLE_TELEMETRY="true"
LLM_PROVIDER=ollama
OLLAMA_MODEL_PREF=$CHAT_MODEL
OLLAMA_MODEL_TOKEN_LIMIT=4096
EMBEDDING_ENGINE=ollama
EMBEDDING_MODEL_PREF=$EMBED_MODEL
VECTOR_DB=lancedb
DEFAULT_REASONING_EFFORT=off
EOF
chmod 600 "$DATA/server/.env"
rm -f "$DATA/ports.json"

log "launching $APP"
open "$APP"

log "waiting up to ${START_TIMEOUT}s for $DATA/ports.json"
t0=$(date +%s)
until [ -s "$DATA/ports.json" ]; do
  [ $(($(date +%s) - t0)) -lt "$START_TIMEOUT" ] || fail "no ports.json after ${START_TIMEOUT}s"
  # open returns before the process exists; give it a moment before treating absence as an exit.
  if [ $(($(date +%s) - t0)) -gt 15 ] && ! pgrep -f "$APP/Contents/MacOS/AskFiles" >/dev/null; then
    fail "the app exited before the backend was up"
  fi
  sleep 2
done
SERVER_PORT=$(json d.server <"$DATA/ports.json")
OLLAMA_PORT=$(json d.ollama <"$DATA/ports.json")
log "backend up after $(($(date +%s) - t0))s: server $SERVER_PORT, ollama $OLLAMA_PORT"
B="http://127.0.0.1:$SERVER_PORT/api"

ping=$(curl -fsS "$B/ping") || fail "GET /api/ping failed"
[ "$(echo "$ping" | json d.online)" = "true" ] || fail "/api/ping answered $ping"
log "/api/ping: $ping"

for m in "$CHAT_MODEL" "$EMBED_MODEL"; do
  log "pulling $m into the app's Ollama"
  OLLAMA_HOST="127.0.0.1:$OLLAMA_PORT" "$APP/Contents/Resources/ollama/ollama" pull "$m" >/dev/null ||
    fail "ollama pull $m failed"
done

KEY=$(curl -fsS -X POST "$B/system/generate-api-key" -H 'Content-Type: application/json' -d '{"name":"smoke"}' |
  json d.apiKey.secret) || fail "could not create an API key"
[ -n "$KEY" ] || fail "empty API key"
auth=(-H "Authorization: Bearer $KEY")

# Threshold 0 so the test embedder's low scores still return the passage as a source.
SLUG=$(curl -fsS -X POST "$B/v1/workspace/new" "${auth[@]}" -H 'Content-Type: application/json' \
  -d '{"name":"smoke","chatMode":"query","similarityThreshold":0,"topN":4,"openAiTemp":0.1}' |
  json d.workspace.slug) || fail "could not create the workspace"
log "workspace $SLUG"

up=$(curl -fsS -X POST "$B/v1/document/upload" "${auth[@]}" -F "file=@$PDF" -F "addToWorkspaces=$SLUG") ||
  fail "upload failed"
[ "$(echo "$up" | json d.success)" = "true" ] || fail "upload answered $up"
log "uploaded $(basename "$PDF"): $(echo "$up" | json 'd.documents[0].location')"

t1=$(date +%s)
answer=$(curl -fsS --max-time 300 -X POST "$B/v1/workspace/$SLUG/chat" "${auth[@]}" -H 'Content-Type: application/json' \
  -d "{\"message\":\"$QUESTION\",\"mode\":\"query\",\"sessionId\":\"smoke-$(date +%s)\"}") || fail "chat call failed"
echo "$answer" >"$OUT/chat.json"
text=$(echo "$answer" | json 'd.textResponse.replace(/<think>[\s\S]*?<\/think>/g,"").trim()')
sources=$(echo "$answer" | json '(d.sources||[]).length')
log "chat answered in $(($(date +%s) - t1))s with $sources source(s): ${text:0:200}"
[ -n "$text" ] || fail "empty answer: $answer"
[ "$sources" -ge 1 ] || fail "answer has no sources: $answer"

screencapture -x "$OUT/smoke.png" || fail "screencapture failed"
log "screenshot $OUT/smoke.png"

log "quitting the app"
osascript -e 'quit app "AskFiles"' || true
for _ in $(seq 1 60); do
  pgrep -f "$APP/Contents" >/dev/null || break
  sleep 1
done
if pgrep -fl "$APP/Contents"; then
  pkill -9 -f "$APP/Contents" || true
  fail "processes from the bundle were still running 60s after quit"
fi
[ ! -e "$DATA/ports.json" ] || fail "ports.json still present after quit"
log "ok: app quit cleanly, no process left"
