# AskFiles: Project Plan

Oct 28, 2026 · @mazax

## Goal and scope

Build AskFiles, a macOS app that lets a non-technical person search their own documents with a local model, get an answer with the source passage, browse their documents by section, and never need a setting (Session K adds a Settings page with four plain controls; the defaults stay decided from the hardware). AnythingLLM is the backend, our own shell and interface are the product.

**Target user**: someone with no AI or software knowledge, on an Apple Silicon Mac with 8 to 32 GB RAM, who has a folder of documents (PDF, Word, Excel, Markdown) in Chinese and English and wants to find things in them. They install by double-clicking and never open a terminal.

**Two requirements that drive every decision**

1. Local and private: documents and questions never leave the machine. A cloud model is never used unless a later phase adds explicit per-question opt-in.
2. Foolproof: no model choice needed, no parameters, no server to start. Model, embedder, thresholds and chat mode are decided for the user from their hardware. Since Session K (owner decision 2026-10-30) a Settings page offers exactly four controls with plain explanations: answer scope, answer model (Faster or Better, the two tiers nearest the machine), context length and reindex; nothing else is exposed.

**In scope for phase 1 to 4**: macOS arm64 only, libraries (All files plus any the user creates; Session K), search with cited sources, folder watching, a browse view that renders documents and their outlines without a model, unsigned local distribution (USB or LAN copy).

**Not in scope now**: Windows (phase 5), Apple notarization, auto-update, multi-user, agents, cloud providers, Intel Macs.

**Executor labels used in this plan**

| Label | Meaning |
| --- | --- |
| CLOUD | Claude Code cloud session (Linux container, no GUI, no Mac). Spend the promotional credits here before 2026-11-04. |
| LOCAL | Claude Code on your own Mac, for anything that needs macOS, a GUI or a packaged app |
| CI | GitHub Actions macOS runner, free on a public repo; produces the DMG and runs smoke tests |
| YOU | Your judgment or time: choosing test documents, scoring answers, user testing |

## Decisions already made

These were settled in discussion and are not reopened unless the analysis session finds a blocker.

| Decision | Choice | Reason |
| --- | --- | --- |
| Product name | Display name AskFiles; identifiers, repository, package and directory names lowercase askfiles | One name everywhere; lowercase where case-sensitive tools are involved |
| Bundle id | io.askfiles.desktop | Stable identifier for macOS, codesign and the data directory; never changes after the first real user |
| macOS data directory | \~/Library/Application Support/AskFiles | Standard location for per-user app data on macOS; logs go to \~/Library/Logs/AskFiles |
| Backend | AnythingLLM open-source core (frontend, server, collector), MIT | Mature RAG: workspaces, query mode that refuses when nothing is found, similarity threshold, snippet limit, document pinning, LanceDB reranking, citations, full REST API. Each library is one hidden workspace (Session K; one library before it); users see libraries, never workspaces |
| Why not Jan | Rejected as base | Chat-first product; documents are attachments; retrieval is undocumented; no document API to build a search UI on |
| Why not use AnythingLLM Desktop as is | Rejected | Its Electron shell and bundled engine are closed source, so the UI and defaults cannot be changed |
| How upstream is consumed | Git subtree pinned to a release tag, never forked | Cloud sessions clone only the repositories attached to the session, so a submodule cannot be fetched there; the subtree keeps upstream inside this repository. Pull new tags without merge conflicts; shell code lives in our own repo |
| Shell | Electron | Server and collector are Node; Electron runs them as child processes with ELECTRON\_RUN\_AS\_NODE, no second runtime |
| Inference engine | Bundled Ollama CLI binary inside the app bundle | AnythingLLM has a mature Ollama provider for both chat and embeddings; ollama pull handles resumable model download; same design as upstream desktop. Users never install Ollama themselves |
| Alternative engine | llama-server from llama.cpp, two processes | Only if Ollama bundling is rejected; needs our own model download and checksum code |
| Platform | Apple Silicon only in phase 1 | Metal acceleration, one binary set, no Intel testing |
| Signing | Ad-hoc codesign, no Apple Developer account | Required for arm64 binaries to run at all; USB or LAN copies open without warnings; internet downloads need one trip to Privacy and Security on macOS 15 |
| Distribution | DMG copied by USB or LAN | No notarization, no auto-update in phase 1 |
| Embedder | Multilingual embedding model served by Ollama, not the default all-MiniLM-L6-v2 | Upstream docs say the default English embedder does poorly on Chinese |
| Chat mode | Query mode by default | Answers only from documents, says so when nothing is found |
| Chunking | Split documents by section, not by fixed length. Chunk maximum large enough that a typical section fits in one chunk; a longer section is split into sub-chunks that all carry the section title and section index; the interface merges hits from the same section | Sections are the unit people think and cite in; source cards can name the section; when the model cannot answer, the matching sections are still a useful result. Trade-off: larger chunks mean fewer snippets fit in the context window, so chunk maximum and snippet count are tested together in phase 2 |
| Section chunking implementation | The shell splits documents itself: it parses PDF and Word for headings and pages, writes one document JSON per section into the server storage with section title, section index and page numbers in its metadata, then calls update-embeddings. No upstream patch | Upstream drops page numbers and headings and its splitter is not heading-aware; custom metadata in the document JSON reaches the chat sources unchanged (docs/upstream-analysis.md Q6, Q13, Q15) |
| Interface | Phase 1 uses the upstream frontend to validate retrieval; phase 3 replaces it with our own search page calling the API | Avoid building UI before thresholds and models are chosen |
| No compiled wiki | No LLM-written pages about the documents; the browse view (phase 4) renders the documents themselves | Compilation needs a large model, a large model means the cloud, and that breaks the privacy promise; local small models are not accurate enough and the pages are hard to maintain |
| Answer pipeline | The shell owns retrieval, prompt assembly and the model call (src/main/answer, Session L). Upstream remains the document store, parser, OCR, embedder and vector database; upstream code is not modified and its chat route is no longer used by the app. Candidates come from upstream vector search (no score floor) and from a keyword index over the shell's section records (BM25), fused by reciprocal rank and grouped into sections; a cross-encoder reranks the sections; the answer scope picks how many the model reads; the model gets numbered sources without file names or pages and cites [n]; source cards come from the section records only | Owner's test on a real corpus, 2026-10-30, 10 questions: 2 pass, 4 partial, 4 fail. Vector-only retrieval missed exact terms the keyword index finds; many similar passages crowded out the few sections that prove the answer; the model attributed one file's text to another when it wrote the citations itself |
| Reranker | A cross-encoder per RAM tier in the preset (answer.rerankerModel): 8 GB Xenova/ms-marco-MiniLM-L-6-v2 (English only, 23 MB) with the CJK bypass (no reranking when the question or a candidate section is mainly Chinese; selection by fusion score, no floor); 16 GB Xenova/bge-reranker-base (Chinese and English, 296 MB); 32 GB and up onnx-community/bge-reranker-v2-m3-ONNX (multilingual, 588 MB). The bge tiers rerank 8 candidate sections. Not bundled in the DMG: the first-run wizard downloads the files from huggingface.co at a pinned revision with sha256 checks into the data directory, like the Ollama models, with progress; a library set up before this fetches it once in the background. Nothing is downloaded while answering. Runs in a child process of the app binary, because onnxruntime-node blocks its thread for the whole model call; the process ends after 15 minutes idle on every tier (owner decision 2026-10-30) and the next question pays the reload once (bge-reranker-base about 3 s, v2-m3 about 14 s in the container) | Owner decision 2026-10-30 (Session L). v2-m3 needs about 2.7 GB of RAM, which the 8 GB tier does not have. bge-reranker-base matched v2-m3 on both fixture corpora (table under Phase 2, Answer pipeline) at a third to a sixth of the time, so it takes the 16 GB tier |
| Libraries | A library is one upstream workspace plus the shell's records under the data directory (sources, index.json, browse index, copies of added files). All files exists from the first launch and cannot be renamed or deleted; the user creates, renames and deletes others. Content comes in by Add files (copied into the library's own folder), Add folder (linked, watched, never modified) or drag and drop. First run asks for no folder | Owner's first real use (2026-10-30): a forced folder choice and a single library did not fit how documents are kept. Decided with the owner when Session K started |
| Settings | Settings page with Answer scope, Answer model, Context length, Reindex; values in shell.json, applied through the presets code (src/main/settings.ts has the mapping). Answer model: Better is this Mac's tier, Faster the tier below; the lowest tier has no Faster. Context length: 4K, 8K, 16K tokens. A Developer page with the raw preset values exists only with ASKFILES\_DEVELOPER=1 | Owner decision 2026-10-30 (Session K); answer scope is consumed by Session L's answer pipeline |
| Telemetry | DISABLE\_TELEMETRY=true | Privacy promise |
| Windows | After the Mac build has real users | Engine packaging and process management differ; no Windows test machine today |

## Architecture

&#91;embedded content: architecture: 1 window, 3 local processes, 3 data stores\]

The window talks only to the server over its REST API. The server calls the collector to parse files and Ollama to run the chat and embedding models. The main process owns the lifecycle of all three and the folder watcher. Nothing listens outside 127.0.0.1 and no request leaves the machine.

**Data layout on disk**

| Location | Contents |
| --- | --- |
| \~/Library/Application Support/AskFiles/storage | server/.env, SQLite database, LanceDB vectors, copies of parsed documents, document cache |
| \~/Library/Application Support/AskFiles/ollama | Model files pulled on first run, several GB |
| \~/Library/Logs/AskFiles | main process, server, collector and Ollama logs |
| User folder | Never modified; read by the watcher only |

**Startup sequence**: allocate three free ports, write .env if missing, start Ollama and wait for /api/tags, start collector and wait, run prisma migrate deploy, start server and wait for /api/ping, open the window. Shutdown reverses it with SIGTERM, then SIGKILL after 5 seconds.

## Phase 1: the macOS shell

Outcome: an unsigned DMG that installs by drag and drop, downloads a model on first run, and opens the upstream AnythingLLM interface already connected to a local model. Tasks 1.2 to 1.6 can run in parallel once 1.1 has reported.

| # | Task | Deliverable | Acceptance | Executor |
| --- | --- | --- | --- | --- |
| 1.1 | Analyze upstream at the pinned tag: server boot sequence, server/.env.example, collector dependencies, frontend build, native modules, onboarding flow, bind host, PDF page metadata, text splitter, outline sources, chunk metadata | Written report in the repo (docs/upstream-analysis.md) answering every open question in this plan | Every open question has an answer or a named experiment | CLOUD |
| 1.2 | Repo skeleton: Electron app with productName AskFiles and appId io.askfiles.desktop, electron-builder config, submodule at the tag, build script that builds frontend to server/public, installs server and collector, runs prisma generate, keeps only darwin-arm64 Prisma engines, prunes dev dependencies | scripts/build.sh, package.json, electron-builder.yml | Script runs clean on Linux up to the packaging step; packaging step runs on macOS | CLOUD, then LOCAL for the first real package |
| 1.3 | Process manager: free port allocation for Ollama, collector and server; .env generation on first run with JWT\_SECRET, SIG\_KEY, SIG\_SALT; ordered start with health checks (Ollama /api/tags, collector, server /api/ping); prisma migrate deploy before server start; SIGTERM then SIGKILL on quit; crash restart with backoff; logs to \~/Library/Logs/AskFiles | src/main/process-manager with unit tests; platform-agnostic so Linux binaries can run it in CI | Integration test boots Linux Ollama, collector and server in the container and gets 200 from /api/ping | CLOUD |
| 1.4 | First-run wizard: read total RAM, map to model tier, run ollama pull for chat and embedding models with progress, write .env, mark upstream onboarding complete, then launch | src/main/wizard, renderer page shown before the main window | Unit tests for tier mapping and .env output; manual run on Mac | CLOUD for logic and tests, LOCAL for the visual run |
| 1.5 | Preset configuration written into server/.env: LLM\_PROVIDER=ollama, OLLAMA\_BASE\_PATH, OLLAMA\_MODEL\_PREF, OLLAMA\_MODEL\_TOKEN\_LIMIT, EMBEDDING\_ENGINE=ollama, EMBEDDING\_MODEL\_PREF, EMBEDDING\_MODEL\_MAX\_CHUNK\_LENGTH, VECTOR\_DB=lancedb, DISABLE\_TELEMETRY=true, TARGET\_OCR\_LANG=eng,chi\_sim, server bound to 127.0.0.1 | config/presets.json plus a generator | Variable names verified against .env.example by task 1.1 | CLOUD |
| 1.6 | Model manager page in the shell: list, download, switch, delete, wrapping ollama commands | src/renderer/models | Works against a running Ollama in CI | CLOUD |
| 1.7 | Packaging: electron-builder DMG, asar with unpack rules for native modules, bundled Ollama in Resources, ad-hoc codesign of the whole bundle | DMG artifact | App launches from /Applications on a clean Mac; copies to a second Mac by USB and opens without warnings | LOCAL first, then CI |
| 1.8 | GitHub Actions workflow on macos-14: build, package, ad-hoc sign, upload DMG, smoke test (open the app, curl /api/ping, upload a PDF, one chat call) | .github/workflows/mac.yml | Green run on a public repo | CLOUD writes it, CI runs it |
| 1.9 | Hide the upstream LLM and embedder settings pages so users cannot break presets | Small patch file applied at build time, or an env flag if upstream has one | Settings pages absent in the packaged app | CLOUD |

**Hidden work to budget for** (found during 1.7 in most Electron projects): native module ABI, Prisma engine path inside asar, collector pulling puppeteer or other heavy packages, port already in use on relaunch, orphaned ollama process after a crash. Task 1.1 exists to surface these before they cost a day each.

## Phase 2: retrieval presets and accuracy testing

Outcome: one preset per RAM tier, chosen from measured results, with a known rate of correct answers and correct refusals on two corpora that mirror real use. This phase is mostly your time; cloud sessions prepare the harness.

**Chunking design** (decided; see Decisions already made): documents are split by section, not by fixed length. The chunk maximum is large enough that a typical section fits in one chunk. A section longer than the maximum is split into sub-chunks that all carry the section title and section index, and the interface merges hits from the same section into one result. Source cards show file name, section title and page. When the model cannot answer, the answer lists the matching sections so the user can read them. Upstream splits text at embed time in upstream/server/utils/TextSplitter, so the override is either a server patch or pre-splitting in the shell before upload; Session A Q13 decided for pre-splitting in the shell (see Section chunking implementation under Decisions already made). Trade-off: larger chunks mean fewer snippets fit in the context window, so chunk maximum and snippet count are tested together, never one at a time; the embedder's maximum input length must also be at least the chunk maximum. Upstream measures chunk sizes in characters, not tokens: TextSplitter defaults to chunkSize 1000 and chunkOverlap 20, and EMBEDDING\_MODEL\_MAX\_CHUNK\_LENGTH is also in characters. Measured with bge-m3 (docs/upstream-analysis.md Q10): Chinese text is about 0.68 tokens per character and English about 4.6 characters per token. Ollama truncates embedding input at 2048 tokens without an error, so a 3000 character Chinese chunk is cut. Until the embedding context can be raised, the chunk maximum candidates are 1500, 2000 and 2500 characters.

**Parameters under test** (all live in server/.env, library settings or the shell's splitter; defaults are starting points, not decisions)

| Parameter | Starting value | Candidates |
| --- | --- | --- |
| Chat model by RAM tier | 8 GB: 4B class Q4; 16 GB: 8B class Q4; 32 GB and up: 14B class Q4; Qwen family for Chinese | Confirm with task 1.1 what Ollama offers at the tag date |
| Embedding model | Multilingual model via Ollama (bge-m3 class) | One alternative multilingual model |
| Similarity threshold | Medium | No restriction, Low, Medium, High |
| Max context snippets | 4 | 4, 6, 8, tested in combination with chunk maximum |
| Chunk strategy | By heading | By heading |
| Chunk maximum | 2000 characters | 1500, 2000, 2500 characters (capped by the 2048 token embedding limit), tested in combination with max context snippets |
| LanceDB reranking | Superseded | The upstream chat route is no longer used (Decisions, Answer pipeline); the shell reranks sections itself. Still selectable for the upstream-route comparison (rerank.json with --upstream) |
| Answer pipeline values | config/presets.json answer block | Section count and rerank floor per answer scope, and the scope mapping, are what phase 2 tunes (table below); vector top-k, keyword top-k, RRF k, candidate sections and the section cap are set generously and rarely worth changing. docs/eval.md lists every value with its effect |
| Chat mode | Query | Query only |
| Temperature | 0.1 | Fixed |
| Thinking | Off where the provider supports it | Fixed. The upstream Ollama provider can send think false, but the /v1 chat routes the shell uses do not pass that option (docs/upstream-analysis.md Q9). Decided: Session C patch 7 passes it through the /v1 chat routes, and the preset sets DEFAULT\_REASONING\_EFFORT=off. The Ask page's pipeline sends think false to Ollama directly and strips think blocks regardless |
| System prompt | Answer only from the provided context, cite the source, say you do not know when the context does not contain the answer | One stricter variant |

**Answer pipeline** (Session L; docs/app.md, Answer pipeline; docs/eval.md for the tuning loop)

Answer scope maps to the number of sections the model reads and the lowest rerank score a section needs. Starting values, the same in every tier; phase 2 tunes them with the stage 1 sweep of the eval. Read through the bridge from the settings store Session K adds; Balanced until it exists.

| Answer scope | Sections (sectionCount) | Rerank floor (rerankFloor) |
| --- | --- | --- |
| Strict | 2 | 0.5 |
| Balanced | 3 | 0.1 |
| Broad | 5 | 0.01 |

Reranker comparison on the fixture corpora (test/fixtures/eval-s and eval-l, 13 answerable questions in all, all-minilm embedder, CJK bypass off, 8 candidate sections), 2026-10-30, measured in the cloud container (4 vCPU x86, Linux, while the stack ran beside it). Target section hit is the share of answerable questions whose expected sections were all among the selected sections, at floor 0:

| Reranker | Files | S: 1 section | S: 3 sections | L: 1 section | L: 2 sections | Rerank time per question (8 sections) | RAM |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ms-marco-MiniLM-L-6-v2 | 24 MB | 5/8 | 5/8 | 3/5 | 3/5 | 0.5 s (8 sections at the 512 token limit) | 0.4 GB |
| bge-reranker-base | 296 MB | 5/8 | 6/8 | 3/5 | 5/5 | 1.8 s (L) | 1.4 GB |
| bge-reranker-v2-m3 | 588 MB | 5/8 | 6/8 | 3/5 | 5/5 | 5.9 s (S), 11.7 s (L) | 2.7 GB |

Chinese: to an English question MiniLM scores a Chinese answer passage 0.000. To a Chinese question (scripts/bench-reranker.mjs) MiniLM scores the answer 0.999 but an unrelated Chinese passage 0.801, while bge-reranker-base gives 0.999 and 0.000; MiniLM's Chinese scores do not separate relevant from unrelated, which is why the 8 GB tier bypasses it for Chinese. The fixtures are small; the comparison is repeated on the owner's corpora with the eval (--set rerankerModel=...). Timings on the CI Mac (GitHub macos-14 runner, a virtualized M1 with 3 cores and 7 GB; scripts/bench-reranker.mjs in the mac workflow, PR 11 run 41088006962, 2026-10-30), per question, median of 3, sections at the 512 token limit, half English and half Chinese, each model in its own process:

| Reranker | Files | First load and first call | 8 sections | 12 sections | Process RSS | English answer / unrelated | Chinese answer / unrelated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ms-marco-MiniLM-L-6-v2 | 24 MB | 0.7 s | 1.3 s | 1.9 s | 443 MB | 1.000 / 0.000 | 0.999 / 0.801 |
| bge-reranker-base | 296 MB | 3.5 s | 7.6 s | 11.5 s | 1489 MB | 0.995 / 0.001 | 0.999 / 0.000 |
| bge-reranker-v2-m3 | 588 MB | 10.2 s | 27.9 s | 40.9 s | 1228 MB | 0.991 / 0.000 | 0.995 / 0.000 |

The runner is 3 to 4 times slower than the 4 vCPU Linux container on these models, and a real Mac with more performance cores is expected to be faster than both; that is unverified. At these runner timings bge-reranker-base adds about 8 s and v2-m3 about 28 s to every question of the 16 GB and 32 GB tiers. Measure on the owner's Mac before freezing the reranker per tier (phase 2).

**Tasks**

| # | Task | Executor |
| --- | --- | --- |
| 2.1 | Assemble two corpora that mirror real use. Corpus S: 10 to 20 small files of a few pages each. Corpus L: 3 to 4 large files of several tens of pages each. Both contain Chinese and English, at least one scanned PDF, one Word file, and one spreadsheet with a table. Corpus S also contains two near-duplicate versions of one file | YOU |
| 2.2 | Write 40 questions with ground truth, source file, section and page, spread over both corpora, across seven categories: single fact; fact in the middle of a long document; cross-document synthesis; table numbers, dates, amounts; absent answer (related but missing, and unrelated); version question (what v1 and v2 each say); section listing (the expected result is the list of relevant sections rather than a synthesized answer). Claude can draft questions from the documents, you validate them | YOU with CLOUD help |
| 2.3 | Test harness: a script that sets up the library through the AnythingLLM API, splits, uploads and embeds a corpus with the chunk strategy under test, runs every question, stores answer, sources (file, section, page) and timing in a CSV | CLOUD |
| 2.4 | Run the harness per corpus, per candidate configuration and per model tier, two passes each for variance | LOCAL (needs the Mac and Metal) |
| 2.5 | Score: correct, partial, wrong, refused; for absent questions, correct refusal or hallucination; for section listing, whether the expected sections are listed; citation points to the right document, section and page; first token and total latency; indexing time; app memory | YOU |
| 2.6 | Freeze presets per tier, including chunk maximum and snippet count, into config/presets.json and record the measured rates in this document | CLOUD |

**Pass criteria to aim for** (adjust after the first run): 80 percent correct on single fact and table questions at the 16 GB tier, 90 percent correct refusals on unrelated questions, 70 percent on related-but-absent questions, expected section listed on 80 percent of section listing questions, citation correct whenever the answer is correct. Reported separately for corpus S and corpus L.

**User test**: give the DMG by USB to one or two real target users with a one-page task sheet (install, add a folder, ask five questions). Do not help. Record where they stop and time to first answer. Executor: YOU.

## Phase 3: own search interface and folder watching

Outcome: the window loads our page instead of the upstream frontend. The user sees one folder, one search box, an answer, and the source passages. AnythingLLM runs headless behind the API.

**Interaction model** (replaced by Session K, 2026-10-30): search, not chat. The user works in libraries: All files exists from the first launch, more can be created, renamed and deleted from the library switcher in the top bar. A library holds sources: files added by copy and folders linked and watched, each listed with a remove action; drag and drop anywhere in the window adds to the current library. The top bar stays fixed and holds the library switcher (name, indexed count, state), the Add button and the Ask and Browse switch. A library without sources shows one sentence and the Add button. A Settings page has four controls and nothing else. Every answer shows the source passage, file name, section title and page when available, and a click opens the original file. When nothing is found, the page lists the matching sections instead of an empty refusal.

| # | Task | Deliverable | Acceptance | Executor |
| --- | --- | --- | --- | --- |
| 3.1 | API client: library setup, document upload, embed, chat with streaming, sources parsing including section title and index, thread history | src/renderer/api with tests against a running server | All calls covered by tests in the container | CLOUD |
| 3.2 | Folder watching in the shell: the current library's sources (since Session K several folders per library, plus its own folder of added files); new, changed and deleted files are split by section, uploaded, re-embedded or removed through the API; index status per file | src/main/watcher with tests | Add, edit, delete a file and see the index update within one minute | CLOUD |
| 3.3 | Search page: query box, streaming answer, source cards with passage, file name, section title and page, hits from the same section merged into one card, think blocks stripped from the answer, section-listing fallback when nothing is found, open original in Finder, recent questions, index status bar | src/renderer/search as plain HTML, CSS and JS | Playwright tests in headless Chromium against a seeded server | CLOUD |
| 3.4 | Onboarding page: pick the folder, show model download and indexing progress, then the search page | src/renderer/onboarding | Flows end to end in CI smoke test | CLOUD |
| 3.5 | Swap the shell to load our page; keep a hidden developer switch to open the upstream frontend for debugging | Shell config | Packaged app opens on the search page | LOCAL |
| 3.6 | Visual pass on your Mac: typography, spacing, dark mode, the look you had in your HTML and Obsidian work | CSS | Your sign-off | YOU with LOCAL |

**Design notes**

- Page-level citations depend on upstream keeping page metadata when parsing PDFs; task 1.1 confirms. If absent, cite file, section and passage and show the passage text in full.
- Section titles on source cards depend on chunk metadata carrying them through to the chat sources array (Q15). If upstream drops them, the shell maps a chunk back to its section from its own split record.
- Keep the API usage to documented endpoints so upstream tag updates do not break the page.
- The page is plain HTML, CSS and JS inside Electron. No framework required; the upstream React app stays untouched in the submodule.

## Phase 4: browse view

Outcome: the user can read and navigate their documents without asking a question. Render only: no model is called, nothing is generated, every word on screen comes from the user's own files. Built in the shell on the same section split as retrieval, so search hits and browse pages point at the same sections.

| # | Task | Deliverable | Acceptance | Executor |
| --- | --- | --- | --- | --- |
| 4.1 | Outline extraction per document: PDF bookmarks, Word heading styles, Markdown headings, using the parser findings from Q14; documents without any of these get a flat outline of page or sheet numbers | src/main/outline with unit tests on fixture files of each type | Outline matches the source structure for every fixture, Chinese and English | CLOUD |
| 4.2 | Document page: one page per document with the original text and its outline as navigation; a search hit or source card links to its section here | src/renderer/browse | Playwright test opens a document and jumps to a section | CLOUD |
| 4.3 | Library index page: every document with its outline, expandable | src/renderer/browse | Playwright test against the corpus S fixture | CLOUD |
| 4.4 | Cross-document heading index: normalize headings (case, whitespace, full-width and half-width punctuation, leading numbering such as 1.2 or Chinese chapter numbering), group sections with the same normalized heading across documents, show them side by side | Normalizer with unit tests; index page in src/renderer/browse | Near-duplicate files in corpus S line up section by section | CLOUD |
| 4.5 | Keyword full-text search over all chunks, results grouped by document and section; Chinese matched by substring or character n-grams since it has no word spaces | Index in the shell built from the section split, Node built-ins preferred; search box on the browse pages | Unit tests for Chinese and English matching; Playwright test for grouping | CLOUD |
| 4.6 | Visual pass on your Mac for the browse pages | CSS | Your sign-off | YOU with LOCAL |

**Session K changes to phase 4 and the splitter** (2026-10-30, from the owner's first real use): the browse view has a fixed left sidebar (Library, Headings, Find, Document) and a content area that scrolls on its own; Document appears once a document is open, labelled with the file name and with the nested outline below it, and opening a document never changes the state of the other three pages. Headings lists only headings found in two or more documents. The splitter rejects heading candidates longer than 120 characters, ending like a sentence, with under 60 percent letters or CJK characters, or mostly punctuation or digits (question marks are allowed); a document with no outline and no acceptable heading is split by page. Section records (index.json) carry the heading level, the full heading path and, for PDFs with printed page labels, the label next to the page index; the section document JSON keeps its keys, because LanceDB fixes a table's columns from its first rows. Word headings come from styles.xml (Heading 1 to 6 in any case, Title, Subtitle, Chinese names, outline levels, styles based on these) and from outline levels set on a paragraph. Scanned PDFs are OCRed page by page (page images taken out with pdfjs and sent to the collector as PNG, up to four pages at once like the collector itself), so every section carries its page. xlsm, xls (SheetJS 0.20.3) and csv are accepted. SPLITTER\_VERSION 2 makes every library reindex once after the update.

## Later phases

**Phase 5: Windows build.** Start only after the Mac build has been used by real people. Adds roughly 30 to 40 percent on top of phase 1, concentrated in engine packaging and process management.

| Item | What changes from Mac | Executor |
| --- | --- | --- |
| Packaging | electron-builder NSIS installer or portable zip, built on a Windows runner; never cross-compiled from Mac because native modules need Windows binaries | CLOUD writes config, CI builds |
| Engine | Ollama Windows package is ollama.exe plus a lib folder with CUDA and ROCm runtimes; ship CPU and CUDA only, drop AMD | CLOUD |
| Native modules | Prisma Windows engine; confirm win32-x64 prebuilds for LanceDB and onnxruntime | CLOUD in task 1.1 style analysis |
| Process management | No SIGTERM or process groups; use taskkill /T /F to kill the tree so ollama.exe does not linger | CLOUD with tests |
| Paths | LOCALAPPDATA\\AskFiles for data; asar to avoid the 260 character path limit | CLOUD |
| Firewall | Bind server and collector to 127.0.0.1 only, otherwise Windows prompts on first launch | Already done in task 1.5 |
| Signing | Unsigned works: SmartScreen shows More info, Run anyway; no admin needed. Certificate or Azure Trusted Signing later | YOU decides |
| Testing without a Windows machine | CI smoke test on a Windows runner; Windows 11 ARM in Parallels or UTM on the Mac runs the x64 app under Prism for install and flow checks, not for CUDA | CI plus LOCAL |

**Phase 6 candidates**, not committed: optional cloud model per question with explicit consent; Apple notarization and auto-update once an Apple Developer account exists; a vertical preset for one user group.

## Cloud session briefs

The promotional credits apply only to cloud sessions and expire on 2026-11-04. Sessions A to D have no dependency on each other and can run in parallel this week. Each brief below is written to paste as the session prompt. Before the first session: create the askfiles repository on GitHub (public, so CI is free), add anything-llm as a git subtree pinned to the chosen tag (scripts/vendor-upstream.sh; a submodule cannot be fetched in cloud sessions, which clone only the repositories attached to the session), and commit an empty README. Every session works on its own branch and opens a PR.

**Session A: upstream analysis (task 1.1)** Merged: PR 1, 2026-10-29.

Read the AnythingLLM submodule at the pinned tag and write docs/upstream-analysis.md. Answer each question in the Open questions section of this plan with file paths and line references. Specifically: the server boot sequence and every environment variable it reads; which host and port the server and collector bind to and how to force 127.0.0.1; every native module in server and collector and whether it is N-API; whether the collector pulls puppeteer or other packages over 50 MB; how onboarding completion is stored so a first-run wizard can mark it done; whether PDF parsing keeps page numbers in chunk metadata; how the server's TextSplitter splits text at embed time, whether it is heading-aware, whether a server patch or pre-splitting in the shell is the better override, and whether the header it prepends to every chunk can carry the section title and index; which parsers expose PDF bookmarks, Word heading styles and Markdown headings; whether chunk metadata can carry a section title and index through to the chat sources array; which Ollama models and tags exist for a multilingual embedder; the exact API endpoints and payloads for workspace create, document upload, embed, chat with sources, and thread listing. Do not change upstream code. Success: a report with no unanswered items, or a named experiment for each.

**Session B: skeleton and build script (task 1.2)** Merged: PR 2, 2026-10-29.

Create the Electron app skeleton with electron-builder targeting darwin arm64, productName AskFiles and appId io.askfiles.desktop, and scripts/build.sh that builds the upstream frontend into server/public, installs server and collector production dependencies, runs prisma generate, removes non darwin-arm64 Prisma engines, prunes dev dependencies, and ships the tesseract language files (eng and chi\_sim, 4.0.0\_best\_int, from the npm packages @tesseract.js-data/eng and @tesseract.js-data/chi\_sim) in the app so OCR never downloads them; the process manager copies them to STORAGE\_DIR/models/tesseract on first run. Session B only applies patches from patches/; it does not write them. Everything up to the packaging step must run on Linux in this container; the packaging step is documented but not run. Add a Makefile with build, test and clean. Write unit tests for the build helpers. Success: make build completes in the container and produces a server/public directory and pruned node\_modules.

**Session C: process manager (task 1.3)** Merged: PR 3, 2026-10-29.

Implement src/main/process-manager: free port allocation, first-run .env generation with random JWT\_SECRET, SIG\_KEY and SIG\_SALT, ordered startup of Ollama, collector and server with health checks and timeouts, prisma migrate deploy before the server starts, graceful shutdown with SIGTERM then SIGKILL after 5 seconds, crash restart with exponential backoff capped at 5 attempts, and logging to a configurable directory. Session C owns every upstream patch found by Session A (docs/upstream-analysis.md, Risks found), one file each in patches/: bind host 127.0.0.1; database path from DATABASE\_URL; upload folder (collector hotdir and collector tmp) from an environment variable; server .env path from an environment variable; cross-origin requests limited to the shell's own origin; the two outbound requests at server start (models.dev and raw.githubusercontent.com) disabled, because no request may leave the machine; the thinking switch (reasoningEffort) passed through the /v1 chat routes, with DEFAULT\_REASONING\_EFFORT as the default. The manager must be platform agnostic: binary paths and signals are injected. Write unit tests with fake processes. Write an integration test that downloads the Linux Ollama binary, starts the three processes from the built upstream code, and asserts 200 from /api/ping. Success: both test suites green in the container.

**Session D: search page and API client (tasks 3.1 and 3.3)** Merged: PR 4, 2026-10-29.

Build src/renderer/search as plain HTML, CSS and JS and src/renderer/api as a small client for the AnythingLLM REST API (endpoints from docs/upstream-analysis.md if present, otherwise from upstream server routes). The page has a query box, a streaming answer area, source cards showing passage, file name, section title and page when present, with hits from the same section merged, a section-listing fallback state when the answer indicates nothing was found, a recent questions list, and an index status bar. The answer area strips `<think>` blocks, including a block still open while streaming, regardless of preset. Write Playwright tests in headless Chromium against a seeded server started in the container. Design for light and dark mode. Success: tests green; screenshots attached to the PR.

**Session E: wizard and presets (tasks 1.4, 1.5, 1.6), after Session A** Merged: PR 6, 2026-10-29.

Implement the first-run wizard logic: RAM detection, tier mapping from config/presets.json, ollama pull with progress events, .env writing from the preset, marking onboarding complete using the method found in Session A. Presets turn thinking off by setting DEFAULT\_REASONING\_EFFORT=off, which the /v1 chat routes honour through Session C patch 7. Implement the model manager page. Unit tests for tier mapping and .env output; integration test against Linux Ollama. Success: tests green; the wizard runs headless in the container with a fake renderer.

**Session F: CI workflow and folder watcher (tasks 1.8 and 3.2), after Sessions B and C** Merged: PR 5, 2026-10-29.

Write .github/workflows/mac.yml for macos-14: build, package, ad-hoc sign, upload the DMG, then smoke test by launching the app, polling /api/ping, uploading a sample PDF and making one chat call. Implement src/main/watcher with chokidar or fs.watch: debounce, upload, re-embed, remove, status events. Unit tests for the watcher. Success: workflow file lints; watcher tests green.

**Session G: test harness (task 2.3), after Session A** Merged: PR 7, 2026-10-29.

Write scripts/eval: given a corpus folder and a questions CSV with an expected\_section column, set up the library, split by section, upload and embed, run each question through the chat API, and write answers, sources (file, section, page) and timings to results.csv. Support a config file for threshold, snippets, chunk strategy, chunk maximum and model so runs can be compared. Categories include section\_listing. Success: runs end to end in the container with a small fixture for corpus S and one for corpus L.

**What stays local**: the first real package (1.7), the visual pass on the wizard, search and browse pages, running the evaluation on Metal (2.4), and any Gatekeeper or copy test on a second Mac. Use Claude Code on the Mac for these; they do not consume the cloud credits.

## Open questions for Session A

Each is a fact to be read from upstream code, not a judgment call. Session A fills the answer column and this list becomes the record.

| # | Question | Why it matters | Answer |
| --- | --- | --- | --- |
| Q1 | Which native modules do server and collector load, and are they N-API | Decides whether electron-rebuild is needed or child processes can use Electron's Node as is | Answered at v1.19.0: all N-API (Prisma library engine, LanceDB, mdpdf, canvas, sharp 0.32 and 0.33, onnxruntime-node). Server and collector ran under Electron 45 with ELECTRON\_RUN\_AS\_NODE, no electron-rebuild. Install on macOS arm64. See docs/upstream-analysis.md Q1 |
| Q2 | Where does Prisma look for its query engine at runtime, and does it work from inside asar or must it be unpacked | Packaging failure mode seen in upstream desktop issues | Answered: engine found by fs lookup next to the generated client, no asar support; ship server and collector outside asar. The SQLite path is hard-coded to upstream/server/storage; a one-line DATABASE\_URL patch works. See Q2 |
| Q3 | Does the collector depend on puppeteer or any package over 50 MB | Bundle size; web scraping can be dropped | Answered: puppeteer yes, lazy, Chromium skippable with PUPPETEER\_SKIP\_DOWNLOAD=1. Over 50 MB: onnxruntime-node, onnxruntime-web, Linux lancedb and mdpdf binaries, @xenova/transformers, flow-bin (dev). See Q3 |
| Q4 | What host do server and collector bind to, and is there an env var to force 127.0.0.1 | Windows firewall prompt; local-only promise | Answered at v1.19.0: a patch is required. Server (upstream/server/utils/boot/index.js, HTTP and HTTPS) and collector (upstream/collector/index.js) call listen(port) with no host and read no bind address variable. Session C writes one patch that adds a host from an environment variable, default 127.0.0.1 |
| Q5 | How is onboarding completion persisted | The wizard must mark it done so users never see the provider picker | Answered: system\_settings row onboarding\_complete = true; set automatically at boot when LLM\_PROVIDER or VECTOR\_DB is in env. See Q5 |
| Q6 | Do PDF chunks carry page numbers in metadata returned as sources | Decides whether citations can show a page | Answered: no. The collector joins PDF pages and drops page numbers; the shell must parse pages itself. See Q6 |
| Q7 | Which env variables exist for Ollama chat and embedding, chunk length, threshold and snippet defaults | Preset generator | Answered: full table in docs/upstream-analysis.md Q7. Add EMBEDDING\_BASE\_PATH and TARGET\_OCR\_LANG to the preset; threshold and snippets are workspace columns |
| Q8 | Is there a flag to hide provider settings pages, or does it need a patch | Task 1.9 | Answered: no flag; small frontend patch (sidebar entries and routes). See Q8 |
| Q9 | What are the exact API routes and payloads for workspace create, upload, embed, chat with sources, threads | Phase 3 client and the test harness | Answered with verified curl calls in Q9. No thread list route; vector-search endpoint exists |
| Q10 | Which Ollama models and tags are suitable as a multilingual embedder at the tag date | Preset for Chinese documents | Answered: bge-m3 (567m, 1024 dims, 8K context) verified with Chinese; alternative qwen3-embedding:0.6b. Ollama truncates embedding input at 2048 tokens. See Q10 |
| Q11 | Does the server serve the frontend from server/public in production and what VITE\_API\_BASE value the frontend build expects | Build script | Answered: yes when NODE\_ENV is not development; copy frontend/dist to server/public; build with VITE\_API\_BASE unset (same-origin /api). See Q11 |
| Q12 | Which license and redistribution terms apply to the Ollama binary bundle | Distribution | Answered: MIT; bundle the binary plus its lib directory and ship all included license and NOTICE files (MIT, Apache-2.0, BSD). See Q12 |
| Q13 | Text is split at embed time by upstream/server/utils/TextSplitter, not in the collector. Is the splitter heading-aware, and which override is better: a patch to the server or pre-splitting in the shell before upload? TextSplitter prepends a header to every chunk: can that header carry the section title and section index | Section-based chunking | Answered: not heading-aware; header carries only title and date. Recommended: pre-split in the shell, write one document JSON per section and call update-embeddings; no patch. See Q13 |
| Q14 | Which parsers expose PDF bookmarks or outlines, Word heading styles and Markdown headings. Also: when does tesseract.js OCR run on PDFs and images, which languages does it load, and what does it cost in time per page | Browse view outlines without a model; indexing time for scanned files | Answered: no collector parser keeps structure; pdfjs-dist getOutline and mammoth convertToHtml do. OCR only for PDFs with no text at all and for images; eng by default, chi\_sim via TARGET\_OCR\_LANG, data downloaded from jsdelivr unless pre-seeded; about 2 to 5 s per page here. See Q14 |
| Q15 | Can chunk metadata carry a section title and index, and does the chat sources array return it; when query mode refuses, are near-miss sources still returned or is there a search-only endpoint | Source cards with section titles; section-listing fallback | Answered: yes via section JSON, returned in chat sources; refusal returns no sources; vector-search is a search-only endpoint but drops custom keys. See Q15 |

## Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Packaging surprises in native modules and Prisma | Days lost in task 1.7 | Session A answers Q1 and Q2 first; CI builds from the start so breakage shows early |
| Small models on 8 GB machines give poor answers | Users blame the product | Measure in phase 2; state the RAM to quality mapping plainly in the user guide; consider making 16 GB the recommended minimum |
| Similarity threshold too strict or too loose | Either false refusals or hallucination | Chosen from the 40 question run, not guessed; query mode plus citations as a visible safety net |
| Large section chunks crowd the context window | Fewer snippets, missed facts on small models | Chunk maximum and snippet count tested together in phase 2, per tier |
| Chinese retrieval quality | Core use case fails silently | Multilingual embedder from day one; Chinese documents in both corpora |
| Upstream tag changes API or env names | Shell breaks on upgrade | Pin the tag; upgrade only with a full harness run; keep patches minimal |
| Unsigned app on macOS 15 for internet downloads | Users cannot open it | Distribute by USB or LAN; one-paragraph instruction for the Privacy and Security step |
| Credits expire 2026-11-04 | Cloud work left undone | Run Sessions A to D in parallel this week; E to G next |
| No Windows test machine | Windows build unverified | Phase 5 deferred; CI smoke test and an ARM VM when it starts |

## Timeline and effort

Estimate: 14 to 25 working days of iteration for phases 1 to 4, about five to seven calendar weeks part time. Roughly a third is your own time, concentrated in phase 2 and the visual passes. Phase 5 is not included.

| Phase | Working days | Your time | Cloud share | Measured so far |
| --- | --- | --- | --- | --- |
| 1 Shell | 6 to 11 | Package tests and copy tests | Analysis, skeleton, process manager, wizard logic, presets, model manager, CI workflow | Sessions A to G merged on 2026-10-29 (PRs 1 to 7). On the macos-14 CI runner (Session F PR): build 65 s, package job 22 min, smoke test 3 min 45 s, one chat answer 38 s. Session I: DMG 695 967 267 bytes (663.7 MiB) before, 578 415 079 bytes (551.6 MiB) after; package job 26 min 45 s before, 4 min 15 s after with warm caches (9 min 27 s with empty ones) (docs/bundle-report.md) |
| 2 Presets and testing | 2 to 4 | Corpora, questions, scoring, user test | Harness and preset generator | Evaluation harness merged (Session G, PR 7) |
| 3 Search interface | 3 to 6 | Visual pass | API client, watcher, search page, onboarding page | Search page, API client and folder watcher merged (Sessions D and F, PRs 4 and 5) |
| 4 Browse view | 3 to 5 | Visual pass | Outline extraction, document and library pages, heading index, keyword search | Session J merged (PR 10). Session K: libraries, sidebar layout, indexing fixes, settings |

By code volume, 60 to 70 percent is cloud work. By calendar time, closer to half, because local packaging and debugging take longer per line.

**Order of work**

1. This week: Sessions A, B, C, D in parallel on the cloud credits.
2. Next: Sessions E, F, G after A reports; first local package (1.7) on your Mac.
3. Then phase 2 runs on your Mac with the harness, presets frozen.
4. Then phase 3 swap to the search page, visual pass, user test by USB.
5. Then phase 4 browse view on the same section split.

**Gate between phases**: phase 2 does not start until the packaged app opens on a second Mac; phase 3 does not start until presets are frozen from measured results; phase 4 does not start until the search page ships in the packaged app.
