#!/bin/bash
# Vendors the AnythingLLM core into upstream/ with git subtree, squashed to one commit per update.
#
# First run:   scripts/vendor-upstream.sh <tag>     (git subtree add)
# Upgrade:     scripts/vendor-upstream.sh <tag>     (git subtree pull)
#
# To list recent tags:
#   git ls-remote --tags https://github.com/Mintplex-Labs/anything-llm.git | grep -v '\^{}' | tail -n 20
#
# Why subtree and not submodule: cloud sessions clone only the repositories attached to the session and
# the GitHub proxy refuses fetches for other repositories. A subtree keeps the upstream code inside this
# repository, so every clone has it.

set -eu

TAG="${1:?usage: scripts/vendor-upstream.sh <tag>}"
REMOTE="https://github.com/Mintplex-Labs/anything-llm.git"
PREFIX="upstream"

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree must be clean before vendoring upstream"
  exit 1
fi

if [ -d "$PREFIX" ]; then
  git subtree pull --prefix="$PREFIX" "$REMOTE" "$TAG" --squash -m "upstream: AnythingLLM $TAG"
else
  git subtree add --prefix="$PREFIX" "$REMOTE" "$TAG" --squash -m "upstream: AnythingLLM $TAG"
fi

echo "$TAG" > UPSTREAM_VERSION
git add UPSTREAM_VERSION
git commit -m "upstream: pin $TAG" >/dev/null 2>&1 || true

echo "vendored AnythingLLM $TAG into $PREFIX/ and recorded it in UPSTREAM_VERSION"
