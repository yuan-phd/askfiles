# [Session D] Search page and AnythingLLM API client

## What was done

- `src/renderer/api/client.js`: ES module, fetch only, no dependencies. Works in Electron, a plain browser and Node 22. Every function documents its route and response shape.
- `src/renderer/search/` (`index.html`, `search.css`, `search.js`): status bar (library folder, indexed count, indexing state), query box, streamed answer, source cards (passage, file name, section title and page when present, open button), hits from the same section merged into one card, section-listing fallback, recent questions. Enter submits, Shift+Enter adds a line, Escape clears. Enter is ignored while a Chinese input method is composing.
- Light and dark mode through CSS variables and `prefers-color-scheme`. System fonts only, no external resources. A CSP allows connections to 127.0.0.1 and localhost only.
- Config hook: reads `baseUrl`, `apiKey`, `workspace`, `folder` from `window.shellConfig`, otherwise from query parameters. With no key it creates one; with no workspace it finds or creates the hidden library workspace.
- Shell hooks for later sessions: `window.askfiles.setIndexStatus({ state, pending })`, `setFolder`, `refresh`. Open emits `askfiles:open-source` on window and calls `shellConfig.openSource` if present. Otherwise it logs `[search] open source {...}`.

## Upstream routes used (v1.19.0)

| Client function | Route |
| --- | --- |
| generateApiKey | POST /api/system/generate-api-key (internal route; works only single-user without AUTH_TOKEN) |
| checkAuth | GET /api/v1/auth |
| createWorkspace, ensureLibrary | POST /api/v1/workspace/new |
| listWorkspaces, ensureLibrary | GET /api/v1/workspaces |
| getWorkspace, listThreads | GET /api/v1/workspace/:slug (returns `workspace` as an array) |
| uploadDocument | POST /api/v1/document/upload (multipart, optional addToWorkspaces) |
| embedDocuments, removeDocuments | POST /api/v1/workspace/:slug/update-embeddings |
| removeDocuments (purge) | DELETE /api/v1/system/remove-documents |
| chat | POST /api/v1/workspace/:slug/chat |
| streamChat | POST /api/v1/workspace/:slug/stream-chat (SSE `data:` lines) |
| vectorSearch (fallback) | POST /api/v1/workspace/:slug/vector-search |
| listChats (recent questions) | GET /api/v1/workspace/:slug/chats?apiSessionId=&limit=&orderBy= |

## How it was tested

- `npm test`: 19 vitest unit tests for the client (SSE parsing including split UTF-8, think-block stripping, source normalization, section merging, refusal detection, routes and payloads).
- `npx playwright test`: 8 tests green in headless Chromium in this container.
  - Real server: the global setup boots upstream collector and server (minimal launcher, Session C not merged), creates a key and a workspace, uploads `test/fixtures/handbook.pdf` and embeds it. It then asks a question with real Ollama (`qwen3:0.6b`, `all-minilm`). It checks for a non-empty answer and a source card with the file name `handbook.pdf` and the passage text. Clicking Open must emit the event.
  - Mocked at the network level: card merging, refusal to section list, the fallback without section metadata, the empty fallback, keyboard, recent questions, indexing state, stream abort errors, and `shellConfig` taking precedence over query parameters.
  - Mutation check: breaking merge logic makes the merge and fallback tests fail.
- Screenshots: `SCREENSHOT_DIR=docs/screenshots/search npx playwright test`. The files are in `docs/screenshots/search/`: answer and fallback states in light and dark (mocked data with section titles and pages), plus `real-server-light.png` from the real server.

## Findings and decisions

- docs/upstream-analysis.md does not exist yet. I read the routes from `upstream/server/endpoints/api` directly.
- **Page and section title are not returned by stock upstream.** The PDF collector joins all pages into one document, and chunk metadata only carries document-level fields. Raw-text upload drops custom metadata keys. So the real-server test cannot show a page. It asserts that the card shows page and section exactly when the server sends them, and logs `page: false, section title: false` today. The client already reads `sectionTitle`, `sectionIndex` and `page` from source metadata or from the `<document_metadata>` chunk header, so Q13 and Q15 can choose either path without changing the page.
- **Fallback source:** in query mode a refusal returns `sources: []` (no near-miss sources). The fallback calls `vector-search` with `scoreThreshold: 0` and `topN: 8`. That lists the nearest chunks even below the workspace threshold that caused the refusal.
- **Refusal detection:** a refusal means no sources, or the answer text equals the workspace refusal. `ensureLibrary` sets `queryRefusalResponse` to a known text. It does not set threshold or topN; those stay with the phase 2 presets.
- Hits without section information are never merged, only de-duplicated.
- qwen3 streams `<think>` blocks. The page hides them and shows a progress line instead.
- Source `url` is the collector hotdir path, not the user's original file. The shell has to map it back to the original (task 3.5 / Session F).
- `GET /api/v1/workspace/:slug` returns the workspace as an array. The client unwraps it.

## Notes for other sessions

- In production mode the server writes uploads to `STORAGE_DIR/../../collector/hotdir`. The collector reads its own `hotdir`. A process manager must keep that layout or patch it. The e2e launcher uses a temp layout with a symlink.
- The Prisma schema hardcodes the SQLite path to `upstream/server/storage/anythingllm.db`, ignoring `STORAGE_DIR`. Session C needs a patch or `DATABASE_URL` handling for the data directory. The e2e tests use uniquely named workspaces for this reason.
- Q4 is still open: the server listens on all interfaces until the bind patch lands.

## Dependencies added

- `@playwright/test@1.63.0`: test runner for the required Playwright tests. Pinned to match the preinstalled Chromium.
- `vitest`: unit test runner named in CLAUDE.md.

## What is left / open questions for the owner

- A root `package.json` did not exist (Session B), so this one is minimal. Session B should merge its scripts into it. `npm run lint` does not exist yet.
- Recent questions come from the server chat history for the `askfiles-search` session id. Clearing them is not implemented.
- The visual pass (3.6) and the Electron wiring (3.5) are LOCAL.
- No git remote was configured in this session, so the branch `session/d-search-page` is committed locally only and no PR was opened.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_018TGyqBqxSv817tYJAe7ctd
