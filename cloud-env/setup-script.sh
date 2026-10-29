#!/bin/bash
# Paste this into the Setup script field of the cloud environment at claude.ai/code.
# It runs as root on Ubuntu 24.04 before Claude starts, on the first session only; the result is cached.
# Constraints: must exit 0, must finish in under about 5 minutes or the environment is not cached.
# This file in the repo is a reference copy; the repo does not execute it.

set -u
export DEBIAN_FRONTEND=noninteractive

# The Ollama installer unpacks a .tar.zst archive and refuses to run without zstd. iproute2 provides
# ss, which the process manager integration test uses to check that every socket binds to 127.0.0.1.
if ! command -v zstd >/dev/null 2>&1 || ! command -v ss >/dev/null 2>&1; then
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq zstd iproute2 >/dev/null 2>&1 || echo "[setup] zstd or iproute2 install failed"
fi

# Ollama for integration tests. The installer downloads from ollama.com and GitHub release assets.
if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh || echo "[setup] ollama install failed"
fi

# Pull two small test models while a temporary server runs, then stop it. Files stay in the cache.
if command -v ollama >/dev/null 2>&1; then
  export OLLAMA_HOST=127.0.0.1:11434
  (ollama serve > /tmp/ollama-setup.log 2>&1 &)
  for i in $(seq 1 30); do
    curl -fs http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
  timeout 150 ollama pull qwen3:0.6b || echo "[setup] pull qwen3:0.6b failed"
  timeout 60 ollama pull all-minilm || echo "[setup] pull all-minilm failed"
  pkill -f "ollama serve" || true
fi

exit 0
