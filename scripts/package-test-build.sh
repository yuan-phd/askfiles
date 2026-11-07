#!/bin/bash
# Packages the test build, AskFiles Test (docs/test-build.md), into release-test/.
# Usage: scripts/package-test-build.sh mac|win
# Run after npm run package:mac or package:win, which prepare the upstream tree and
# THIRD-PARTY-NOTICES, and after node scripts/build-main.mjs --flavour test (npm run
# package:mac:test and package:win:test do both). Same electron-builder.yml, same appId and data
# directory; only the name, the output folder and the file names differ.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
NAME='AskFiles Test'
OUT=release-test

if [ ! -f dist/main/test-record/index.js ] || [ ! -f dist/main/test-record/ui/ui.js ]; then
  echo "[package-test-build] dist/main has no test record; run node scripts/build-main.mjs --flavour test first" >&2
  exit 1
fi

# --publish never: on a push to main electron-builder detects CI and publishes implicitly, which
# needs a GitHub token and stops the DMG step without one (mac run #65); the test build is never
# published, only uploaded as a workflow artifact.
COMMON=(--config electron-builder.yml "-c.productName=$NAME" "-c.directories.output=$OUT" --publish never)

case "${1:-}" in
  mac)
    rm -rf "$OUT/mac-arm64"
    npx electron-builder "${COMMON[@]}" --mac dir --arm64
    bash scripts/sign-adhoc.sh "$ROOT/$OUT/mac-arm64/$NAME.app"
    npx electron-builder "${COMMON[@]}" "-c.dmg.artifactName=$NAME.dmg" --mac dmg --arm64 \
      --prepackaged "$OUT/mac-arm64/$NAME.app"
    ls -l "$OUT/$NAME.dmg"
    ;;
  win)
    rm -rf "$OUT/win-unpacked"
    npx electron-builder "${COMMON[@]}" "-c.nsis.artifactName=AskFiles-Test-Setup.exe" \
      "-c.nsis.shortcutName=$NAME" --win nsis --x64
    ls -l "$OUT/AskFiles-Test-Setup.exe"
    ;;
  *)
    echo "usage: scripts/package-test-build.sh mac|win" >&2
    exit 2
    ;;
esac
