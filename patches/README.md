# patches

Unified diffs that scripts/build.sh applies, in file name order (001-..., 002-...), to upstream-build/run: a gitignored copy of the tracked upstream/ files that dev runs, tests and packaging use (scripts/lib/upstream-copy.mjs). upstream/ itself is never patched.

Each patch starts with a comment block that says what it changes and why upstream cannot be used as is. Keep patches minimal; re-check them with git apply --check after every upstream upgrade.

Paths inside a patch are relative to upstream/. A new patch applies on top of the earlier ones, which upstream-build/run already holds, so it can be checked there without changing anything, from the repository root:

    git apply --check --directory=upstream-build/run patches/NNN-name.patch

Then npm run build:upstream copies upstream/ again and applies every patch, the new one included. Running git apply from inside a folder of the repository silently skips every file ("Skipped patch"), because git resolves patch paths from the repository top level; scripts/lib/patches.mjs therefore runs git with that folder as a ceiling.

`node scripts/lib/patches.mjs check <dir>` reports whether a tree that has server/ and collector/ holds every patch, by reverting them last first on a temporary copy of the patched files. The packaging commands run it on the packaged app's Resources folder.

| Patch | Why |
| --- | --- |
| 001-bind-localhost.patch | Server (HTTP and HTTPS) and collector listen on 127.0.0.1 by default, overridable with ANYTHING_LLM_BIND_HOST |
| 002-database-url.patch | SQLite path from DATABASE_URL instead of a path inside the server code; run prisma generate after applying |
| 003-upload-folder.patch | Upload folder and collector tmp folder from ANYTHING_LLM_HOTDIR and ANYTHING_LLM_COLLECTOR_TMP_DIR |
| 004-server-env-path.patch | Server loads and dumpENV rewrites the .env at ANYTHING_LLM_ENV_PATH |
| 005-cors-origin.patch | 403 for browser requests from origins other than the server's own and ANYTHING_LLM_ALLOWED_ORIGINS |
| 006-no-boot-fetch.patch | No models.dev or raw.githubusercontent.com fetch at boot unless ANYTHING_LLM_ALLOW_REMOTE_MODEL_DATA=true |
| 007-reasoning-effort-api.patch | /api/v1 workspace and thread chat routes take reasoningEffort, default DEFAULT_REASONING_EFFORT |
| 008-bulk-remove-documents.patch | Removing documents from a LanceDB workspace deletes their vectors in batches (one delete per 1000 vector ids) instead of one delete per document; clearing 1311 sections for Reindex went from 289 s to 6 s (docs/app.md, Indexing time) |

test/integration/process-manager.test.ts runs the stack from upstream-build/run, checks that every patch is applied there and what each one is for.
