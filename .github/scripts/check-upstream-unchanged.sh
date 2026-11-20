#!/bin/bash
# Fails when upstream/ differs from the commit in any way git can see: a changed or deleted tracked
# file, or any untracked or ignored file. Nothing may write there; scripts/build.sh works in
# upstream-build/ (scripts/lib/upstream-copy.mjs). Meant for a fresh CI checkout, where upstream/
# holds only tracked files. Posts the list as an error annotation, readable without signing in.
set -euo pipefail
changes=$(git status --porcelain=v1 --ignored -- upstream/)
if [ -n "$changes" ]; then
  echo "$changes" | head -40
  echo "::error title=upstream/ changed::$(echo "$changes" | head -20 | awk '{printf "%s%%0A", $0}')"
  exit 1
fi
echo "[check-upstream] upstream/ is unchanged: no modified, untracked or ignored files"
