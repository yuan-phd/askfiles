# Upstream analysis: AnythingLLM v1.19.0

Session A, plan task 1.1. Analysis of the vendored core in upstream/ at the tag in UPSTREAM_VERSION (v1.19.0), done on 2026-10-29 in a Linux x86_64 cloud container with Node v22.22.0.

Labels used in this document:

- VERIFIED: run in this container; the command or experiment is named.
- READ: read in the code at the cited path and line; not run.
- INFERRED: a conclusion drawn from code or docs that was neither run nor stated in the code.
- LOCAL: can only be checked on the Mac; the exact step is given.

Experiments ran against a scratch copy of upstream/server, upstream/collector and upstream/frontend (fresh install, same package.json and yarn.lock). Nothing under upstream/ was changed.

## Summary for the next sessions

What the shell has to do, in order of impact. Details are under each question and in Risks found.

1. Packaging needs four small upstream patches beyond the bind-host patch already planned, because in production upstream writes into its own code directories, not only into STORAGE_DIR (VERIFIED):
   - SQLite path is hard-coded in upstream/server/prisma/schema.prisma:15 to upstream/server/storage/anythingllm.db. A one-line patch to `env("DATABASE_URL")` works (VERIFIED, Q2).
   - The server writes uploads to `STORAGE_DIR/../../collector/hotdir`, the collector reads `upstream/collector/hotdir` and wipes it and `upstream/collector/storage/tmp` at boot. Needs a hotdir path from an env var in two server files and two collector files.
   - dumpENV rewrites upstream/server/.env next to the code (upstream/server/utils/helpers/updateENV.js:1717).
   - CORS reflects any origin and, with no AUTH_TOKEN, every /api/system route is open: a web page in the user's browser can read the API keys from the local server (VERIFIED). Restrict CORS or set AUTH_TOKEN.
2. All native modules are N-API. Server and collector boot, parse, OCR, embed and answer under Electron 45.1.0 (Node 24.22.1) with ELECTRON_RUN_AS_NODE=1 without electron-rebuild (VERIFIED on Linux, LOCAL check on the Mac). Ship server and collector outside asar.
3. Section chunking: write one document JSON per section into `STORAGE_DIR/documents/<folder>/` and call `update-embeddings`. Custom keys such as sectionTitle, sectionIndex, pageStart reach the chat sources array with no patch (VERIFIED, Q13 and Q15). Upstream drops page numbers and headings, so the shell parses files itself (Q6, Q14).
4. Embedding input is silently truncated by Ollama at min(num_ctx, 2048, model context) tokens. bge-m3 measured 0.62 to 0.68 tokens per Chinese character, so a 3000 character Chinese chunk is about 2000 tokens, at the limit (VERIFIED, Q10).
5. Two outbound calls at every boot with no off switch (models.dev and raw.githubusercontent.com), and OCR downloads language data from cdn.jsdelivr.net on first use; a failed OCR download crashes the collector process (VERIFIED). Pre-seed tesseract data and patch out the two boot fetches.

## Q1. Native modules and N-API

Method: listed every `*.node` file and every package with an install script in upstream/server/node_modules and upstream/collector/node_modules, read `binary.napi_versions` and `napi` fields, then loaded each module under plain Node 22 and under Electron 45.1.0 with ELECTRON_RUN_AS_NODE=1 (script in Commands verified, item 6). All VERIFIED.

| Package (version) | Used by | Where loaded | Binding type | Ships darwin-arm64 binary how |
| --- | --- | --- | --- | --- |
| @prisma/client 5.3.1, query engine `libquery_engine-<target>.so.node` | server | upstream/server/utils/prisma/index.js:1 | Node-API library engine (engineType library) | Downloaded by prisma generate for the native platform of the build machine |
| @lancedb/lancedb 0.15.0 | server | upstream/server/utils/vectorDbProviders/lance/index.js:1 | napi-rs (N-API) | Optional dependency @lancedb/lancedb-darwin-arm64 |
| @mintplex-labs/mdpdf 0.1.10 | server | dynamic import, upstream/server/utils/chats/exportChatToFile.js:285 and agent create-pdf | napi-rs (N-API) | Optional dependency @mintplex-labs/mdpdf-darwin-arm64 |
| canvas 3.2.1 | server, via chartjs-node-canvas | upstream/server/utils/chats/exportChatToFile.js:59, upstream/server/utils/telegramBot/chat/agent.js:442 | N-API 7, prebuild-install, falls back to node-gyp | Prebuilt download from GitHub at install time |
| sharp 0.32.6 | server (via @xenova/transformers) | native embedder and reranker | N-API 7, prebuild-install; libvips downloaded at install | Download from GitHub at install time |
| onnxruntime-node 1.14.0 | server and collector (via @xenova/transformers) | upstream/server/utils/EmbeddingRerankers/native/index.js:98, upstream/server/utils/EmbeddingEngines/native/index.js:142, upstream/collector/utils/WhisperProviders/localWhisper.js:128 | N-API 3 | Inside the package: bin/napi-v3/darwin/arm64 (onnxruntime_binding.node plus libonnxruntime.1.14.0.dylib, 21 MB) |
| sharp 0.33.5 | collector | upstream/collector/utils/OCRLoader/index.js:355 | N-API 9 | Optional dependency @img/sharp-darwin-arm64 and @img/sharp-libvips-darwin-arm64 |
| sharp 0.32.6 (nested) | collector, @xenova/transformers/node_modules/sharp | Whisper only | N-API 7 | As server sharp 0.32.6 |

Not native modules but platform binaries the build must provide:

- @vscode/ripgrep 1.17.1 (server): executable downloaded from GitHub at postinstall; spawned by upstream/server/utils/files/index.js:635 and the agent filesystem plugin. Must be outside asar to be executable (INFERRED).
- Prisma schema engine `schema-engine-<target>` (20 MB) in @prisma/engines, spawned by prisma migrate deploy.
- tesseract.js uses WebAssembly (tesseract.js-core 6.0.0), not a native module.

Answer: every native module is N-API (ABI stable). Child processes can run on Electron's own Node with ELECTRON_RUN_AS_NODE=1 without electron-rebuild. VERIFIED on Linux: Electron 45.1.0 (Node 24.22.1, NODE_MODULE_VERSION 150) loaded all eight modules, ran prisma migrate deploy, booted server and collector, uploaded a DOCX and a PNG (OCR), embedded into LanceDB and answered vector-search. LOCAL: repeat the same load script on the Mac against a darwin-arm64 install (Commands verified, item 6).

Build implication: install server and collector dependencies on a macOS arm64 machine (or CI runner) so optional dependencies and prebuilt downloads resolve for darwin-arm64. A Linux install cannot be copied to the Mac.

## Q2. Prisma query engine location and asar

READ in the generated client upstream/server/node_modules/.prisma/client/index.js (generated here) and in @prisma/client/runtime/library.js:

- Engine type is library (index.js:510). binaryTargets is the native platform only, because schema.prisma has no binaryTargets (index.js:512-518). A build on macOS arm64 produces `libquery_engine-darwin-arm64.dylib.node`.
- Lookup order at runtime: env `PRISMA_QUERY_ENGINE_LIBRARY` if set; else search locations `[config.dirname (the generated client dir), its parent, generator output, ../../../.prisma/client, /tmp/prisma-engines, cwd]` (library.js, `searchLocations`). The generated client also hints `path.join(process.cwd(), "node_modules/.prisma/client/...")` (index.js:579-583).
- The runtime has no asar awareness (no `app.asar` string in library.js). It finds the engine with fs calls and loads it with process.dlopen.
- prisma migrate deploy spawns the schema-engine executable from @prisma/engines.

Answer: do not put upstream/server inside asar. Ship upstream/server and upstream/collector as plain directories (electron-builder extraResources) so that node_modules/.prisma/client, @prisma/engines (schema-engine) and the prisma CLI stay real files. INFERRED: Electron's asar shim can dlopen a .node file from asar by extracting to a temp file, but spawning schema-engine from asar does not work, and every other path problem below (DB, hotdir, .env) needs writable real directories anyway. If any part ends up in asar, set PRISMA_QUERY_ENGINE_LIBRARY to the unpacked engine path.

Related finding, VERIFIED: the database location does not follow STORAGE_DIR. upstream/server/prisma/schema.prisma:13-16 hard-codes `url = "file:../storage/anythingllm.db"`, relative to the schema, so the DB is always upstream/server/storage/anythingllm.db. prisma migrate deploy with STORAGE_DIR set elsewhere created the DB in server/storage, and STORAGE_DIR stayed without a DB. Experiment: changing line 15 to `url = env("DATABASE_URL")`, then prisma generate, then `DATABASE_URL=file:<data>/anythingllm.db prisma migrate deploy` created and migrated the DB at the data path, and the client read it. Without DATABASE_URL the client fails with Environment variable not found: DATABASE_URL. This one-line patch is the recommended fix; the process manager must pass DATABASE_URL to both migrate and server.

Prisma CLI telemetry: set CHECKPOINT_DISABLE=1 for every prisma command (upstream/docker/docker-entrypoint.sh:21-22).

## Q3. Puppeteer and packages over 50 MB

- The collector depends on puppeteer 21.5.2. Its postinstall downloads Chromium unless PUPPETEER_SKIP_DOWNLOAD=1. puppeteer is used only through langchain's PuppeteerWebBaseLoader for link scraping (upstream/collector/utils/extensions/WebsiteDepth/index.js:4, upstream/collector/processLink/convert/generic.js) and is loaded lazily. VERIFIED: with PUPPETEER_SKIP_DOWNLOAD=1 the collector boots and processes PDF, DOCX, MD, PNG and scanned PDF. Web scraping can be dropped; keep PUPPETEER_SKIP_DOWNLOAD=1 in the build.
- Playwright is not a dependency.

Packages of 50 MB or more on disk, Linux x86_64, full install (VERIFIED with du):

| Package | server | collector | frontend | Notes |
| --- | --- | --- | --- | --- |
| flow-bin | 143 MB | | 143 MB | devDependency, pruned by a production install |
| onnxruntime-node | 93 MB | 93 MB | | Carries binaries for 6 platforms; darwin/arm64 is 21 MB, others can be deleted |
| @lancedb/lancedb-linux-x64-musl | 91 MB | | | Linux only; on Mac the darwin-arm64 package replaces both gnu and musl |
| @lancedb/lancedb-linux-x64-gnu | 87 MB | | | Linux only |
| onnxruntime-web | 67 MB | 66 MB | 146 MB | WASM build pulled by @xenova/transformers |
| @mintplex-labs/mdpdf-linux-x64-musl and -gnu | 57 MB each | | | Linux only; used only for chat export to PDF and an agent skill |
| @xenova/transformers | | 62 MB | | Native embedder, reranker, local Whisper |
| @phosphor-icons/react | | | 52 MB | Build time only |

Totals: server 1359 MB, collector 644 MB, frontend 757 MB node_modules. A production install (`yarn install --production --frozen-lockfile --ignore-scripts`) is 1070 MB for server and 603 MB for collector on Linux. The frontend is not shipped; its build output (frontend/dist) is 16 MB. Under 50 MB but notable: @prisma/engines 38 MB, prisma CLI 29 MB, .prisma/client 18 MB, tesseract.js-core 30 MB, pdf-parse 30 MB. The puppeteer Chromium download (not installed here) would land in ~/.cache/puppeteer, outside node_modules.

LOCAL: measure the same on the darwin-arm64 install; expect the Linux-only lancedb and mdpdf packages (about 290 MB) to drop out.

## Q4. Bind host

READ and VERIFIED:

- Server: upstream/server/utils/boot/index.js:67 `app.listen(port, ...)` and :34 for HTTPS, no host argument. Port from SERVER_PORT, default 3001 (upstream/server/index.js:93, :198).
- Collector: upstream/collector/index.js:226 `app.listen(COLLECTOR_PORT, ...)`, no host. Port from COLLECTOR_PORT, default 8888.
- No environment variable sets a bind host. The server always calls the collector at 127.0.0.1 (upstream/server/utils/collectorApi/index.js:54), so binding both to 127.0.0.1 breaks nothing.
- VERIFIED: /proc/net/tcp showed both sockets on 0.0.0.0, and `curl http://<container ip>:3001/api/ping` and `:8888/` answered 200.

Answer: a patch is required, as already recorded in the plan (Session C). The same patch should add a host argument at the three listen calls. Also see Q4b below, which belongs to the same patch.

### Q4b. CORS and unauthenticated API (found while answering Q4)

VERIFIED with curl against the running server:

- `cors({ origin: true })` (upstream/server/index.js:67, upstream/collector/index.js:35) reflects any Origin. A preflight from Origin https://evil.example to POST /api/system/generate-api-key returned 204 with Access-Control-Allow-Origin: https://evil.example.
- With no AUTH_TOKEN, validatedRequest lets every request through (upstream/server/utils/middleware/validatedRequest.js:16-24). GET /api/system/api-keys returned the stored API key secrets with Access-Control-Allow-Origin set to the foreign origin.
- GET /api/v1/system/env-dump and GET /api/env-dump need no key (upstream/server/endpoints/api/system/index.js:16-37, upstream/server/endpoints/system.js:92-99).

Effect: any web page the user opens can mint or read an API key and then read the library through the local API. This breaks the promise that documents never leave the machine. Binding to 127.0.0.1 does not help, because the browser itself is on the machine. Fix options: patch CORS to allow only the shell's own origin (smallest), or set AUTH_TOKEN and JWT_SECRET so /api/system needs a session token (affects the phase 1 upstream UI, which then shows a password screen). Recommendation: CORS patch in the same file as the bind-host patch.

## Q5. Onboarding completion

READ, then VERIFIED by boot log and GET /api/onboarding:

- The frontend calls GET /api/onboarding in every route guard and redirects to /onboarding when it returns false or fails (upstream/frontend/src/components/PrivateRoute/index.jsx:22-30, upstream/frontend/src/models/system.js:40-48).
- The server reads table `system_settings`, row `label = 'onboarding_complete'`, `value = 'true'` (upstream/server/models/systemSettings.js:804-812). POST /api/onboarding sets it (upstream/server/endpoints/system.js:111-119).
- At every boot, markOnboarded() sets the row when LLM_PROVIDER, VECTOR_DB, AUTH_TOKEN or JWT_SECRET is set in env (upstream/server/utils/boot/markOnboarded.js:39-45; called at upstream/server/utils/boot/index.js:69). VERIFIED: with LLM_PROVIDER=ollama in .env the first boot logged Legacy instance is already onboarded, marking onboarding as complete, and GET /api/onboarding returned `{"onboardingComplete":true}`.
- The localStorage key `anythingllm_completed_questionnaire` only skips the survey step (upstream/frontend/src/utils/constants.js:7).

Answer: the wizard writes LLM_PROVIDER=ollama and VECTOR_DB=lancedb into the server environment before the first server start; markOnboarded does the rest. Belt and braces: call POST /api/onboarding after the server is healthy. Note the frontend sends users to onboarding whenever /api/onboarding fails, for example while the server is still starting, and the survey step posts to https://onboarding.anythingllm.com (upstream/frontend/src/pages/OnboardingFlow/Steps/Survey/index.jsx:25-42). The shell should open the upstream UI only after /api/ping succeeds.

## Q6. Page numbers in PDF chunks and sources

READ and VERIFIED:

- The PDF loader produces one document per page with `metadata.loc.pageNumber` (upstream/collector/processSingleFile/convert/asPDF/PDFLoader/index.js:23-57). asPDF then joins all pages with blank lines into one pageContent and keeps only the text (upstream/collector/processSingleFile/convert/asPDF/index.js:35-55). The OCR path does the same.
- VERIFIED with a 3-page PDF (fixture manual.pdf): the stored document JSON has keys id, url, title, docAuthor, description, docSource, chunkSource, published, wordCount, pageContent, token_count_estimate and no page field; the LanceDB row and the chat sources have no page field.

Answer: no. Citations cannot show a page with upstream parsing. To get pages, the shell parses PDFs itself and writes page fields into the section documents (Q13, Q15). Each sub-chunk then knows its section's page range; an exact page per sub-chunk needs the shell to split at page boundaries too.

## Q7. Environment variables

Every variable read by server and collector: 296 names, found by grep of process.env, `"X" in process.env` and KEY_MAPPING in upstream/server/utils/helpers/updateENV.js:4-1103 (READ). The table below covers what the preset generator and process manager need. Defaults are the code path when the variable is unset.

| Variable | Read by | Default if unset | What it controls | Source |
| --- | --- | --- | --- | --- |
| NODE_ENV | both | not development | development uses .env.development, hard-coded server/storage, no auth, no static UI. Anything else serves server/public. production also enables dumpENV. Always pass NODE_ENV=production | upstream/server/index.js:1-3, :132; updateENV.js:1560 |
| STORAGE_DIR | both | none; server crashes at require time outside development | Root for documents, vector-cache, lancedb, models, comkey, push-notifications, direct-uploads. Also derives the upload hotdir as STORAGE_DIR/../../collector/hotdir. The collector must get the same value (it reads STORAGE_DIR/comkey/ipc-pub.pem to verify the server's signed requests) | upstream/server/utils/files/index.js:7-26; upstream/collector/utils/comKey/index.js:4-11 |
| SERVER_PORT | server | 3001 | HTTP port | upstream/server/index.js:198 |
| COLLECTOR_PORT | both | 8888 | Collector port; the server reads it to reach the collector | upstream/collector/utils/http/index.js:4, :38-47; upstream/server/utils/collectorApi/index.js:38-54 |
| JWT_SECRET | server | none | Signs session JWTs. If AUTH_TOKEN or JWT_SECRET is missing, /api routes skip auth. Truthy value also marks onboarding done | upstream/server/utils/http/index.js:25-28; validatedRequest.js:16-24 |
| SIG_KEY, SIG_SALT | server | random 32-byte hex each, then dumpENV writes them to server/.env | AES key for stored secrets and server to collector payloads | upstream/server/utils/EncryptionManager/index.js:38-42 |
| AUTH_TOKEN | server | none (no password) | Single-user password; see Q4b | validatedRequest.js:16-24 |
| LLM_PROVIDER | server | `openai` for the chat connector | Chat backend. Set `ollama` | upstream/server/utils/helpers/index.js:160 |
| OLLAMA_BASE_PATH | server | none, provider throws | Ollama URL for chat and model list; no trailing slash | upstream/server/utils/AiProviders/ollama/index.js:26-27; updateENV.js:1178-1187 |
| OLLAMA_MODEL_PREF | server | none for chat; agents fall back to llama3:latest | Chat model tag | ollama/index.js:32; upstream/server/utils/agents/index.js:335-336 |
| OLLAMA_MODEL_TOKEN_LIMIT | server | min(model context, 16384); 4096 if the context cache is empty | Sent as num_ctx on every chat call | ollama/index.js:189-226, :298-300 |
| OLLAMA_KEEP_ALIVE_TIMEOUT | server | 300 (seconds) for chat | keep_alive on chat requests; not sent for embeddings | ollama/index.js:33-35. Not in .env.example |
| OLLAMA_RESPONSE_TIMEOUT | server | global fetch timeout | Long response timeout (ms) for chat and embedder | ollama/index.js:151-172 |
| OLLAMA_AUTH_TOKEN | server | none | Bearer token to Ollama; not needed locally | ollama/index.js:30 |
| OLLAMA_PERFORMANCE_MODE | none | does not exist in v1.19.0 | | grep |
| EMBEDDING_ENGINE | server | native (in-process Xenova, downloads from Hugging Face) | Embedder. Set `ollama`. Changing it wipes all vectors | upstream/server/utils/helpers/index.js:313-315; updateENV.js:1398-1420 |
| EMBEDDING_BASE_PATH | server | none, Ollama embedder throws | Ollama URL for embeddings | upstream/server/utils/EmbeddingEngines/ollama/index.js:10-11 |
| EMBEDDING_MODEL_PREF | server | none for Ollama (throws) | Embedding model tag. Changing it wipes all vectors | ollama embedder :12-13; updateENV.js:261-265 |
| EMBEDDING_MODEL_MAX_CHUNK_LENGTH | server | 1000 | Cap on chunk size in characters, and also sent to Ollama as num_ctx (tokens) for embedding | upstream/server/utils/helpers/index.js:633-642; ollama embedder :21, :106-110 |
| OLLAMA_EMBEDDING_BATCH_SIZE | server | 1 | Chunks per /api/embed call | ollama embedder :18-20. Not in .env.example |
| VECTOR_DB | server | lancedb (with a logged error) | Vector store; LanceDB at STORAGE_DIR/lancedb | upstream/server/utils/helpers/index.js:88, :120-125 |
| DISABLE_TELEMETRY | server | telemetry ON unless exactly the string true | PostHog. Writable from the Privacy page of the upstream UI | upstream/server/utils/telemetry/index.js:9; upstream/server/models/telemetry.js:50; updateENV.js:622-631. Not in server/.env.example, only docker/.env.example |
| TARGET_OCR_LANG | server, passed to collector | eng | Tesseract languages, comma separated, for example eng,chi_sim | upstream/server/utils/collectorApi/index.js:77 |
| WHISPER_PROVIDER | server, passed to collector | local (downloads Xenova/whisper-small) | Audio transcription | collectorApi/index.js:67-68 |
| DISABLE_SWAGGER_DOCS | server | docs served at /api/docs | Swagger UI | upstream/server/swagger/utils.js:12-18 |
| AGENT_SKILL_RERANKER_ENABLED | server | enabled | Agent tool reranking, downloads a model when more than 15 tools | upstream/server/utils/agents/aibitat/utils/toolReranker.js:32-36 |
| ANYTHING_LLM_RUNTIME | server | not docker | `docker` changes URL validation and enables some agent tools; do not set | Not persisted by dumpENV |
| DISABLE_VIEW_CHAT_HISTORY, WORKSPACE_DELETION_PROTECTION, SIMPLE_SSO_*, EMBED_REQUIRE_ALLOWLIST, COMMUNITY_HUB_BUNDLE_DOWNLOADS_ENABLED | server | off | Presence flags: any value, including false, turns them on | READ, see Q8 |

Retrieval values that are not environment variables:

- Chunk size and overlap: system_settings rows `text_splitter_chunk_size` and `text_splitter_chunk_overlap` (upstream/server/models/systemSettings.js:45-46). Chunk size defaults to the embedder limit, overlap to 20 (upstream/server/utils/vectorDbProviders/lance/index.js:352-362). Changing either purges the vector cache.
- Similarity threshold and snippet count: per workspace columns, see Workspace settings below.

Env file handling (READ, partly VERIFIED):

- dotenv loads `.env` from the current working directory (`.env.development` when NODE_ENV=development) and never overrides variables already set in the process environment (upstream/server/index.js:1-3; dotenv lib/main.js:315-331). The process manager should pass every value in the spawn environment.
- dumpENV rewrites upstream/server/.env (path relative to the code, updateENV.js:1717) with an allow list of keys, on every settings change in production, when SIG_KEY or SIG_SALT is missing, and on GET /api/env-dump. Keys it drops include NODE_ENV and ANYTHING_LLM_RUNTIME.
- upstream/server/.env.example ships live placeholder values for JWT_SECRET, SIG_KEY and SIG_SALT. Never copy it as is.
- Documented but never read: AGENT_GSE_CTX, AGENT_GSE_KEY, AWS_BEDROCK_API_KEY, TEXT_GEN_WEB_UI_TOKEN_LIMIT.

Preset variables named in plan task 1.5, checked against the code: LLM_PROVIDER, OLLAMA_BASE_PATH, OLLAMA_MODEL_PREF, OLLAMA_MODEL_TOKEN_LIMIT, EMBEDDING_ENGINE, EMBEDDING_MODEL_PREF, EMBEDDING_MODEL_MAX_CHUNK_LENGTH, VECTOR_DB, DISABLE_TELEMETRY all exist with these exact names. Task 1.5 must add EMBEDDING_BASE_PATH (required by the Ollama embedder) and TARGET_OCR_LANG, and should set NODE_ENV=production, STORAGE_DIR, SERVER_PORT, COLLECTOR_PORT, JWT_SECRET, SIG_KEY, SIG_SALT. Server bound to 127.0.0.1 needs the patch from Q4.

## Q8. Hiding the LLM and embedder settings pages

READ: there is no flag. The frontend reads only VITE_API_BASE and DEV from import.meta.env; the server's only DISABLE_* flags are DISABLE_SWAGGER_DOCS and DISABLE_TELEMETRY.

Minimal patch (INFERRED surface, not written):

1. upstream/frontend/src/components/SettingsSidebar/index.jsx:224-271: add `hidden: true` to the LLM, Vector Database, Embedder and Text Splitting entries. MenuOption already supports `hidden` (upstream/frontend/src/components/SettingsSidebar/MenuOption/index.jsx:16, :44, :185) and hides the parent group when all children are hidden.
2. upstream/frontend/src/main.jsx:70-140: remove or redirect the routes /settings/llm-preference, /settings/embedding-preference, /settings/text-splitter-preference, /settings/vector-database, plus the onboarding routes.
3. Per-workspace model pickers: upstream/frontend/src/pages/WorkspaceSettings/ChatSettings/WorkspaceLLMSelection/index.jsx and upstream/frontend/src/components/WorkspaceChat/ChatContainer/WorkspaceModelPicker/index.jsx (rendered at ChatContainer/index.jsx:499 and :557).
4. Optional server enforcement: reject LLM_PROVIDER, EMBEDDING_ENGINE, EMBEDDING_MODEL_PREF and VECTOR_DB in updateENV (upstream/server/utils/helpers/updateENV.js) so POST /api/system/update-env and /api/v1/system/update-env cannot change presets.

Alternative without a patch: multi-user mode with role checks hides admin pages for non-admin users, but needs a login and changes API key creation (/api/admin/generate-api-key). Not recommended for a single-user app.

Since phase 3 replaces the upstream UI, a frontend-only patch (items 1 to 3) is enough for phase 1.

## Q9. API endpoints for phase 3

All routes are under `http://127.0.0.1:<SERVER_PORT>/api`. Developer routes (/v1/...) need `Authorization: Bearer <api key>`. A wrong or missing key returns 403 `{"error":"No valid api key found."}` (upstream/server/utils/middleware/validApiKey.js:8-22). Swagger spec: upstream/server/swagger/openapi.json, UI at /api/docs. Items marked VERIFIED were run with curl against the running server; the rest are READ.

| Need | Method and route | Body | Response | Status |
| --- | --- | --- | --- | --- |
| Create API key | POST /api/system/generate-api-key (no /v1 route exists) | `{"name":"askfiles"}`; no auth header needed while AUTH_TOKEN is unset | `{"apiKey":{"id","name","secret","createdBy","createdAt","lastUpdatedAt"},"error":null}` | VERIFIED |
| Check key | GET /api/v1/auth | | `{"authenticated":true}` | VERIFIED |
| Create workspace | POST /api/v1/workspace/new | `{"name", ...writable fields}`; unknown keys dropped; chatMode is forced to automatic unless given | `{"workspace":{...row},"message":null}` | VERIFIED |
| Update workspace | POST /api/v1/workspace/{slug}/update | any writable field | `{"workspace","message"}` | READ |
| Upload file | POST /api/v1/document/upload, multipart | `file` (required), `addToWorkspaces` (comma separated slugs, optional, embeds in the same call), `metadata` (JSON string, only title, docAuthor, description, docSource, chunkSource are honoured) | `{"success","error","documents":[{id,url,title,docAuthor,description,docSource,chunkSource,published,wordCount,token_count_estimate,pageContent,location,isDirectUpload}]}` | VERIFIED |
| Upload raw text | POST /api/v1/document/raw-text | `{"textContent","metadata":{"title" required, docAuthor, description, docSource, chunkSource, url, published},"addToWorkspaces"}`; title is slugified and gets .txt; other keys dropped | same as upload | VERIFIED |
| Embed into workspace | POST /api/v1/workspace/{slug}/update-embeddings | `{"adds":[location...],"deletes":[location...]}` | `{"workspace":{...}}`; per-document embed failures are not reported | VERIFIED |
| Chat with sources | POST /api/v1/workspace/{slug}/chat | `{"message","mode":"query","sessionId","reset":false,"attachments":[]}` | `{"id","type":"textResponse","close":true,"error":null,"chatId","textResponse","sources":[...],"metrics"}` | VERIFIED |
| Streaming chat | POST /api/v1/workspace/{slug}/stream-chat | as chat | Server-sent events, see below | VERIFIED |
| Vector search (no model call) | POST /api/v1/workspace/{slug}/vector-search | `{"query","topN","scoreThreshold"}` | `{"results":[{"id","text","metadata":{url,title,author,description,docSource,chunkSource,published,wordCount,tokenCount},"distance","score"}]}` | VERIFIED |
| Thread create | POST /api/v1/workspace/{slug}/thread/new | `{"name","slug"}` | `{"thread":{id,name,slug,workspace_id,user_id,createdAt,lastUpdatedAt},"message"}` | READ |
| Thread list | no list route; GET /api/v1/workspace/{slug} returns `{"workspace":[{..., "threads":[{"user_id","slug"}]}]}` (an array, names not included) | | | READ |
| Thread history | GET /api/v1/workspace/{slug}/thread/{threadSlug}/chats | | `{"history":[{role,content,sources,chatId,sentAt,...}]}` | READ |
| Session history | GET /api/v1/workspace/{slug}/chats?apiSessionId=&limit=100&orderBy=asc | | history list | READ |
| Remove document from library | POST /api/v1/workspace/{slug}/update-embeddings with `deletes` | | | READ |
| Delete document file | DELETE /api/v1/system/remove-documents | `{"names":[location...]}` purges vectors in all workspaces, vector cache and source JSON | `{"success":true,"message":"Documents removed successfully"}` | READ |

Example calls (KEY from the first call; the shell would use its own port):

```
B=http://127.0.0.1:3001/api
KEY=$(curl -s -X POST $B/system/generate-api-key -H 'Content-Type: application/json' -d '{"name":"askfiles"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).apiKey.secret')
curl -s $B/v1/auth -H "Authorization: Bearer $KEY"
curl -s -X POST $B/v1/workspace/new -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Library","chatMode":"query","similarityThreshold":0.25,"topN":4,"openAiTemp":0.1}'
curl -s -X POST $B/v1/document/upload -H "Authorization: Bearer $KEY" -F file=@manual.pdf -F addToWorkspaces=library
curl -s -X POST $B/v1/workspace/library/update-embeddings -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"adds":["askfiles/manual-s2.json"]}'
curl -s -X POST $B/v1/workspace/library/chat -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"message":"What is the installation fee?","mode":"query","sessionId":"q-1"}'
curl -sN -X POST $B/v1/workspace/library/stream-chat -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"message":"How much is the 2026 budget?","mode":"query"}'
curl -s -X POST $B/v1/workspace/library/vector-search -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"query":"installation fee","topN":8,"scoreThreshold":0}'
curl -s -X POST $B/v1/workspace/library/thread/new -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"name":"Recent"}'
curl -s -X DELETE $B/v1/system/remove-documents -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"names":["custom-documents/manual.pdf-<uuid>.json"]}'
```

Sources array element (VERIFIED from /chat and the final stream event): every LanceDB column except the vector, plus `_distance` and `score` (1 minus cosine distance). For a collector document: `id` (vector id), `url`, `title`, `docAuthor`, `description`, `docSource`, `chunkSource`, `published`, `wordCount`, `token_count_estimate`, `text`, `_distance`, `score`, plus any custom keys of the document JSON (Q15). `text` is the full chunk including the header `<document_metadata>\nsourceDocument: <title>\npublished: <date>\n</document_metadata>\n\n`; the client strips it.

Streaming format (VERIFIED, 195 events for one answer): each event is one line `data: <json>` followed by a blank line; no `event:` or `id:` lines.

- Token: `{"uuid","sources":[],"type":"textResponseChunk","textResponse":"<delta>","close":false,"error":false}`. The id key is `uuid`, not `id`.
- End of model output: same shape with `"textResponse":"","close":true`. This is not the end of the stream.
- Final: `{"uuid","type":"finalizeResponseStream","close":true,"error":false,"chatId","metrics","sources":[...]}`. Sources arrive only here.
- Refusal or abort: a single `{"id","type":"textResponse" or "abort","textResponse","sources":[],"close":true,"error"}`.

Other facts for the client (VERIFIED unless marked):

- Thinking models: qwen3 output arrives with `<think>...</think>` inside textResponse in both /chat and stream-chat (VERIFIED). Owner decision: presets disable thinking where possible, and the search page strips think blocks regardless.
- Thinking control (READ): the upstream Ollama provider can turn thinking off. It sends `think: false` when a chat carries reasoningEffort `off` (upstream/server/utils/helpers/reasoningEffort.js:159-161, used at upstream/server/utils/AiProviders/ollama/index.js:297 and :353), and only for models whose /api/show lists the thinking capability (reasoningEffort.js:306-331). But only the session-auth UI routes read reasoningEffort from the request body (upstream/server/endpoints/chat.js:32, :123). The developer routes /api/v1/workspace/{slug}/chat and stream-chat never pass it (no reasoning reference in upstream/server/utils/chats/apiChatHandler.js or upstream/server/endpoints/api/workspace/index.js), and there is no environment variable or workspace column for it. So the shell, which uses the /v1 API, cannot disable thinking without a patch. Options: a small patch that passes reasoningEffort (or a fixed `off` from an environment variable) through the /v1 chat routes into apiChatHandler, or a preset chat model without thinking.
- `openAiHistory: 0` is turned into 20 by `openAiHistory || 20` (upstream/server/utils/chats/apiChatHandler.js:269, READ). Earlier answers in the same session can backfill context, so in query mode an answer can be produced from history with `sources: []`. Use a fresh sessionId per question or `reset: true` (READ).
- The uploaded document's `url` is the hotdir copy (`file://.../collector/hotdir/manual.pdf`), not the user's original path. The shell keeps its own mapping from document to original file.

## Q10. Multilingual embedder on Ollama

Library at the tag date (ollama.com/search?c=embedding, fetched 2026-10-29; Ollama v0.40.13 is the version installed here):

| Model | Tags | Size | Context | Dimension | Multilingual |
| --- | --- | --- | --- | --- | --- |
| bge-m3 | latest = 567m, 567m-fp16 (same digest 790764642607) | 1.2 GB | 8192 | 1024 | Yes (VERIFIED dims and context via /api/show) |
| qwen3-embedding | 0.6b (639 MB, q8_0), 4b (2.5 GB q4_K_M), 8b (4.7 GB q4_K_M), fp16 and q8 variants | | 32K to 40K | not shown | Qwen3 family (INFERRED multilingual; page does not state languages) |
| snowflake-arctic-embed2 | 568m | | | | Yes |
| nomic-embed-text-v2-moe | | | | | Yes |
| paraphrase-multilingual | 278m | | | | Yes (by name) |
| granite-embedding | 278m (30m is English only) | | | | 278m only |

Experiment (VERIFIED, `ollama pull bge-m3` then /api/embed, script in Commands verified, item 9):

- Cross-language similarity. Question 设备多久需要清洁一次 against the document line 设备每六个月需要清洁一次: all-minilm 0.772, bge-m3 0.901. English question against the same Chinese line: all-minilm 0.101, bge-m3 0.843. Unrelated sentence: all-minilm 0.024, bge-m3 0.406. bge-m3 handles Chinese and cross-language retrieval; its scores sit higher overall, so the similarity threshold must be chosen per embedder in phase 2.
- Tokens per character with bge-m3: 2820 characters of Chinese contract text gave 1922 tokens (0.68 per character); English gave 5500 characters for 1202 tokens (4.6 characters per token). The plan's guide of one token per Chinese character is pessimistic for bge-m3.
- Truncation: Ollama embeds at most min(num_ctx, num_batch, model context) tokens and silently drops the rest. Upstream sends only num_ctx = EMBEDDING_MODEL_MAX_CHUNK_LENGTH. Measured: num_ctx 1000 gave 1000 tokens; num_ctx 3000 and 8192 gave 2048 (default num_batch); num_ctx 3000 with num_batch 4096 gave 3000. all-minilm stops at 256 tokens by default and 512 at most.
- Speed on this 4 vCPU container (CPU, not Metal): 5 short sentences in 2.9 s, one 2048-token input in about 11.5 s.

What the server requires of an embedding model (READ):

- Dimension: no configuration. LanceDB creates the table from the first vectors (upstream/server/utils/vectorDbProviders/lance/index.js:249-258). Changing EMBEDDING_ENGINE or EMBEDDING_MODEL_PREF through updateENV wipes all namespaces (updateENV.js:1398-1420); changing it by editing env behind the server's back would leave mismatched dimensions (INFERRED). Model changes therefore need a full re-index.
- Max chunk length: EMBEDDING_MODEL_MAX_CHUNK_LENGTH caps the chunk size in characters and is also the num_ctx in tokens. Because of the 2048 num_batch cap, chunks above about 2048 tokens are truncated: with bge-m3 that is about 3000 Chinese characters or 9000 English characters. The chunk header (about 100 characters) is added after splitting and counts toward the embedded text.

Recommendation: bge-m3 as the default multilingual embedder for all tiers (1.2 GB, 8K context, MIT license per /api/show), qwen3-embedding:0.6b as the alternative to test. For a 3000 character chunk maximum, Chinese text is close to the 2048-token cut; test 2000 and 3000 in phase 2 and check prompt_eval_count. A patch that also sends num_batch would remove the cap (one line in upstream/server/utils/EmbeddingEngines/ollama/index.js:106-110), not needed if the chunk maximum stays at or below about 2800 characters.

## Q11. Frontend served by the server

READ and VERIFIED:

- When NODE_ENV is not development, the server serves upstream/server/public with express.static and renders `/` through MetaGenerator (upstream/server/index.js:132-160). The build keeps fixed names index.js and index.css (upstream/frontend/vite.config.js:58-68), and postbuild renames dist/index.html to dist/_index.html (upstream/frontend/scripts/postbuild.js).
- `yarn build` writes upstream/frontend/dist (16 MB). It must be copied to upstream/server/public (upstream/docker/Dockerfile:173). VERIFIED: copied dist to server/public in the scratch copy; the server booted and served the UI.
- VITE_API_BASE: `API_BASE = import.meta.env.VITE_API_BASE || "/api"` (upstream/frontend/src/utils/constants.js:1). The Docker build sets nothing, so the bundle uses same-origin /api and websockets use window.location.host (upstream/frontend/src/utils/chat/agent.js:82-86). Build with VITE_API_BASE unset (or /api); the UI then works on any port the process manager picks. VERIFIED that the build succeeds without a frontend .env.
- Caution (READ): vite.config.js:24-26 inlines the build machine's process.env into the bundle where code references process.env. Run the frontend build with a minimal environment.

## Q12. Ollama license and bundling

- Ollama: MIT License, Copyright (c) Ollama (github.com/ollama/ollama LICENSE, fetched 2026-10-29).
- The Ollama distribution installed here (Linux v0.40.13, /usr/local/lib/ollama) ships the ollama binary (42 MB) plus a lib directory with llama-server, ggml and llama libraries and these notice files: LLAMA_CPP_LICENSE (MIT, ggml authors), LLAMA_CPP_VENDORS_LICENSE (MIT and BSD), MLX_LICENSE and MLX_C_LICENSE (MIT, Apple), GO_LICENSE (Go dependencies: MIT and Apache-2.0, 118 sections, no GPL, LGPL or MPL text found), DLPACK_LICENSE and XGRAMMAR_LICENSE (Apache-2.0), XGRAMMAR_NOTICE, FMT_LICENSE, CPP_HTTPLIB_LICENSE (MIT), PICOJSON_LICENSE (BSD). VERIFIED by listing the files and grepping license names.
- Since recent versions, ollama runs inference through a separate llama-server executable from its lib directory. Bundling means the whole binary plus lib directory, not one file (VERIFIED on Linux; LOCAL: list the macOS release archive contents).

What bundling requires (INFERRED from the license texts): include the MIT notices and every license and NOTICE file above in the app (for example Contents/Resources/ollama/licenses plus an About or Credits page). Apache-2.0 components require the NOTICE file to be passed on. No copyleft obligations found. Model weights carry their own licenses: bge-m3 MIT (VERIFIED via /api/show); Qwen chat models are typically Apache-2.0 (INFERRED; check each chosen tag with `ollama show --license`). AnythingLLM itself is MIT (upstream/LICENSE).

LOCAL: download the macOS release on the Mac and record its file list and license files; check that the signed binaries keep working after ad-hoc re-signing.

## Q13. Text splitting and the section override

Call path (READ, confirmed by server logs):

1. POST /v1/workspace/{slug}/update-embeddings or upload with addToWorkspaces calls Document.addDocuments (upstream/server/models/documents.js:85-161), which reads the document JSON from STORAGE_DIR/documents and passes it as `{...data, docId}` to the vector provider.
2. LanceDB addDocumentToNamespace (upstream/server/utils/vectorDbProviders/lance/index.js:312-415): `const { pageContent, docId, ...metadata } = documentData` (:320); checks the vector cache (:324-345); builds `new TextSplitter({ chunkSize, chunkOverlap, chunkHeaderMeta: TextSplitter.buildHeaderMeta(metadata), chunkPrefix })` (:351-365); splits pageContent; embeds; writes one row per chunk with the same document metadata on every chunk (:376-390); stores the vector cache (:406). Other vector providers do the same.
3. TextSplitter (upstream/server/utils/TextSplitter/index.js) wraps LangChain RecursiveCharacterTextSplitter (:193-209) with default separators `\n\n`, `\n`, space, empty string. Length is JavaScript string length (characters).

Settings:

- chunkSize = min(system setting text_splitter_chunk_size, embedder limit) (TextSplitter/index.js:47-57). For Ollama the embedder limit is EMBEDDING_MODEL_MAX_CHUNK_LENGTH, default 1000. A larger system setting is capped with a warning.
- chunkOverlap = text_splitter_chunk_overlap, default 20 (lance/index.js:359-362).
- VERIFIED from the log: RecursiveSplitter Will split with {"chunkSize":1000,"chunkOverlap":20,...}.

Heading awareness: none for any format. The splitter has a markdown separator preset but upstream never uses it (READ). Headings survive only as plain text for Markdown and HTML; PDF and DOCX lose them in the collector (Q14).

Chunk header (READ, VERIFIED in stored text): buildHeaderMeta picks only `title` (as sourceDocument), `published`, and `chunkSource` when it starts with link:// or youtube:// (TextSplitter/index.js:64-118). Format:

```
<document_metadata>
sourceDocument: manual.pdf
published: 10/29/2026, 7:05:59 AM
</document_metadata>

<chunk text>
```

The header is prepended after splitting (so a chunk can exceed chunkSize by the header length; the server logs this), is embedded with the text and is stored in the `text` column returned as sources. It cannot carry a section title or index without a patch. To get the section title into the embedded text without a patch, the shell can put it into `title` (for example `manual.pdf - 2 Installation`) or start pageContent with the heading line.

Override options:

| | (a) Server patch | (b1) Pre-split, upload with /v1/document/raw-text | (b2) Pre-split, write document JSON, then update-embeddings |
| --- | --- | --- | --- |
| How | Patch collector converters to keep structure, TextSplitter to split on sections, lance/index.js to attach per-chunk metadata | One raw-text call per section | Shell writes one JSON per section into STORAGE_DIR/documents/askfiles/ and posts their paths to update-embeddings |
| Patch size | 3 to 4 files in two packages, roughly 100 to 200 lines (INFERRED) | none | none |
| Upgrade risk | High: hot upstream paths | Low: documented API | Low to medium: relies on the documents folder and JSON shape the collector itself writes (stable, but not a documented API) |
| Section title, index, page in sources | Yes, if converters are patched too | No. Collector keeps only fixed keys; title becomes a slug with .txt (VERIFIED: title manual.pdf#s2 became manual.txt; sectionTitle, sectionIndex, pageStart dropped). Values must be packed into description or docSource strings | Yes, as real fields (VERIFIED) |
| Chunks never cross a section | Yes | Yes | Yes; long sections are sub-split by upstream and every sub-chunk carries the section fields |
| Re-embedding when a file changes | Whole file | Per section, but every upload gets a new uuid path, so the vector cache never hits | Per section. Deterministic names such as `<fileId>-<sectionHash>.json` make unchanged sections hit the vector cache (keyed by document path, upstream/server/utils/files/index.js:271-301); changed sections get new names; the shell removes stale ones with update-embeddings deletes and /v1/system/remove-documents |
| Parsing | Collector | Shell | Shell |

Experiment for (b2), VERIFIED: wrote manual-s1.json and manual-s2.json with the standard keys plus sectionTitle, sectionIndex, pageStart, pageEnd, sourcePath into STORAGE_DIR/documents/askfiles/, created a new workspace, posted update-embeddings with `adds: ["askfiles/manual-s1.json","askfiles/manual-s2.json"]`, then asked a question. The chat source came back as `{"id":...,"url":"file:///Users/x/Docs/manual.pdf","title":"manual.pdf",...,"sectionTitle":"2 Installation","sectionIndex":2,"pageStart":2,"pageEnd":2,"sourcePath":"/Users/x/Docs/manual.pdf","_distance":0.572,"score":0.428}`. Adding the same file to the existing workspace (whose table was created by collector documents) kept the standard fields and silently dropped the custom ones (no error).

Recommendation: (b2).

- No upstream patch; fits rule 1.
- Section title, section index and pages reach the chat sources as real fields.
- Section-bounded chunks by construction, and incremental re-embedding with vector-cache reuse.
- The shell needs a parser per format anyway for the browse view (phase 4, Q14), so retrieval and browse share one section split.

Conditions for (b2):

1. LanceDB fixes a workspace table's columns from the first rows inserted (VERIFIED by the experiment above; READ in @lancedb/lancedb dist/arrow.js:295). Every document in the library workspace must carry the same flat keys with the same types from the very first document; never mix collector uploads into that workspace; avoid null and nested values (INFERRED risk for type inference).
2. Keep the section document shorter than the effective embedding limit where possible (Q10). Longer sections are sub-split by upstream at chunkSize with overlap 20; each sub-chunk has the section metadata but no own page unless the shell splits at page boundaries.
3. /v1/workspace/{slug}/vector-search returns only a fixed metadata list and drops custom keys (upstream/server/endpoints/api/workspace/index.js:1008-1026, VERIFIED). The shell either maps results back by `id`/`text`, or uses a 1-line patch to pass the whole source through.
4. The shell writes into STORAGE_DIR/documents, which it owns. Use one folder (for example askfiles/) and file names without path separators.

## Q14. Structure in collector parsers, and OCR

Parsers (READ in upstream/collector/processSingleFile/convert, VERIFIED on fixtures where marked):

| Type | Library (version) | Structure reachable from the library | What the collector throws away |
| --- | --- | --- | --- |
| PDF | pdf-parse 1.1.4 with bundled pdf.js v1.10.100 (PDFLoader); pdf.js v2.0.550 for OCR | Yes: pdf.js has getOutline, getDestination, getPageIndex (pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js:3612-3634); text items carry font size and position | getOutline is never called; font sizes and positions reduced to line breaks (PDFLoader/index.js:31-44); page numbers dropped when pages are joined (asPDF/index.js:55). VERIFIED: the bookmarks of manual.pdf do not appear anywhere in the output |
| DOCX | mammoth 1.11.0 through LangChain DocxLoader | Yes with mammoth.convertToHtml or convertToMarkdown (Heading 1 to 6 become h1 to h6) | DocxLoader calls extractRawText, which drops heading levels, lists and tables. VERIFIED: handbook.docx came back as plain lines Policy handbook, 1 Leave, 1.1 Sick leave, 2 报销 with no level information |
| Markdown, txt, html, csv, json, org, adoc, rst | none, raw file read (asTxt.js:19) | Headings stay in the text verbatim | Nothing parsed. VERIFIED: notes.md kept `# Notes`, `## Budget`, `## 时间表` |
| XLSX | node-xlsx 0.24.0 | Sheet names; one document per sheet as CSV (asXlsx.js:112-150) | Cell formatting |
| PPTX, ODT, ODP | officeparser 4.2.0 | ODT headings exist in the XML (text:h) | Slide boundaries and numbers lost; headings flattened |
| EPUB | epub2 3.0.2 through LangChain EPubLoader | Chapter titles with splitChapters: true | Uses splitChapters: false; chapter titles dropped |
| Images (png, jpg, jpeg, webp) | tesseract.js 6.0.1 | | |
| Audio and video | local Whisper (@xenova/transformers, Xenova/whisper-small from Hugging Face) | | |

Supported extensions: upstream/collector/utils/constants.js:3-88 (.doc is not supported).

Smallest libraries for the shell's outline extraction (phase 4):

- PDF: pdfjs-dist (getOutline plus per-page text with positions). New dependency for the shell; already used inside the collector through pdf-parse, but at old versions.
- DOCX: mammoth (convertToHtml keeps headings). Same library the collector already ships. Chinese Word files often use localized style names (标题 1); mammoth's default style map matches style names (INFERRED; test with a Chinese fixture in Session 4.1).
- Markdown: no library needed; headings are in the raw text.

Collector limits and storage (READ, VERIFIED where marked):

- Body limit 3 GB on collector and server; no file size limit on document upload (upstream/server/utils/files/multer.js:93, :117).
- The server waits up to 600 s for the collector (upstream/server/utils/collectorApi/index.js:131).
- Parsed documents: STORAGE_DIR/documents/custom-documents/<name>-<uuid>.json (VERIFIED).
- XLSX goes to its own folder per file.

OCR (READ, VERIFIED where marked):

- When: PDFs only when no page has any text (asPDF/index.js:26-33). A PDF with some scanned pages never OCRs those pages. Images always. There is no setting to force or disable OCR.
- Languages: TARGET_OCR_LANG on the server, default eng, sent to the collector per request (upstream/server/utils/collectorApi/index.js:77). Chinese is not loaded by default; chi_sim and chi_tra are valid codes (upstream/collector/utils/OCRLoader/validLangs.js:41-42). VERIFIED: with the default, a scanned Chinese page came back as Latin garbage; with TARGET_OCR_LANG=eng,chi_sim it was recognized, with spaces between characters and some character errors (千 read as 干).
- Language data: tesseract.js reads STORAGE_DIR/models/tesseract/<lang>.traineddata (OCRLoader/index.js:25-33, cachePath), else downloads https://cdn.jsdelivr.net/npm/@tesseract.js-data/<lang>/4.0.0_best_int/<lang>.traineddata.gz (tesseract.js/src/worker-script/index.js:127-145). VERIFIED: the same files are published on the npm registry as @tesseract.js-data/eng and @tesseract.js-data/chi_sim (1.0.0); copying `4.0.0_best_int/<lang>.traineddata.gz` to STORAGE_DIR/models/tesseract/<lang>.traineddata makes OCR work offline. Sizes: eng 2.9 MB, chi_sim 1.7 MB (gzipped).
- Failure mode, VERIFIED: when the download fails (here because Node's fetch does not use the proxy), the tesseract worker error is uncaught and the collector process exits. The server then reports Document processing API is not online for every following upload until the collector is restarted.
- Workers: up to min(CPU count, 4) workers for PDFs, batches of 10 pages, 300 s overall timeout (pages finished by then are kept); one worker for images. Each page is rasterized from its first embedded image only.
- Time per page, VERIFIED on this 4 vCPU x86 container (A4 at 200 dpi, generated scans):

| Input | Languages | Time |
| --- | --- | --- |
| 1-page scanned PDF, English | eng | 4.76 s (collector log), 5.4 s end to end |
| PNG, English | eng | 4.30 s |
| 1-page scanned PDF, Chinese | eng,chi_sim | 8.80 s |
| 5-page scanned PDF, English | eng,chi_sim | 10.98 s total with 4 workers, about 2.2 s per page |

The single-page times include starting the workers. LOCAL: repeat on the Mac with a real scanned page; Apple Silicon should be faster per core (INFERRED).

## Q15. Section metadata through to sources; refusal behaviour

- Can chunk metadata carry a section title and index from upload to the vector store: yes with route (b2) of Q13, no with file upload or raw-text (fixed keys only). VERIFIED in Q13.
- Does the chat sources array return it: yes, every custom key of the document JSON appears in each source of /chat and of the final stream-chat event (VERIFIED). vector-search drops custom keys (VERIFIED).
- When query mode refuses because nothing passes the threshold: the response is `{"type":"textResponse","sources":[],"textResponse":"There is no relevant information in this workspace to answer your query.","close":true,"error":null}` with no chatId (VERIFIED with an unrelated question). The text is the workspace's queryRefusalResponse when set. No near-miss sources are returned; LanceDB drops rows below the threshold before they reach the chat (lance/index.js:198-206, READ).
- Search-only endpoint: POST /api/v1/workspace/{slug}/vector-search exists. It embeds the query and searches without calling the chat model, accepts its own scoreThreshold and topN, and returns `distance` and `score` (VERIFIED: scoreThreshold 0 returned ranked results with scores 0.13 and below for an unrelated question). The section-listing fallback can call it after a refusal. Because it drops custom metadata, the shell maps each result to its section by the document title or url it wrote, or with a one-line patch.

## Server boot sequence

READ in upstream/server/index.js and upstream/server/utils/boot/index.js, confirmed by the boot log (VERIFIED):

1. dotenv loads `.env` from the working directory (`.env.development` in development) (index.js:1-3).
2. SDK timeout patch (index.js:6), then `require` of modelPricing, which fetches https://models.dev/api.json when its cache is missing or older than 3 days (upstream/server/utils/helpers/modelPricing/index.js:69-79, :403).
3. Endpoint modules load. Side effects: ContextWindowFinder fetches https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json when stale (upstream/server/utils/AiProviders/modelMap/index.js:28-30); EncryptionManager may generate SIG_KEY and SIG_SALT and dumpENV.
4. Express: CORS for any origin, body limit 3 GB, /api router, developer API, then static server/public when not in development (index.js:67, :98-160).
5. listen(port) with no host (boot/index.js:67), then in the callback: migrateWebBrowsingToDefault, markOnboarded, setupTelemetry (PostHog unless DISABLE_TELEMETRY=true), new CommunicationKey (writes a new RSA pair to STORAGE_DIR/comkey every boot), EncryptionManager, BackgroundService boot, eagerLoadContextWindows (Ollama list and show), push notification VAPID keys (STORAGE_DIR/push-notifications), Telegram bot if configured.
6. Migrations: the server never runs them. They must be run before start with `prisma migrate deploy --schema=./prisma/schema.prisma` (upstream/docker/docker-entrypoint.sh:20-25). 41 migrations, last 20260520160208_init. VERIFIED: migrate deploy on an empty DB took 0.9 s.
7. Background jobs (Bree, child processes): cleanup-orphan-documents every 12 h, cleanup-generated-files every 8 h, cleanup-generated-images every 9 h; extract-memories and sync-watched-documents only if enabled (upstream/server/utils/BackgroundWorkers/index.js:29-61). VERIFIED in the log: Service started with 3 jobs.

## Collector

- Entry upstream/collector/index.js: dotenv, routes guarded by a signature check against STORAGE_DIR/comkey/ipc-pub.pem (skipped in development), listen(COLLECTOR_PORT) with no host, then wipes upstream/collector/hotdir and upstream/collector/storage/tmp (upstream/collector/utils/files/index.js:154-190).
- Supported file types, PDF extraction, OCR, limits and storage: see Q14.
- Production paths, VERIFIED: the collector reads uploads from its own hotdir (upstream/collector/utils/constants.js:1); the server writes them to path.resolve(STORAGE_DIR, "../../collector/hotdir") (upstream/server/utils/files/multer.js:16, :36; upstream/server/utils/files/index.js:22). With STORAGE_DIR at a data directory, uploads failed with ENOENT on <data>/../../collector/hotdir until a symlink was added.

## Workspace settings that affect retrieval

Table `workspaces` in upstream/server/prisma/schema.prisma:121-152. All writable through POST /api/v1/workspace/new and /update (upstream/server/models/workspace.js:41-59, validators :61-146). READ, with defaults VERIFIED in the workspace/new response.

| Setting | Column | Default | Valid values |
| --- | --- | --- | --- |
| Similarity threshold | similarityThreshold (line 132) | 0.25 | float clamped to 0..1; compared with score = 1 minus cosine distance |
| Snippet count | topN (line 135) | 4 | integer 1 or more |
| Chat mode | chatMode (line 136) | column default chat, but workspace/new sets automatic | chat, query, automatic. Use query; automatic can route to the agent |
| System prompt | openAiPrompt (line 131) | set from system setting default_system_prompt or a built-in default | any string; supports {datetime} |
| Temperature | openAiTemp (line 127) | null (provider default) | float 0 or more |
| Refusal text | queryRefusalResponse (line 140) | null (built-in text) | any string |
| Reranking | vectorSearchMode (line 141) | default | default or rerank. Rerank uses the native reranker (Xenova/ms-marco-MiniLM-L-6-v2), downloaded from Hugging Face on first use |
| History | openAiHistory (line 128) | 20 | 0 is treated as 20 in the chat paths |
| Model override | chatProvider, chatModel (lines 133-134) | null (use env) | provider key and model tag |

Reranker model (vectorSearchMode=rerank), for phase 2:

- Model: Xenova/ms-marco-MiniLM-L-6-v2, a cross-encoder (upstream/server/utils/EmbeddingRerankers/native/index.js:21-23), loaded with @xenova/transformers 2.17.2 AutoModelForSequenceClassification (:131-145).
- Source: https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2 ; fallback host https://cdn.anythingllm.com/support/models/ (:18).
- Size (VERIFIED with the Hugging Face API): onnx/model_quantized.onnx 23.1 MB, tokenizer.json 0.7 MB, vocab.txt 0.2 MB, configs under 5 KB; about 24 MB in total. INFERRED: transformers.js 2.x loads the quantized file by default. The full-precision onnx/model.onnx is 91 MB.
- Cache: STORAGE_DIR/models/Xenova/ms-marco-MiniLM-L-6-v2 (:24-30). Downloaded on the first rerank call.
- It is an English MS MARCO model (INFERRED from the model card name); its value on Chinese text must be measured in phase 2.
- Owner decision: reranking stays a phase 2 candidate and the model is not shipped yet. The phase 2 runs on the Mac download it once; if reranking improves the scores, Session B ships these files, otherwise reranking is dropped.

## Internet calls by default

| Call | When | Host | How to disable |
| --- | --- | --- | --- |
| Model pricing | Every boot if cache older than 3 days | models.dev | No variable. Patch, or pre-seed STORAGE_DIR/models/pricing with a fresh timestamp (INFERRED). VERIFIED: attempted at boot here (failed through the proxy, logged, not fatal) |
| Context window map | Every boot if cache older than 3 days | raw.githubusercontent.com | No variable. Patch, or pre-seed STORAGE_DIR/models/context-windows. VERIFIED: downloaded at boot here |
| Telemetry (PostHog) | Boot and 64 event sites | PostHog host (INFERRED app.posthog.com) | DISABLE_TELEMETRY=true. VERIFIED: log shows TELEMETRY DISABLED |
| Prisma CLI checkpoint | prisma commands | checkpoint.prisma.io (INFERRED) | CHECKPOINT_DISABLE=1 |
| Native embedder model | First embed when EMBEDDING_ENGINE is unset or native | huggingface.co, fallback cdn.anythingllm.com | EMBEDDING_ENGINE=ollama |
| Native reranker model | vectorSearchMode=rerank, or agent with more than 15 tools | huggingface.co | Keep default search mode or pre-seed; AGENT_SKILL_RERANKER_ENABLED=false |
| Tesseract language data | First OCR per language | cdn.jsdelivr.net | Pre-seed STORAGE_DIR/models/tesseract (VERIFIED) |
| Local Whisper | First audio upload | huggingface.co | Do not accept audio files |
| Puppeteer, link scraping | Link import, agent web browsing | user URLs, DuckDuckGo | Do not expose link import or agents |
| Community Hub | Opening that settings page | hub.external.anythingllm.com | Hide the page |
| Onboarding survey (browser) | Survey submit | onboarding.anythingllm.com | Keep onboarding marked complete |
| Link citation favicons (browser) | Rendering a link citation | www.google.com/s2/favicons | Only for link documents, which we do not create |

## Risks found

Ordered by impact on packaging.

| # | Risk | Evidence | Effect | Mitigation |
| --- | --- | --- | --- | --- |
| 1 | Upstream writes into its own code directories in production: SQLite DB in server/storage, server/.env by dumpENV, collector/hotdir and collector/storage/tmp; uploads use STORAGE_DIR/../../collector/hotdir | VERIFIED (Q2, Collector) | Inside a signed, read-only app bundle uploads and DB fail, or writing breaks the code signature (INFERRED) | Patches: DATABASE_URL in schema.prisma (1 line, VERIFIED); hotdir and collector tmp path from an env var (server files/index.js:22, multer.js:16 and :36; collector constants.js:1 and files/index.js:159 and :176); dumpENV path from an env var (updateENV.js:1717). Pass all config through the spawn environment |
| 2 | Any web page can call the local API: CORS reflects every origin and /api/system is open without AUTH_TOKEN | VERIFIED (Q4b) | Documents and API keys readable by a malicious site; breaks the privacy promise | Patch CORS to the shell's origin, in the same patch as the bind host; random ports help but are not a fix |
| 3 | Server and collector bind all interfaces | VERIFIED (Q4) | LAN exposure; Windows firewall prompt later | Bind-host patch (Session C) |
| 4 | Native modules and Prisma engines are per platform and some download at install time (sharp libvips, canvas prebuilds, ripgrep from GitHub; Prisma engines from binaries.prisma.sh) | VERIFIED (Q1) | A Linux build cannot be packaged for the Mac; install-time downloads can fail on CI | Install on macOS arm64 (CI macos-14 or LOCAL); ship server and collector outside asar; prune non-darwin binaries (onnxruntime other platforms, about 70 MB) |
| 5 | OCR language data downloaded on first use, and a failed download kills the collector | VERIFIED (Q14) | Scanned files fail offline, and every later upload fails until restart | Pre-seed eng and chi_sim traineddata from the npm packages into STORAGE_DIR/models/tesseract at first run; TARGET_OCR_LANG=eng,chi_sim; process manager restarts the collector on exit (already in Session C scope) |
| 6 | Two outbound requests at every boot with no switch | VERIFIED (Internet calls) | Breaks no request leaves the machine | Small patch to skip both when an env flag is set, or pre-seeded caches refreshed by the shell |
| 7 | Embedding input silently truncated at 2048 tokens by Ollama | VERIFIED (Q10) | Long Chinese sections partly unindexed without any error | Chunk maximum at or below about 2800 characters, or a 1-line patch adding num_batch |
| 8 | Bundle size: server 1.07 GB and collector 0.6 GB production node_modules on Linux | VERIFIED (Q3) | Large DMG | Prune other-platform binaries; drop mdpdf, canvas and puppeteer-core only if their code paths are hidden (INFERRED, needs care) |
| 9 | LanceDB table schema fixed by the first document | VERIFIED (Q13) | Section fields silently dropped if a collector upload lands first | One workspace written only through the section JSON route with fixed keys and types |
| 10 | Thinking output from qwen3 arrives inside textResponse; the /v1 chat routes cannot turn thinking off | VERIFIED (Q9), READ for the routes | Users see reasoning text; slower answers | Search page strips think blocks (Session D); presets disable thinking through a /v1 patch or use a model without thinking (Session E, owner choice) |
| 11 | Upstream UI redirects to onboarding whenever /api/onboarding fails | READ (Q5) | Onboarding pages and survey call during slow starts | Load the UI only after /api/ping; hide onboarding routes in the 1.9 patch |
| 12 | Native reranker downloads from Hugging Face | READ (Workspace settings) | Reranking on in phase 2 calls the internet | Phase 2 on the Mac downloads it once; Session B ships it only if it improves the scores |

## Commands verified in this environment

Environment: Ubuntu 24.04 x86_64, 4 vCPU, Node v22.22.0, yarn 1.22.22, Ollama 0.40.13 with qwen3:0.6b and all-minilm; bge-m3 pulled during the session. Outbound HTTPS through the session proxy.

Node version outcome: install, prisma generate, frontend build, migrate deploy, server and collector all worked on Node 22.22.0. No engine errors for Node; the only engine warnings name bare, pnpm (third-party package metadata). The Node 20 fallback was not needed and was not run. Server and collector also ran on Electron 45.1.0 (Node 24.22.1).

1. Fresh install from a clean copy of the three packages (node_modules removed), Node 22.22.0. All exit 0.

   ```
   export PUPPETEER_SKIP_DOWNLOAD=1
   cd upstream/server    && yarn install --frozen-lockfile   # 20 s with a warm yarn cache
   cd upstream/collector && yarn install --frozen-lockfile   # 11 s
   cd upstream/frontend  && yarn install --frozen-lockfile   # 17 s
   ```

   Warnings: server: resolution field form-data@4.0.4 incompatible with requested 4.0.0; engine pnpm appears to be invalid (@qdrant/js-client-rest, chart.js); @lancedb/lancedb 0.15.0 has incorrect peer dependency apache-arrow >=15 <=18.1.0 (installed 19.0.0, loads and works); unmet peers for zod, typescript, request, eslint; @datastax/astra-db-ts unable to read bin directory. Collector: engine bare appears to be invalid (bare-fs, bare-os); unmet peer ts-toolbelt; prettier peer. Frontend: unmet peers for @lobehub/icons (antd, react 19). No native build errors. @vscode/ripgrep postinstall needs GitHub release access; this environment seeds its cache (scripts/install_pkgs.sh, seed_ripgrep_cache) because api.github.com is refused by the proxy for unattached repositories.

2. Prisma client, using the local CLI. Exit 0.

   ```
   cd upstream/server && CHECKPOINT_DISABLE=1 ./node_modules/.bin/prisma generate
   ```

   Pitfall seen: running `npx prisma generate` before node_modules exists downloads the newest prisma (8.0.0-rc.28 here) instead of 5.3.1 and fails. Always run it after yarn install, or use the local binary.

3. Frontend build. Exit 0, 41 s, output upstream/frontend/dist (16 MB). Warnings: caniuse-lite outdated; fs, path, crypto externalized for piper-tts-web; chunk size warnings.

   ```
   cd upstream/frontend && yarn build
   rm -rf ../server/public && cp -r dist ../server/public
   ```

4. Migrations and start. The server needs a .env (or the same values in the environment); the values below are what was used.

   ```
   # upstream/server/.env
   SERVER_PORT=3001
   STORAGE_DIR=<data>/storage
   JWT_SECRET=<random>
   SIG_KEY=<random>
   SIG_SALT=<random>
   LLM_PROVIDER=ollama
   OLLAMA_BASE_PATH=http://127.0.0.1:11434
   OLLAMA_MODEL_PREF=qwen3:0.6b
   OLLAMA_MODEL_TOKEN_LIMIT=4096
   EMBEDDING_ENGINE=ollama
   EMBEDDING_BASE_PATH=http://127.0.0.1:11434
   EMBEDDING_MODEL_PREF=all-minilm:latest
   EMBEDDING_MODEL_MAX_CHUNK_LENGTH=1000
   VECTOR_DB=lancedb
   DISABLE_TELEMETRY=true
   TARGET_OCR_LANG=eng,chi_sim
   # upstream/collector/.env
   STORAGE_DIR=<data>/storage

   cd upstream/server && CHECKPOINT_DISABLE=1 ./node_modules/.bin/prisma migrate deploy --schema=./prisma/schema.prisma
   cd upstream/server && NODE_ENV=production node index.js
   cd upstream/collector && NODE_ENV=production node index.js
   curl http://127.0.0.1:3001/api/ping      # {"online":true} 200
   curl http://127.0.0.1:8888/              # OK 200
   ```

   migrate deploy: All migrations have been successfully applied, 0.9 s; DB created at upstream/server/storage/anythingllm.db (not under STORAGE_DIR). For uploads to work with STORAGE_DIR outside upstream/server/storage, `<data>/../../collector` had to be a symlink to upstream/collector (risk 1).

5. API flow: generate-api-key, auth, workspace/new, upload of PDF, DOCX, MD with addToWorkspaces, raw-text, chat, stream-chat, vector-search, update-embeddings with hand-written section JSON. Results in Q9, Q13, Q15.

6. Native module load under Node 22 and Electron 45.1.0. All OK under both.

   ```
   npm install electron   # 45.1.0, in a scratch directory
   cd upstream/server
   node native-load.js <upstream> <tmpdir>
   ELECTRON_RUN_AS_NODE=1 <electron>/dist/electron native-load.js <upstream> <tmpdir>
   ```

   native-load.js requires @prisma/client (and connects), @lancedb/lancedb (connects), @mintplex-labs/mdpdf, canvas (creates a canvas), sharp (server and collector), onnxruntime-node (server and collector), resolved from each package directory.

7. Full run under Electron: `ELECTRON_RUN_AS_NODE=1 electron index.js` for server and collector, then upload of a DOCX with embedding, OCR of a PNG, vector-search, and `ELECTRON_RUN_AS_NODE=1 electron node_modules/prisma/build/index.js migrate deploy`. All worked.

8. OCR: pre-seeded language data, then timed uploads of scanned fixtures (Q14).

   ```
   npm pack @tesseract.js-data/eng @tesseract.js-data/chi_sim
   # extract package/4.0.0_best_int/<lang>.traineddata.gz to <data>/storage/models/tesseract/<lang>.traineddata
   ```

   cdn.jsdelivr.net returned 403 through this environment's proxy, and Node's fetch here does not use the proxy, so without pre-seeding the first OCR crashed the collector.

9. Embedding experiments against Ollama: `ollama pull bge-m3`; POST /api/embed with options num_ctx and num_batch; /api/show for context length and dimension (Q10).

10. DATABASE_URL patch test on the scratch copy: schema line 15 changed to `env("DATABASE_URL")`, prisma generate, migrate deploy with DATABASE_URL set, client read (Q2). The scratch schema was restored afterwards.

To run on the Mac (LOCAL):

- Items 1 to 4 on macOS arm64 with the same commands, and record whether sharp, canvas and ripgrep downloads succeed.
- Item 6 with the Electron version Session B pins, against the darwin-arm64 install.
- `ls` of the macOS Ollama release archive and its license files (Q12).
- OCR timing of one real scanned page with eng,chi_sim (Q14).
- Production node_modules size on darwin-arm64 (Q3).
