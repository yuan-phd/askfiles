#!/bin/bash
# Runs a command with its output in the log as usual and, if it fails, posts the last lines as an
# error annotation. Annotations are readable through the public check-runs API without signing in,
# job logs are not, so a failure on the Windows runner can be diagnosed from outside.
# Usage: bash .github/scripts/annotate-run.sh "<title>" <command> [args...]
set -uo pipefail
title="$1"
shift
log="${RUNNER_TEMP:-/tmp}/annotate-$$.log"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  # The first error-looking lines with what follows them, then the end of the output: GitHub cuts an
  # annotation at about 4 KB.
  body=$( (grep -m 3 -A 12 -E 'FAIL|ERROR|Error:|error ' "$log" | head -n 45; echo '-----'; tail -n 25 "$log") | sed -e 's/\x1b\[[0-9;]*m//g' -e 's/%/%25/g' -e 's/\r//g' | awk '{printf "%s%%0A", $0}')
  echo "::error title=${title} (exit ${status})::${body}"
fi
exit "$status"
