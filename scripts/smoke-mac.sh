#!/bin/bash
# Smoke test of the packaged app on macOS, run by the smoke job in .github/workflows/mac.yml.
# Launches AskFiles.app on a fresh data directory the way a user's first launch goes: the first
# run picks the test preset (ASKFILES_PRESETS_FILE), pulls its models into the app's own Ollama,
# creates the All files library and its API key, and opens the app without asking for a folder.
# ASKFILES_LIBRARY_FOLDER then links a temp folder holding a text PDF and a two-page scanned PDF
# into All files (the bridge-free way; a user adds folders with the Add button), which is indexed,
# the scan OCRed page by page. Then it checks that the Ask page reached the library, that the
# browse index lists both PDFs and that the first run fetched the reranker; once the library is
# indexed the app asks one question through the answer pipeline (ASKFILES_SMOKE_QUESTION) and the
# script checks the logged answer cites [1]. Then it takes a screenshot and quits.
# Mac only. Usage: scripts/smoke-mac.sh path/to/AskFiles.app path/to/out-dir

set -euo pipefail

APP="${1:?usage: smoke-mac.sh AskFiles.app out-dir}"
OUT="${2:?usage: smoke-mac.sh AskFiles.app out-dir}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$HOME/Library/Application Support/AskFiles"
LOGS="$HOME/Library/Logs/AskFiles"
PRESETS="$ROOT/test/fixtures/presets-smoke.json"
QUESTION="How many days of paid annual leave does an employee get per year?"
START_TIMEOUT="${SMOKE_START_TIMEOUT:-600}"
SETUP_TIMEOUT="${SMOKE_SETUP_TIMEOUT:-900}"

log() { echo "[smoke] $*"; }
fail() {
  echo "[smoke] FAIL: $*" >&2
  for f in "$LOGS"/*.log "$OUT/app-stdout.log"; do
    [ -f "$f" ] || continue
    echo "----- last 40 lines of $f -----" >&2
    tail -n 40 "$f" >&2
  done
  exit 1
}
# Reads one value from JSON on stdin with a JavaScript expression over `d`.
json() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);const v=('"$1"');process.stdout.write(v===undefined||v===null?"":String(v))})'; }
# Lines of main.log written by this launch only; an earlier run may have left failures in it.
new_log() { tail -n +$((LOG_START + 1)) "$LOGS/main.log" 2>/dev/null || true; }
running() { pgrep -f "$APP/Contents/MacOS/AskFiles" >/dev/null; }

[ "$(uname -s)" = "Darwin" ] || fail "macOS only"
[ -x "$APP/Contents/MacOS/AskFiles" ] || fail "no app at $APP"
mkdir -p "$OUT"

# A first launch: keep only the model cache (restored by the workflow), drop any earlier setup.
mkdir -p "$DATA"
find "$DATA" -mindepth 1 -maxdepth 1 ! -name ollama -exec rm -rf {} +
FOLDER="$(mktemp -d "${TMPDIR:-/tmp}/askfiles-smoke-docs.XXXXXX")"
FOLDER="$(cd "$FOLDER" && pwd -P)"
cp "$ROOT/test/fixtures/handbook.pdf" "$ROOT/test/fixtures/scanned.pdf" "$FOLDER/"
log "library folder $FOLDER"

LOG_START=$(wc -l <"$LOGS/main.log" 2>/dev/null || echo 0)
log "launching $APP with $PRESETS"
ASKFILES_PRESETS_FILE="$PRESETS" ASKFILES_LIBRARY_FOLDER="$FOLDER" ASKFILES_SMOKE_QUESTION="$QUESTION" \
  "$APP/Contents/MacOS/AskFiles" >"$OUT/app-stdout.log" 2>&1 &

log "waiting up to ${START_TIMEOUT}s for the backend"
t0=$(date +%s)
until [ -s "$DATA/ports.json" ]; do
  [ $(($(date +%s) - t0)) -lt "$START_TIMEOUT" ] || fail "no ports.json after ${START_TIMEOUT}s"
  failed=$(new_log | grep -E '\[main\] backend (failed|not started)' || true)
  [ -z "$failed" ] || fail "the backend did not start: $failed"
  [ $(($(date +%s) - t0)) -lt 15 ] || running || fail "the app exited before the backend was up"
  sleep 2
done
log "backend up after $(($(date +%s) - t0))s"
new_log | grep -q 'ocr data seeded' || fail "main.log does not show the OCR data seeding"
new_log | grep -q 'start page onboarding' || fail "a fresh data directory did not start on the onboarding page"

log "waiting up to ${SETUP_TIMEOUT}s for the first run to finish"
t1=$(date +%s)
done_at=""
until [ -n "$done_at" ]; do
  [ $(($(date +%s) - t1)) -lt "$SETUP_TIMEOUT" ] || fail "first run not done after ${SETUP_TIMEOUT}s"
  failed=$(new_log | grep -E '\[first-run\] .* failed:|\[wizard\] .* failed:' || true)
  [ -z "$failed" ] || fail "the first run failed: $failed"
  running || fail "the app exited during the first run"
  [ -s "$DATA/shell.json" ] && done_at=$(json d.setupCompletedAt <"$DATA/shell.json")
  sleep 2
done
log "first run done after $(($(date +%s) - t1))s at $done_at"

# The marker that the Ask page loaded: it reports back through the bridge once it reached the
# library with the stored key (src/main/app.ts, appPageReady).
t2=$(date +%s)
until new_log | grep -q '\[main\] page ready ask connected=true'; do
  [ $(($(date +%s) - t2)) -lt 60 ] || fail "the Ask page did not report ready within 60s"
  sleep 1
done
log "Ask page ready: $(new_log | grep '\[main\] page ready ask' | tail -n 1)"

# The wizard restarted the backend, so the ports are the ones written after setup.
SERVER_PORT=$(json d.server <"$DATA/ports.json")
B="http://127.0.0.1:$SERVER_PORT/api"
KEY=$(json d.apiKey <"$DATA/shell.json")
SLUG=$(json 'd.libraries[0].workspaceSlug' <"$DATA/shell.json")
[ -n "$KEY" ] && [ -n "$SLUG" ] || fail "shell.json lacks the API key or the All files workspace"
# No folder step: the folder from ASKFILES_LIBRARY_FOLDER is linked into All files after setup.
linked_folders() { json 'd.libraries[0].folders.map(f=>f.path).join(",")' <"$DATA/shell.json"; }
t_link=$(date +%s)
until [ "$(linked_folders)" = "$FOLDER" ]; do
  [ $(($(date +%s) - t_link)) -lt 30 ] || fail "All files links [$(linked_folders)], expected $FOLDER"
  sleep 1
done
auth=(-H "Authorization: Bearer $KEY")
ping=$(curl -fsS "$B/ping") || fail "GET /api/ping failed"
[ "$(echo "$ping" | json d.online)" = "true" ] || fail "/api/ping answered $ping"

# Indexing runs after setup now; each library keeps its records in <data>/libraries/<id>.
LIB="$DATA/libraries/all-files"
index="$LIB/index.json"
indexed() { [ -s "$index" ] && json "['handbook.pdf','scanned.pdf'].every(f=>(Object.values(d.files).find(r=>r.path.endsWith('/'+f))||{sections:[]}).sections.length>0)" <"$index"; }
log "waiting up to ${SETUP_TIMEOUT}s for both PDFs to be indexed"
t_index=$(date +%s)
until [ "$(indexed)" = "true" ]; do
  [ $(($(date +%s) - t_index)) -lt "$SETUP_TIMEOUT" ] || fail "both PDFs not indexed after ${SETUP_TIMEOUT}s"
  running || fail "the app exited while indexing"
  sleep 2
done
log "indexed after $(($(date +%s) - t_index))s"
for f in handbook.pdf scanned.pdf; do
  n=$(json "(Object.values(d.files).find(r=>r.path.endsWith('/$f'))||{sections:[]}).sections.length" <"$index")
  log "$f: $n section(s) in index.json"
done
# OCR runs page by page, so each page of the scan is a section with its real page number.
scanned_pages=$(json "Object.values(d.files).find(r=>r.path.endsWith('/scanned.pdf')).sections.map(s=>s.pageStart).join(',')" <"$index")
[ "$scanned_pages" = "1,2" ] || fail "the OCR sections of scanned.pdf should record pages 1,2, got [$scanned_pages]"
ocr_line=$(new_log | grep '\[watcher\] OCR: .*pages with text' | tail -n 1 || true)
log "OCR timing: ${ocr_line:-not logged}"

ws=$(curl -fsS "$B/v1/workspace/$SLUG" "${auth[@]}") || fail "GET /v1/workspace/$SLUG failed with the stored key"
docs=$(echo "$ws" | json '(d.workspace[0]||d.workspace).documents.length')
log "workspace $SLUG holds $docs section document(s)"
[ "${docs:-0}" -ge 3 ] || fail "expected the sections of both PDFs in the library, got $docs"

# The browse index (src/main/browse): one JSON file per document under the library's folder,
# written in the same watcher event as the index.json record, so allow a few seconds for the last.
browse="$LIB/browse"
browse_titles() {
  node -e 'const fs=require("fs"),p=require("path");const d=process.argv[1];let out=[];try{out=fs.readdirSync(d).filter(n=>n.endsWith(".json")).map(n=>JSON.parse(fs.readFileSync(p.join(d,n),"utf8"))).filter(x=>x.sections.length>0).map(x=>x.title)}catch{}process.stdout.write(out.sort().join(","))' "$browse"
}
t_browse=$(date +%s)
until [ "$(browse_titles)" = "handbook.pdf,scanned.pdf" ]; do
  [ $(($(date +%s) - t_browse)) -lt 30 ] || fail "the browse index in $browse lists [$(browse_titles)], expected handbook.pdf and scanned.pdf"
  sleep 1
done
log "browse index lists $(browse_titles)"
dead=$(new_log | grep -c 'dead-letter' || true)
[ "$dead" = "0" ] || fail "the watcher gave up on files: $(new_log | grep 'dead-letter')"
for lang in eng chi_sim; do
  [ -s "$DATA/storage/models/tesseract/$lang.traineddata" ] || fail "no seeded $lang.traineddata"
done

# The first run fetched the smoke preset's reranker into the data directory (src/main/answer).
reranker="$DATA/models/reranker/Xenova/ms-marco-MiniLM-L-6-v2"
[ -s "$reranker/.askfiles-verified.json" ] && [ -s "$reranker/onnx/model_quantized.onnx" ] ||
  fail "the first run did not fetch the reranker into $reranker"

# ASKFILES_SMOKE_QUESTION: the app asked $QUESTION through the answer pipeline once the Ask page was
# ready and the library indexed, and logs one [answer] smoke line with the cited sources and text.
t3=$(date +%s)
until new_log | grep -q '\[answer\] smoke'; do
  [ $(($(date +%s) - t3)) -lt 300 ] || fail "no [answer] smoke line within 300s"
  running || fail "the app exited before answering"
  sleep 2
done
smoke=$(new_log | grep '\[answer\] smoke' | tail -n 1)
echo "$smoke" >"$OUT/answer.log"
log "pipeline answer after $(($(date +%s) - t3))s: ${smoke:0:400}"
case "$smoke" in
*"smoke failed"*) fail "the answer pipeline failed: $smoke" ;;
esac
echo "$smoke" | grep -q 'notFound=false' || fail "the pipeline found no answer: $smoke"
echo "$smoke" | grep -q 'cited=\[1' || fail "the answer cites no source [1]: $smoke"
echo "$smoke" | grep -q 'text=".*\[1\]' || fail "the answer text has no [1] citation: $smoke"
new_log | grep -q '\[answer\] .* cited of .* selected' || fail "main.log has no [answer] summary line"

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
rm -rf "$FOLDER"
log "ok: first run, Ask page, pipeline answer and quit all clean"
