# patches

Unified diffs applied to upstream/ by scripts/build.sh, in file name order (001-..., 002-...).

Each patch starts with a comment block that says what it changes and why upstream cannot be used as is. Keep patches minimal; re-check them with git apply --check after every upstream upgrade.

Paths inside a patch are relative to upstream/. Apply from the repository root:

    git apply --check --directory=upstream patches/NNN-name.patch
    git apply --directory=upstream patches/NNN-name.patch

Running git apply from inside upstream/ silently skips every file ("Skipped patch"), because git resolves patch paths from the repository top level.

| Patch | Why |
| --- | --- |
| 001-bind-localhost.patch | Server (HTTP and HTTPS) and collector listen on 127.0.0.1 by default, overridable with ANYTHING_LLM_BIND_HOST |
| 002-database-url.patch | SQLite path from DATABASE_URL instead of a path inside the server code; run prisma generate after applying |
| 003-upload-folder.patch | Upload folder and collector tmp folder from ANYTHING_LLM_HOTDIR and ANYTHING_LLM_COLLECTOR_TMP_DIR |
| 004-server-env-path.patch | Server loads and dumpENV rewrites the .env at ANYTHING_LLM_ENV_PATH |
| 005-cors-origin.patch | 403 for browser requests from origins other than the server's own and ANYTHING_LLM_ALLOWED_ORIGINS |
| 006-no-boot-fetch.patch | No models.dev or raw.githubusercontent.com fetch at boot unless ANYTHING_LLM_ALLOW_REMOTE_MODEL_DATA=true |
| 007-reasoning-effort-api.patch | /api/v1 workspace and thread chat routes take reasoningEffort, default DEFAULT_REASONING_EFFORT |

test/integration/process-manager.test.ts applies all patches in sequence for its run (as build.sh does), checks what each one is for, and reverts them afterwards.
