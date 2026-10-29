#!/bin/bash
# Lists the largest directories under the packaged server and collector dependency folders, as
# Markdown with the date and commit, for docs/bundle-report.md.
#
# Usage: scripts/measure-bundle.sh [resources-dir] [count]
#   resources-dir  folder holding server/ and collector/; default: the packaged app under release/
#                  (mac-arm64/AskFiles.app/Contents/Resources, else linux-unpacked/resources)
#   count          number of directories to list, default 40
#
# Linux packaging for a measurement in a cloud session:
#   npm run build && npx electron-builder --config electron-builder.yml --linux dir

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RES="${1:-}"
COUNT="${2:-40}"

if [ -z "$RES" ]; then
  for candidate in "$ROOT/release/mac-arm64/AskFiles.app/Contents/Resources" "$ROOT/release/linux-unpacked/resources"; do
    if [ -d "$candidate/server/node_modules" ]; then RES="$candidate"; break; fi
  done
fi
if [ -z "$RES" ] || [ ! -d "$RES/server/node_modules" ] || [ ! -d "$RES/collector/node_modules" ]; then
  echo "[measure-bundle] no packaged server/node_modules and collector/node_modules found${RES:+ under $RES}" >&2
  echo "[measure-bundle] package first (see the usage at the top of this script) or pass the resources folder" >&2
  exit 1
fi

COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
# build.sh patches upstream/ in place, so only changes outside it make the commit inexact.
if [ -n "$(git -C "$ROOT" status --porcelain -- . ':!upstream' 2>/dev/null)" ]; then COMMIT="$COMMIT (uncommitted changes)"; fi

echo "Measured $(date -u +%Y-%m-%d) at commit $COMMIT on $(uname -s) $(uname -m)."
echo "Packaged copy: ${RES#"$ROOT"/}"
echo
node "$ROOT/scripts/lib/measure-bundle.mjs" "$RES" --top "$COUNT"
