# Session A: upstream analysis (plan task 1.1)

Executor: CLOUD
Dependencies: none
Branch: session/a-upstream-analysis
PR title: [Session A] Upstream analysis report

## Goal

Read the vendored AnythingLLM core in upstream/ and write docs/upstream-analysis.md that answers every question below with file paths and, where useful, line references. This report unblocks Sessions E and G and removes most of the risk from the first macOS package.

## Rules for this session

- Do not modify anything under upstream/.
- Do not change any other file except docs/upstream-analysis.md.
- Cite paths as upstream/server/..., upstream/collector/..., upstream/frontend/...
- When reading is not enough, write a small experiment, run it, and record the command and result. If an experiment cannot run here, say exactly what to run on the Mac.
- Separate what you verified from what you inferred. Label inferences.

## Questions to answer

| # | Question | Why it matters |
| --- | --- | --- |
| Q1 | Which native modules do server and collector load, and is each one N-API (prebuild-install, napi, node-gyp)? | Decides whether child processes can use Electron's Node as is, or need electron-rebuild |
| Q2 | Where does Prisma look for its query engine at runtime? Does it work from inside an asar archive, or must server/node_modules/.prisma and @prisma/engines be unpacked? | Known packaging failure mode |
| Q3 | Does the collector depend on puppeteer, playwright, or any package over 50 MB? List every dependency over 50 MB in server, collector and frontend with its size. | Bundle size; web scraping can be dropped |
| Q4 | What host do server and collector bind to? Is there an env variable or code path to force 127.0.0.1? | Local-only promise; Windows firewall prompt later |
| Q5 | How is onboarding completion persisted? Which table, column or setting makes the UI skip the provider picker? | The wizard must mark it done |
| Q6 | Do PDF chunks carry page numbers in metadata, and does the chat response's sources array expose them? | Decides whether citations can show a page |
| Q7 | List every env variable read by server and collector with its default: Ollama chat and embedding settings, chunk length, similarity threshold, snippet count, vector DB, telemetry, storage dir, JWT and signature keys. | Preset generator in Session E |
| Q8 | Is there a flag or setting that hides the LLM and embedder provider pages in the UI, or does it need a patch? | Plan task 1.9 |
| Q9 | For each API endpoint phase 3 needs (API key creation, workspace create, document upload, embed into workspace, chat with sources, streaming chat, thread list, document delete): route, auth header, request body, response shape, one example curl. | Session D client and Session G harness |
| Q10 | Which Ollama models and tags are suitable as a multilingual embedder (bge-m3 or similar)? What does the server require of an embedding model (dimension handling, max chunk length)? | Preset for Chinese documents |
| Q11 | In production, does the server serve the frontend from upstream/server/public? What VITE_API_BASE value does the frontend build expect for that? | Build script in Session B |
| Q12 | Which license applies to the Ollama binary and what does bundling it inside an app require? | Distribution |
| Q13 | Text is split into chunks at embed time by upstream/server/utils/TextSplitter, called from the vector database providers in upstream/server/utils/vectorDbProviders, not in the collector. Record the call path, the splitter class and its settings. Is the splitter heading-aware for PDF, Word and Markdown? TextSplitter prepends a header to every chunk: what goes into it, and can it carry the section title and section index? Describe the two ways to override the split: a patch to the server, or pre-splitting in the shell before upload (one uploaded document or text block per section). Recommend one with reasons: patch size, upgrade risk, whether page numbers and other metadata survive, and effect on re-embedding when a file changes. | Retrieval splits documents by section (docs/plan.md, Chunking) |
| Q14 | Which parsers in the collector expose PDF bookmarks or outlines, Word heading styles and Markdown headings? For each file type: the library, whether the structure is reachable from its output, and what the collector currently throws away. If none exposes it, name the smallest library that would. Also: the collector includes tesseract.js; when does OCR run on PDFs and images (always, only when a PDF has no text layer, or by setting), which languages it loads (Chinese included or not, and where the language data comes from), and what it costs in time per page, measured on one scanned page here. | Browse view (phase 4) builds outlines without a model |
| Q15 | Can chunk metadata carry a section title and section index from upload through to the vector store? Does the chat response's sources array return that metadata? When query mode refuses because nothing passes the threshold, are near-miss sources still returned, or is there a search-only endpoint (vector search without chat) the shell can call? | Source cards show the section title; section-listing fallback when nothing is found |

## Required step: Node version

Upstream targets Node 18 (upstream/.nvmrc pins v18.18.0; upstream/docker/Dockerfile builds the frontend on node:18-slim and the server on Node 18 from NodeSource). The shell uses Node 22. Run the full install and prisma generate on Node 22: yarn install in upstream/server, upstream/collector and upstream/frontend, npx prisma generate in upstream/server, then start server and collector once. Record the Node version, each command, and whether it worked, including warnings about engines or native modules. If anything fails on Node 22, repeat the same steps with /opt/node20/bin first on PATH and record the result. State the outcome in the report under Commands verified in this environment.

## Also record

- Server boot sequence: entry file, env loading order, migrations, static file serving, background jobs.
- Collector: supported file types, how PDF text is extracted, size limits, where parsed documents are stored.
- Workspace settings that affect retrieval (similarity threshold, topN snippets, chat mode, system prompt, temperature) and where they live (table and column).
- Everything in upstream that calls the internet by default (telemetry, update checks, model lists, remote assets) and the variable that disables each.
- The exact yarn and prisma commands needed to go from a fresh checkout to a running server and collector on Linux, verified by running them here.

## Acceptance

- docs/upstream-analysis.md exists; every Q has an answer or a named experiment with its result.
- The document ends with a section Risks found, ordered by impact on packaging, and a section Commands verified in this environment.
- PR opened with the session link in the body.
