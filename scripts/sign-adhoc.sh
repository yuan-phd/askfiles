#!/bin/bash
# Ad-hoc signs the packaged app so arm64 binaries are allowed to run, then verifies the signature.
# Mac only. Usage: scripts/sign-adhoc.sh [path/to/AskFiles.app]   (default: release/mac-arm64/AskFiles.app)

set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "[sign-adhoc] codesign exists only on macOS; run this on the Mac after npm run package:mac" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-$ROOT/release/mac-arm64/AskFiles.app}"

if [ ! -d "$APP" ]; then
  echo "[sign-adhoc] app not found: $APP (run npm run package:mac first)" >&2
  exit 1
fi

# --deep only reaches code in the standard bundle locations (Frameworks, Helpers). Native modules,
# Prisma engines and the Ollama files sit under Contents/Resources, so sign every Mach-O file there
# first (inside out, as Apple recommends), then the bundle itself. The files are found by their
# header in one node process and signed 50 per codesign call.
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
node "$ROOT/scripts/lib/macho-files.mjs" "$APP/Contents/Resources" > "$LIST"
count=$(tr -cd '\0' < "$LIST" | wc -c | tr -d ' ')
if [ "$count" -gt 0 ]; then
  xargs -0 -n 50 codesign --force --sign - < "$LIST"
fi
echo "[sign-adhoc] signed $count Mach-O files under Contents/Resources"

echo "[sign-adhoc] signing $APP"
codesign --force --deep --sign - "$APP"
echo "[sign-adhoc] verifying"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "[sign-adhoc] ok: $APP"
