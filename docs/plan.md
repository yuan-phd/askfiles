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
| Settings | Settings page with Answer scope, Answer model, Context length, Reindex; values in shell.json, applied through the presets code (src/main/settings.ts has the mapping). Answer model: Better is this Mac's tier, Faster the tier below; the lowest tier has no Faster. Context length: 4K, 8K, 16K tokens. A Developer page with the raw preset values exists only with ASKFILES\_DEVELOPER=1; the Models page has no menu entry and opens only from there (owner decision 2026-10-30). Answer scope reaches the answer pipeline as its scope, Balanced when unset | Owner decision 2026-10-30 (Session K); answer scope is consumed by Session L's answer pipeline |
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
| 1.8 | GitHub Actions workflow on macos-15 (Apple Silicon; moved from macos-14, which GitHub retires on 2026-11-02): build, package, ad-hoc sign, upload DMG, smoke test (open the app, curl /api/ping, upload a PDF, one chat call) | .github/workflows/mac.yml | Green run on a public repo | CLOUD writes it, CI runs it |
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

Answer scope maps to the number of sections the model reads and the lowest score a section needs: the rerank score with a reranker, the vector similarity of its best sub-chunk without one (rerankerModel none, every tier since 2026-10-30 because onnxruntime-node crashes on the owner's Mac). Read through the bridge from the settings store Session K adds. Values in every tier since 2026-10-31, measured on the owner's first corpus (Retrieval tuning below); the rerank floors are the starting values and apply only when a reranker is configured again.

| Answer scope | Sections (sectionCount) | Vector floor (vectorFloor) | Rerank floor (rerankFloor) | Stage 1 target section hit |
| --- | --- | --- | --- | --- |
| Strict | 3 | 0.6 | 0.5 | 67% (6/9) |
| Balanced | 5 | 0.55 | 0.1 | 78% (7/9) |
| Broad | 6 | 0.5 | 0.01 | 89% (8/9) |

Reranker comparison on the fixture corpora (test/fixtures/eval-s and eval-l, 13 answerable questions in all, all-minilm embedder, CJK bypass off, 8 candidate sections), 2026-10-30, measured in the cloud container (4 vCPU x86, Linux, while the stack ran beside it). Target section hit is the share of answerable questions whose expected sections were all among the selected sections, at floor 0:

| Reranker | Files | S: 1 section | S: 3 sections | L: 1 section | L: 2 sections | Rerank time per question (8 sections) | RAM |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ms-marco-MiniLM-L-6-v2 | 24 MB | 5/8 | 5/8 | 3/5 | 3/5 | 0.5 s (8 sections at the 512 token limit) | 0.4 GB |
| bge-reranker-base | 296 MB | 5/8 | 6/8 | 3/5 | 5/5 | 1.8 s (L) | 1.4 GB |
| bge-reranker-v2-m3 | 588 MB | 5/8 | 6/8 | 3/5 | 5/5 | 5.9 s (S), 11.7 s (L) | 2.7 GB |

Chinese: to an English question MiniLM scores a Chinese answer passage 0.000. To a Chinese question (scripts/bench-reranker.mjs) MiniLM scores the answer 0.999 but an unrelated Chinese passage 0.801, while bge-reranker-base gives 0.999 and 0.000; MiniLM's Chinese scores do not separate relevant from unrelated, which is why the 8 GB tier bypasses it for Chinese. The fixtures are small; the comparison is repeated on the owner's corpora with the eval (--set rerankerModel=...). Timings on the CI Mac (GitHub macos-14 runner, a virtualized M1 with 3 cores and 7 GB, before the move to macos-15; scripts/bench-reranker.mjs in the mac workflow, PR 11 run 41088006962, 2026-10-30), per question, median of 3, sections at the 512 token limit, half English and half Chinese, each model in its own process:

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

### Retrieval tuning, 2026-10-31: 32 GB tier, MacBook Pro (MacBookPro18,2, Apple M1 Max, 64 GB, macOS 14.8.5)

Corpus: the owner's first test library (12 files: 8 digital PDFs, 1 scanned PDF, 2 Word files, 1 macro workbook; 1262 chunks, embedded in 130 s), ten questions (~/AskFiles-eval/questions.csv, outside the repository; 9 answerable, 1 absent_related). qwen3:14b Q4_K_M and bge-m3:567m F16 on Ollama 0.40.11, reranker off (rerankerModel none), chunk maximum 2000, context 8192. UPSTREAM_VERSION v1.19.0; base commit 616b5e17 with the branch local/retrieval-tuning changes (the commit that adds this record). Run folders in ~/AskFiles-eval/runs.

Changes measured against the run of 2026-10-30 (same corpus and questions): fusion by best sub-chunk with a tie-breaker of at most 10 percent instead of the sum (Q02 and Q05: the target was first in both lists but fourth to sixth after summing); passages assembled from the matched sub-chunks and their neighbours instead of one window around the best hit (Q01: the effective date fell outside the window); long sections without sub-headings split by page (the nine-page cover sections of the Policy, Directive and Procedure); garbled PDF pages replaced by OCR (26 of 50 pages of the scanned file; the JBIG2 scans gave no page image at all until pdfPageImages passed wasmUrl, a bug since the pdfjs-dist 6 update); a stricter not-found rule in the prompt; attribution now requires the cited sections to hold the key elements the answer states. Q01, Q04 and Q08 expect the new page sections; their facts are the same.

Stage 1, target section hit rate over the 9 answerable questions, 2026-10-30 before the arrow (->), 2026-10-31 after (counts 4, 6 and 8 only on 2026-10-31):

| Sections \ vector floor | 0 | 0.3 | 0.4 | 0.45 | 0.5 | 0.55 | 0.6 | 0.65 |
|---|---|---|---|---|---|---|---|---|
| 2 | 33 -> 56% | 33 -> 56% | 33 -> 56% | 33 -> 56% | 33 -> 56% | 33 -> 56% | 44 -> 56% | 44 -> 56% |
| 3 | 44 -> 67% | 44 -> 67% | 44 -> 67% | 44 -> 67% | 44 -> 67% | 44 -> 67% | 56 -> 67% | 56 -> 67% |
| 4 | 78% | 78% | 78% | 78% | 78% | 78% | 78% | 67% |
| 5 | 78 -> 78% | 78 -> 78% | 78 -> 78% | 78 -> 78% | 78 -> 78% | 89 -> 78% | 89 -> 78% | 67 -> 67% |
| 6 | 89% | 89% | 89% | 89% | 89% | 89% | 89% | 78% |
| 8 | 100% | 100% | 100% | 100% | 100% | 89% | 89% | 78% |

The 89 percent of 5 / 0.55 on 2026-10-30 counted a Q08 hit on the old garbled section (pages 7 and 8, from the scan's bad text layer); the page 7 section after OCR ranks eighth. Q04 needs six sections now: the Directive's page 7 ranks sixth behind its definitions page. The absent question gets sections at every floor below 0.65 (the template is on topic). Presets: Balanced is the best of the original grid (2, 3, 5 sections), 5 / 0.55, inside the 0 to 0.6 plateau; Strict one step tighter, 3 / 0.6; Broad one step looser, 6 / 0.5. Eight sections reach 100 percent in stage 1 but were not run through the model and exceed the 6656 token source budget at full section size.

Stage 2 at 5 sections, vector floor 0.55, two passes; latency is pass 1 (pass 2 repeats the prompts and Ollama answers from its prompt cache, first token about 0.2 s):

| Run | Target section cited | Key element coverage | Attribution (new rule) | Median first token / total, pass 1 | Median prompt tokens |
| --- | --- | --- | --- | --- | --- |
| 2026-10-30 | 56% (10/18) | 56% | 55% (11/20); 70% under the old rule | 23.1 s / 27.0 s | 4088 |
| 2026-10-31 | 67% (12/18) | 64% | 60% (12/20) | 14.9 s / 20.3 s | 2789 |
| 2026-10-31, firmer not-found wording (not kept) | 44% (8/18) | 47% | 60% (12/20) | 14.9 s / 17.5 s | 2830 |

Per question, 2026-10-31 (pass 1; both passes agree): Q01 effective date found (was not found); Q02 cites the Standstill Period (was a Request for Bids section); Q03 right section, attribution fails because the Contents page is cited too; Q04 cites the Policy page and the Directive's page 3, not page 7; Q05 and Q06 correct; Q07 says the formula is not in the sources (true: the split keeps cached values only) without the marker; Q08 not found, the page 7 OCR is poor (SUBJECT read as SETRITN; the scan is about 100 dpi); Q09 SMART and the signing rule right, the Contract Management Plan section was selected but not cited; Q10 states the placeholders correctly in its own words instead of the marker, so the harness scores it false. The firmer wording (start with the marker, never explain in own words, one example) made Q10 correct but refused Q03, Q04 and Q07, whose one missing part (a page number, a formula) is not the whole question.

### Acceptance and stopping rules

Recorded 2026-10-31. They govern every tuning round from round 1 on.

**Two fixed sets.** ~/AskFiles-eval/questions-v2.csv is the tuning set. ~/AskFiles-eval/questions-check.csv is the check set: never used for tuning, run once at the end of every round. Both stay outside the repository and on the owner's corpus.

**Gating thresholds**, on both sets:

| Metric | Threshold |
| --- | --- |
| Right section cited | at least 90 percent |
| Attribution | at least 90 percent |
| Key element coverage | at least 85 percent |
| Median total latency | at most 20 s |
| False refusals: answerable questions returned not-found | at most 5 percent |
| False answers: absent questions given an answer | at most 10 percent |

cross_document is reported without a threshold. Formula questions (a spreadsheet formula the split does not keep; marked [unsupported: formula] in notes) are marked unsupported and excluded from every metric. The two abstention figures replace the single correct-abstention figure.

**Round rules.** One class of change per round. The results of both sets are appended to the round table below with the round number and the change. Any gating metric falling more than 3 points on either set reverts the whole round. Two consecutive rounds with less than 3 points gain on the tuning set stop the work.

**Variance band** (from round 6 on, recorded 2026-10-31). The kept configuration was run three times on all three sets; a change counts as real only when it falls outside the min to max range of those three runs, and the 3 point revert rule still applies. The band on qwen3:14b q4_K_M, context 8192, Balanced, verifyCitations on: tuning set coverage 73.5 to 74.3 percent (spread 0.8), median 18.3 to 18.5 s (0.3), every other gating metric identical in all three runs; check set identical in every metric, median 14.6 to 14.7 s; absent set 0 of 10 false answers in all three, median 12.1 to 12.2 s. With temperature 0.1 and Ollama restarted before every run the answers barely move: only Q04 (cross_document, attribution), Q17 and Q22 (coverage) changed between the runs. A band this narrow means one question is outside it, so a round's per-question changes are listed and judged with it.

**Stop** when both sets meet every threshold, or after round 4, whichever comes first.

| Round | Change | Set | Right section cited | Attribution | Key element coverage | Median total | False refusals | False answers | Kept |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | Baseline: single mode, Balanced 5 / 0.55, scored with the round 1 harness rules | tuning | 92% (23/25) | 70% (19/27) | 55% | 18.3 s | 4% (1/25) | 50% (1/2) | baseline |
| 0 | same | check | 80% (8/10) | 71% (10/14) | 33% | 14.6 s | 0% (0/10) | 0% (0/4) | baseline |
| 1 | Quote-grounded answering (answerMode quoted, extraction N 6; N 8 gave the same quality and 28.1 s on the tuning set) | tuning | 84% (21/25) | 63% (17/27) | 41% | 23.6 s | 12% (3/25) | 50% (1/2) | no: cited -8, attribution -7, coverage -14 points |
| 1 | same | check | 80% (8/10) | 71% (10/14) | 28% | 19.9 s | 20% (2/10) | 0% (0/4) | no |
| 0' | Baseline rerun before round 2: single mode, all switches off, scored with the round 2 harness (coverage over literal key elements only) | tuning | 92% (23/25) | 70% (19/27) | 81% | 18.3 s | 4% (1/25) | 50% (1/2) | baseline |
| 0' | same | check | 80% (8/10) | 71% (10/14) | 76% | 14.6 s | 0% (0/10) | 0% (0/4) | baseline |
| 2 | Citation verification in code (verifyCitations, overlap 0.5) | tuning | 92% (23/25) | 70% (19/27) | 81% | 18.3 s | 4% (1/25) | 50% (1/2) | yes: no metric fell; gain 0 points |
| 2 | same | check | 90% (9/10) | 71% (10/14) | 76% | 14.6 s | 0% (0/10) | 0% (0/4) | yes |
| 2' | New baseline: round 2 (verifyCitations) on the repaired answer key | tuning | 92% (23/25) | 85% (23/27) | 74% | 18.3 s | 4% (1/25) | 50% (1/2) | baseline |
| 2' | same | check | 90% (9/10) | 79% (11/14) | 53% | 14.6 s | 0% (0/10) | 0% (0/4) | baseline |
| 3 | Paragraph-level selection by embeddings (paragraphSelection), on round 2 | tuning | 88% (22/25) | 85% (23/27) | 75% | 15.0 s | 4% (1/25) | 50% (1/2) | no: cited -4 points |
| 4 | Structured abstention (verdictLine), on round 2 | tuning | 84% (21/25) | 85% (23/27) | 72% | 17.4 s | 8% (2/25) | 0% (0/2) | no: cited -8 points, false refusals 8 percent |
| 5 | Answer style (promptVariant complete: every condition, exception, step and figure, in the sources' own terms) and each citation of a sentence must pass verification on its own, on round 2 | tuning | 88% (22/25) | 74% (20/27) | 79% | 18.4 s | 4% (1/25) | 100% (2/2) | no: coverage +5 but cited -4, attribution -11, false answers +50 points |
| 6 | Variance band: round 2' configuration three times (qwen3:14b-q4_K_M, context 8192), min to max | tuning | 92% (23/25) | 85% (23/27) | 74% (73.5 to 74.3) | 18.3 to 18.5 s | 4% (1/25) | 50% (1/2) | baseline |
| 6 | same | check | 90% (9/10) | 79% (11/14) | 53% | 14.6 to 14.7 s | 0% (0/10) | 0% (0/4) | baseline |
| 6 | same | absent | - | - | - | 12.1 to 12.2 s | - | 0% (0/10) | baseline |
| 7 | Document affinity (documentAffinity: file names, cover titles and type words in the question raise that file's sections 1.5 times, restrict verification to a single named file; file and type in source headers; same-title sources chosen by overlap) | tuning | 96% (24/25) | 85% (23/27) | 77% | 15.9 s | 4% (1/25) | 100% (2/2) | no: false answers +50, check set cited -10, attribution -8, coverage -7 |
| 7 | same | check | 80% (8/10) | 71% (10/14) | 46% | 17.1 s | 0% (0/10) | 0% (0/4) | no |
| 7 | same | absent | - | - | - | 12.4 s | - | 0% (0/10) | no |
| 8a | Conditional completeness, prompt half (enumerateWhenAsked: set questions are told to count the items in the cited sources and give every one with its citation), on round 2' | tuning | 92% (23/25) | 89% (24/27) | 74% | 18.4 s | 4% (1/25) | 0% (0/2) | yes: attribution +4 and false answers -50, both outside the band; nothing fell |
| 8a | same | check | 90% (9/10) | 79% (11/14) | 53% | 13.9 s | 0% (0/10) | 0% (0/4) | yes |
| 8a | same | absent | - | - | - | 12.5 s | - | 0% (0/10) | yes |
| 8c | 8a plus the follow-up check (enumerateFollowUp: a stated count with fewer items enumerated makes one more call for the missing ones) | tuning | 92% (23/25) | 89% (24/27) | 73% | 18.3 s | 4% (1/25) | 0% (0/2) | no: no gain; fired once and added nothing usable |
| 8c | same | check | 90% (9/10) | 79% (11/14) | 53% | 14.4 s | 0% (0/10) | 0% (0/4) | no |
| 8c | same | absent | - | - | - | 12.5 s | - | 0% (0/10) | no |
| 9a | No summarizing (noSummarizing: one rule on every question in place of the enumerateWhenAsked set rule: do not summarize, merge or group; state each listed item separately with its citation; give every member of a set), on 8a | tuning | 88% (22/25) | 78% (21/27) | 78% | 18.4 s | 4% (1/25) | 50% (1/2) | no: coverage +4, but attribution -11, cited -4 and false answers +50 (Q10 answered again) |
| 9a | same | check | 90% (9/10) | 71% (10/14) | 51% | 13.6 s | 0% (0/10) | 0% (0/4) | no: attribution -8, coverage -2 |
| 9a | same | absent | - | - | - | 11.2 s | - | 0% (0/10) | no |
| 9b | Question decomposition (decomposeQuestions: split only on explicit structure, the whole pipeline per part, answers merged under lead-ins), on 9a | tuning | 92% (23/25) | 74% (20/27) | 78% | 19.9 s | 4% (1/25) | 50% (1/2) | no: split questions 59 to 58 percent coverage against 9a, attribution -4 more |
| 9b | same | check | 90% (9/10) | 71% (10/14) | 51% | 16.4 s | 0% (0/10) | 0% (0/4) | no: split questions unchanged against 9a |
| 9b | same | absent | - | - | - | 11.3 s | - | 0% (0/10) | no: no absent question splits |
| 9b' | decomposeQuestions on 8a, without 9a (run because 9a was reverted, so 9b alone could not be adopted) | tuning | 96% (24/25) | 85% (23/27) | 75% | 19.6 s | 4% (1/25) | 0% (0/2) | no: split questions 55 percent coverage as in 8a, attribution -4 (Q25) |
| 9b' | same | check | 90% (9/10) | 71% (10/14) | 55% | 16.6 s | 0% (0/10) | 0% (0/4) | no: split questions 70 to 76 percent coverage, but attribution -8 (Q38) |
| 9b' | same | absent | - | - | - | 12.5 s | - | 0% (0/10) | no |

Round 1 notes (2026-10-31, same Mac, corpus and models as the retrieval tuning above; one pass per question; run folders ~/AskFiles-eval/runs/r1-*). Gated figures leave out cross_document (tuning set: single 0/2, quoted 1/2 cited) and the formula questions Q07 and Q41. Key element coverage counts the answer key's elements as written; over only the elements found word for word in the expected section it was 81 percent (single) and 68 percent (quoted) on the tuning set. The harness changes of round 1 (normalization of dashes, quotes, broken words and percent ranges; question-copied phrases left out of attribution; false refusals and false answers) apply to every row above. Quoted mode is kept as an option (answerMode, default single) and not used in any preset. Its causes on the tuning set: 8 selection cuts (the extraction returned no verifiable excerpt of the expected section, or not the sentences holding the answer), 7 model errors, 1 retrieval miss, 1 abstention error (Q10). Its table-of-contents filter also flags three table or sheet sections whose lines end in numbers (Initial Technical Score, Final Weighted Technical Score, Foreign Currency Summary page), which took Q40's expected section out of the extraction. The extraction call alone takes 4 to 29 s. The check-set N 8 run followed the N 6 run on the same questions and Ollama reused cached prompt prefixes, so its 9.1 s median is not comparable. Round count: 1 of 4; round 1 gained nothing on the tuning set (first round under 3 points).

Round 2 notes (2026-10-31, same Mac, corpus and models; one pass per question; Ollama restarted before every run so no prompt prefix came from its cache; run folders ~/AskFiles-eval/runs/r0-*, r2-*). Two harness and filter fixes came first and apply to rows 0' and 2: key element coverage counts only the elements found word for word in the expected section after normalization (the harness prints the others before stage 2: 17 of 27 tuning questions and 10 of 11 check questions have at least one), and the table-of-contents filter of quoted mode needs dot leaders or a Contents title. Claims were also split wrongly: a full stop and its space arriving in two streamed pieces did not end a sentence, so most answers counted as one sentence and unsupported sentences were undercounted (round 0' re-parsed: 0.28 per answer on the tuning set, 0.70 on the check set, against 0.24 and 0.30 with verifyCitations). Verification threshold 0.5 from the round 1 answers: 41 of 44 cited sentences share at least half their content tokens with the source they cite; the three below are remarks about the sources. In round 2 no tuning sentence was re-attributed; verification cited uncited sentences to a source in 4 tuning and 3 check answers and marked 8 and 5 sentences unsupported. The check-set gain is Q39, whose four uncited sentences went to the expected section. Attribution did not move because of the answer key, not the citations: in 5 of the 7 remaining tuning failures the answer states no key element word for word (Q13, Q18, Q24, Q27 none, Q25 only one), which attribution requires; Q03 cites a second, correct section for the tool's location. Round count: 2 of 4; rounds 1 and 2 both gained under 3 points on the tuning set, so the work stops by the round rules. paragraphSelection and verdictLine are built and unit tested, off in every preset and not measured. Presets: verifyCitations on.

Stop overridden once (owner, 2026-10-31): rounds 1 and 2 were measured against key elements that are paraphrases, so attribution and coverage could not move; the round cap of 4 stays. Before rounds 3 and 4 the answer key was repaired: every key element without a literal match in its expected section was replaced by the shortest literal phrase of the sentence that states the same fact (~/AskFiles-eval/questions-v3.csv and questions-check-v2.csv; the old files are kept). 67 elements were replaced; 12 stay as written and out of coverage because no sentence in the expected section states them: page numbers from the file (Q29, Q34), OCR that does not hold the field (Q08, Q34), section numbers found only in the heading path (Q36, Q37), and computed or inferred values (Q11, Q39, Q40). Round 2 on the repaired sets is the new baseline (row 2').

Rounds 3 and 4 notes (2026-10-31, run folders ~/AskFiles-eval/runs/b2-*, r3-*, r4-*; Ollama restarted before every run). The check set was run only for the baseline, since neither round was kept. Round 3: 1078 paragraphs from 36 sections longer than 4000 characters, embedded in 30 s with bge-m3; 13 of 30 questions had at least one selected section cut to paragraphs, and their prompts fell from 3072 to 2663 tokens on average (all questions: mean 2544 to 2361, median 2722 to 2521); median total 18.3 to 15.0 s. The lost point is Q14: the same answer text cited Debriefing by the Borrower instead of the section that holds paragraph 5.88. Round 4: Q10 now abstains (false answers 50 to 0 percent), but Q03, answerable, got NOT_FOUND, and Q14 again cited the wrong section; the round needed false refusals within 5 percent. Both one pass per question, so a single question is 4 points; the Q14 citation changed between runs with identical answer text, which points at run-to-run variance as much as at the switches. Remaining failures on the repaired tuning set are mostly coverage: answers paraphrase the literal phrases (14 of the 15 model errors in round 2' include a coverage miss), retrieval misses Q04 (fused rank 6) and Q08 (rank 8). Round count: 4 of 4; the work stops. Presets: verifyCitations on, paragraphSelection and verdictLine off.

Round 5 (2026-10-31), approved by the owner as one extra round under the same rules; kept only if coverage rises by at least 3 points and no gating metric falls by more than 3. Run folder ~/AskFiles-eval/runs/r5-v3. Two rules added after the citation rule: name every condition, exception, step and figure in the cited sources that bears on the question; use the sources' own terms, names and numbers. Verification was tightened in the same round: of a sentence with several citations only those passing 0.5 on their own stay, the rest dropped and logged (2 citations dropped over the 30 questions). Coverage rose 74 to 79 percent, but Q30 (absent) answered that the date is not specified instead of abstaining, Q14 again cited the wrong section, attribution was lost on Q14, Q18 and Q30 and gained on Q04. Not kept, so the check set was not run; the tightening was taken out again and promptVariant complete stays an option no preset uses.

Measurements on the round 2' configuration (2026-10-31, repaired sets, Ollama restarted before every run; run folders m8b-*, m27b-*, broad-v3):

| Model or scope | Set | Right section cited | Attribution | Key element coverage | Median total | False refusals | False answers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3:14b, Balanced (2') | tuning | 92% (23/25) | 85% (23/27) | 74% | 18.3 s | 4% (1/25) | 50% (1/2) |
| qwen3:8b, Balanced | tuning | 84% (21/25) | 63% (17/27) | 72% | 8.8 s | 4% (1/25) | 100% (2/2) |
| qwen3.8:27b, Balanced | tuning | 92% (23/25) | 81% (22/27) | 79% | 38.1 s | 8% (2/25) | 0% (0/2) |
| qwen3:14b, Broad 6 / 0.5 | tuning | 92% (23/25) | 81% (22/27) | 76% | 20.3 s | 4% (1/25) | 50% (1/2) |
| qwen3:14b, Balanced (2') | check | 90% (9/10) | 79% (11/14) | 53% | 14.6 s | 0% (0/10) | 0% (0/4) |
| qwen3:8b, Balanced | check | 90% (9/10) | 71% (10/14) | 50% | 7.8 s | 0% (0/10) | 25% (1/4) |
| qwen3.8:27b, Balanced | check | 90% (9/10) | 71% (10/14) | 57% | 29.1 s | 10% (1/10) | 0% (0/4) |

qwen3:8b against 14b: half the latency, but two cited sections lost (Q13, Q23), attribution lost on Q13, Q18, Q23, Q25, Q26, Q30 and Q44 (gained on Q04), and both absent_related questions of the tuning set plus Q44 of the check set answered instead of abstaining. qwen3.8:27b (no plain Qwen3 model above 14b is installed; qwen3.6:35b is also present) adds coverage and abstains on Q10 but doubles the median past 20 s and refuses an answerable question on each set. Broad adds 460 prompt tokens per question and 2 s for no gain in cited sections.

Quantization and context matrix (2026-10-31, measurement only, no pipeline or preset change; round 2' configuration: verifyCitations on, Balanced 5 / 0.55, qwen3:14b; Ollama 0.40.11 restarted before every run; run folders ~/AskFiles-eval/runs/x-<quant>-<context>-<set>). Each configuration ran the tuning set (questions-v3.csv), the check set (questions-check-v2.csv) and a new absent set (questions-absent.csv), one pass per question. Models: q4_K_M is the library tag qwen3:14b-q4_K_M (digest bdbd181c33f2, the same as qwen3:14b, 9276198565 bytes); the library has no q4_K_S or q3_K_M tag and the official Qwen GGUF repository has neither, so both come from hf.co/unsloth/Qwen3-14B-GGUF:Q4_K_S (0ead9e0f1a13, 8573478436 bytes) and :Q3_K_M (63e5e1881899, 7321315876 bytes), which carry Unsloth's own chat template, so a difference between the rows is not only the quantization.

The absent set holds 10 questions, Q46 to Q50 absent_related (close to a real section, with the likely false citation in the notes) and Q51 to Q55 absent_unrelated. It is provisional: a full negative search of the 12 original files has not been done. False answers count all 16 absent questions (Q10, Q30, Q42 to Q45 and the 10 new ones). Cited, attribution, coverage and false refusals are tuning and check sets together, without cross_document and the formula questions Q07 and Q41, as in the rows above. Model memory is the size /api/ps reports for the chat model alone (weights plus KV cache, all on the GPU), measured once per configuration after the runs; the footprint is the peak of top's MEM for the Ollama and llama-server processes, sampled every 3 s during the runs, which leaves out the memory-mapped weights. The /api/ps sum the sampler took during the runs also counts the embedding model (about 0.6 GiB), and in the first run it still saw models loaded before the restart, so it is not used.

| Run | Right section cited | Attribution | Key element coverage | False refusals | False answers (16 absent) | Median total, all sets / answerable | Chat model in memory | Peak process footprint |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| q4_K_M, 8192 (baseline) | 91% (32/35) | 83% (34/41) | 68% | 3% (1/35) | 6% (1/16) | 14.9 / 16.6 s | 9.17 GiB | 10.2 GiB |
| q4_K_M, 4096 | 86% (30/35), -6 | 80% (33/41), -2 | 66%, -2 | 6% (2/35), +3 | 6% (1/16), 0 | 12.3 / 13.1 s, -2.6 | 8.40 GiB, -0.77 | 8.6 GiB |
| q4_K_S, 8192 | 91% (32/35), 0 | 80% (33/41), -2 | 69%, +1 | 3% (1/35), 0 | 6% (1/16), 0 | 14.5 / 15.1 s, -0.4 | 8.52 GiB, -0.65 | 9.3 GiB |
| q4_K_S, 4096 | 86% (30/35), -6 | 76% (31/41), -7 | 66%, -2 | 6% (2/35), +3 | 6% (1/16), 0 | 12.2 / 12.6 s, -2.7 | 7.74 GiB, -1.43 | 8.5 GiB |
| q3_K_M, 8192 | 91% (32/35), 0 | 80% (33/41), -2 | 68%, 0 | 3% (1/35), 0 | 6% (1/16), 0 | 15.9 / 16.7 s, +1.0 | 7.45 GiB, -1.72 | 9.3 GiB |
| q3_K_M, 4096 | 86% (30/35), -6 | 78% (32/41), -5 | 64%, -4 | 6% (2/35), +3 | 6% (1/16), 0 | 12.6 / 13.3 s, -2.3 | 6.67 GiB, -2.50 | 8.5 GiB |

Questions whose outcome differs from the baseline in any run:

| Question | Category | Change against the baseline |
| --- | --- | --- |
| Q04 | cross_document (not gated) | attribution no to yes in all five other runs |
| Q09 | cross_document (not gated) | q4_K_M 4096: cited no to yes; q4_K_S 8192: cited no to yes, coverage 0.86 to 1.00; q4_K_S 4096: attribution yes to no |
| Q14 | single_fact | q4_K_S 8192: coverage 0.60 to 0.40 |
| Q17 | middle_of_long_doc | coverage 0.80 to 0.60 (q4_K_M 4096), to 0.40 (q4_K_S 4096, q3_K_M 4096) |
| Q18 | middle_of_long_doc | coverage 0.60 to 0.80 in all five; attribution yes to no in q4_K_S 4096 and q3_K_M 8192 |
| Q25 | table_number | coverage 0.17 to 0.33 in q4_K_S and q3_K_M at both contexts; q3_K_M 4096: attribution yes to no |
| Q26 | single_fact | q3_K_M 8192: coverage 0.20 to 0.40 |
| Q29 | single_fact | q4_K_S at both contexts: attribution yes to no |
| Q31 | single_fact | every 4096 run: cited yes to no |
| Q32 | single_fact | every 4096 run: refused (NOT_IN_SOURCES), so cited, attribution and coverage 0.75 to 0 |
| Q36 | middle_of_long_doc | coverage 0.60 to 0.80 (q4_K_S, both contexts), to 0.40 (q3_K_M, both contexts) |
| Q38 | middle_of_long_doc | coverage 0.67 to 0.50 (q4_K_S 8192, q3_K_M at both contexts) |
| Q40 | table_number | q3_K_M at both contexts: coverage 0.40 to 0.20 |

Every run answers Q10 (the only false answer) and refuses Q08 (OCR, retrieval rank 8); all 10 new absent questions abstain in all six runs. Context 4096 is the larger effect: the same three questions change in every quantization, and the cause is the section budget, not the model. Q32's Price Adjustment section is sent with 3189 characters at 8192, the 1.0 factor at character 2993; at 4096 it is cut to 1521 characters and the model abstains. 4096 saves 2.3 to 2.7 s median and 0.77 GiB of KV cache and costs 6 points cited and one more false refusal. At 8192 q4_K_S and q3_K_M hold the gated metrics within 2 points of q4_K_M, all from single-question changes (Q18, Q29), and save 0.65 and 1.72 GiB; q3_K_M is 1 s slower. One pass per question, so one question is 3 points on cited and 2 to 3 on attribution, and the per-question changes of the 8192 rows are within the run-to-run variance seen in rounds 3 and 4. Presets unchanged.

Spot-check of answer completeness (owner, open). The coverage metric counts literal key elements, so it cannot tell whether an answer is complete in the user's eyes. ~/AskFiles-eval/spot-check.md holds 10 answerable questions from the baseline run (x-q4km-8192, tuning and check sets), picked with Python random.Random(20261031).sample over the 37 sorted ids that are neither absent nor Q07 or Q41: Q03, Q05, Q08, Q09, Q18, Q22, Q27, Q33, Q36, Q39. For each it shows the question, the answer as the Ask page shows it (sentences after verifyCitations with their [n] markers, unsupported sentences marked, or the not-found state), the source cards cited, the expected file, section and page, and the key elements. To fill it in: read only the answer and its cards, then mark Complete yes when a user would get everything the question asks for with correct citations, no otherwise, and note what is missing or wrong. Compare the share of yes with the run's key element coverage on the same 10 questions; if they disagree by more than one or two questions, coverage is not a usable acceptance metric and the acceptance rules above need revisiting. Executor: owner.

Rounds 6 to 8 (2026-10-31, approved by the owner as three measured rounds under the rules above; one model, qwen3:14b-q4_K_M at context 8192, Balanced 5 / 0.55, verifyCitations on; Ollama restarted before every run; one pass per question; run folders ~/AskFiles-eval/runs/r6-1-* to r6-3-*, r7-*, r8a-*, r8c-*). The tuning and check rows count the absent questions inside those sets (Q10, Q30; Q42 to Q45); the absent set (questions-absent.csv, provisional) is its own row. Gated figures leave out cross_document and Q07 and Q41 as before. The unit tests and lint of the worktree ran for about a minute while round 6 run 1 started its check set, so that run's check-set latency may be a little high; it is inside the band anyway.

Round 7 detail. The identifier map (src/main/browse/identifiers.ts, stored as <library>/browse/identifiers.json) names a file correctly in every one of the 55 questions that names one and in none that does not (Q15's streamlined procedure and Q54's Federal Acquisition Regulation name nothing); Memorandum is in the type list but no file name or PDF cover holds it, so in this corpus it names nothing, and the Word and Excel files have no cover title. Gains: Q04 (cross_document) cites both the Policy and the Directive pages for the first time (the boost lifted the Directive page from fused rank 6), Q27 cites its section, and Q18, Q23, Q25 gain coverage. Losses: Q30 (absent, names the Template) now answers that the date is not specified, with a citation, instead of the marker; Q34 (check set) changed its answer text with the new headers, named the wrong header fields, and verification moved two sentences from page 19 to page 17 of the same file, so cited, attribution and coverage fell; Q09 lost attribution. Q33's expected section stays out (fused rank 13 without the boost, still not selected with it). The restriction to the named file and the same-title rule did not change a citation in the tuning or check set except through Q34. Reverted: documentAffinity off.

Round 8a detail. 9 of the 55 questions count as set questions: Q06, Q15 (requirements), Q16 (factors), Q33, Q36 (each), Q39, and the absent Q10, Q48, Q53 (what are the); Q06, Q33 and Q39 state a count. The gain is Q10: with the rule it replies NOT_IN_SOURCES (it answered from the template's placeholders in every round 6 run). Q16 lists the factors as a numbered list but loses one key element (coverage 1.0 to 0.8). Q33 shows a side effect the owner should know about: the model wrote its counting into the answer (The question asks for three activities ... Count: 1 item found in the sources.), because the section that holds the three activities is not selected (retrieval miss, fused rank 13). Kept: enumerateWhenAsked on in every preset.

Round 8c detail. The follow-up check fired once in 55 questions, on Q33 (1 of 3 items, the retrieval miss), took 1.0 s, and appended the reply Nothing. to the answer; the harness's not-found check did not catch that word. Q06 and Q39 already listed their stated number of items, so nothing fired there. No metric gained, so the second half is not kept: enumerateFollowUp off. Round count: round 7 reverted, round 8a gained (attribution +4 on the tuning set), 8c gained nothing; presets: verifyCitations and enumerateWhenAsked on, documentAffinity, enumerateFollowUp, paragraphSelection and verdictLine off.

Cause tables (r6-1 as the baseline, then the kept round 8a; causes as in rounds 1 to 5):

| Run | Set | Retrieval miss | Selection cut | Model error | Abstention error | No failure |
| --- | --- | --- | --- | --- | --- | --- |
| 6 (run 1) | tuning | 2 (Q04, Q08) | 0 | 16 | 1 (Q10) | 10 |
| 6 (run 1) | check | 1 (Q33) | 0 | 9 | 0 | 4 |
| 7 | tuning | 1 (Q08) | 0 | 15 | 2 (Q10, Q30) | 11 |
| 7 | check | 1 (Q33) | 0 | 9 | 0 | 4 |
| 8a | tuning | 2 (Q04, Q08) | 0 | 16 | 0 | 11 |
| 8a | check | 1 (Q33) | 0 | 9 | 0 | 4 |

Almost every model error is a coverage miss (the answer paraphrases or leaves out a literal key element); the gated attribution failures left after 8a are Q03 (cites the Contents page too), Q08 (OCR, retrieval miss) and Q27 in the tuning set, Q33 (retrieval miss), Q39 and Q40 (table arithmetic) in the check set.

Round 9 (2026-10-31, approved by the owner as two changes measured in sequence on the kept configuration, round 2' plus enumerateWhenAsked; same model, settings, sets and procedure as rounds 6 to 8; run folders ~/AskFiles-eval/runs/r9a-*, r9b-*, r9b0-*). Judge: keep 9a if coverage rises and no gating metric drops more than 3 points; keep 9b if coverage rises further on the split questions and nothing drops.

Round 9a detail. Coverage rose on Q18, Q25, Q26 and Q28 (tuning), but the rule to state every listed item made the model add items from neighbouring sections it was given: Q26 adds a third circumstance from Formula Redesign, Q38 adds the formula, indices and base date from the Procurement Regulations' Price Adjustments, so their attribution fails; Q14 cites the neighbouring Debriefing section for the same sentence; and Q10 lists the template's placeholder fields as the items instead of replying NOT_IN_SOURCES, which undoes the round 8a gain. Not kept: noSummarizing off.

Round 9b detail. The splitter (src/main/answer/decompose.ts) splits 13 of the 55 questions: Q04 by its Compare A and B set (2 parts), Q06, Q08, Q09 (3 parts, the former and the latter resolved to the two guidances named before the asks), Q15, Q21, Q25 (3 parts), Q26, Q27 in the tuning set and Q31, Q32, Q36, Q38 in the check set; none of the absent set. It leaves whole every question whose later ask points back with a pronoun (Q02, Q13, Q17, Q20, Q35, Q37, Q39 and others), whose asks have no lead-in (Q11, Q18, Q30, Q52) or that has two question sentences (Q41). Lead-ins repeat the question's words, so coverage was also measured with them removed: identical on every split question. On 9a, the split questions' coverage moved 59 to 58 percent on the tuning set and stayed at 66 percent on the check set; Q04 fell from 0.50 to 0.25 because each document's part answers only for its own document. Since 9a was reverted, decomposition was also run on 8a (9b'): coverage on the split questions 55 percent as in 8a on the tuning set (Q25 0.17 to 0.50, Q26 0.20 to 0.40, Q04 0.50 to 0.25, Q15 1.0 to 0.75) and 70 to 76 percent on the check set (Q36 0.6 to 0.8), but each part retrieves its own sections and cites extra ones: Q25's second part cites a second section and Q38's first part cites the Procurement Regulations, so attribution fell on both sets. Latency on split questions: mean total 15.7 to 28.6 s on the tuning set and 19.0 to 27.8 s on the check set (8a to 9b'), one full pipeline per part; the longest is Q06 at 41.1 s. Not kept: decomposeQuestions off. Round count: 9a and 9b reverted, presets unchanged from round 8a.

Cause tables, round 9 (as above):

| Run | Set | Retrieval miss | Selection cut | Model error | Abstention error | No failure |
| --- | --- | --- | --- | --- | --- | --- |
| 9a | tuning | 2 (Q04, Q08) | 0 | 15 | 1 (Q10) | 11 |
| 9a | check | 1 (Q33) | 0 | 9 | 0 | 4 |
| 9b | tuning | 2 (Q04, Q08) | 0 | 15 | 1 (Q10) | 11 |
| 9b | check | 1 (Q33) | 0 | 9 | 0 | 4 |
| 9b' | tuning | 2 (Q04, Q08) | 0 | 18 | 0 | 9 |
| 9b' | check | 1 (Q33) | 0 | 9 | 0 | 4 |

Neither change moves the cause mix: the model errors are coverage misses, and the extra items both changes bring in come with citations to sections the answer key does not expect. The external grading sheet ~/AskFiles-eval/spot-check-grading.md (the same 10 questions as spot-check.md, seed 20261031) carries the round 8a answers as shown, the full expected section text and the key elements, for a grader independent of the literal coverage count.

Hedge filter and document affinity re-test (2026-10-31, approved by the owner as two small changes and one targeted run on the kept configuration, round 2' plus enumerateWhenAsked; qwen3:14b-q4_K_M, context 8192, Balanced, verifyCitations on, both switches on together, Ollama restarted first; Q03, Q04, Q09, Q18, Q30, Q34 and the 10 absent-set questions, 16 in all; run folder ~/AskFiles-eval/runs/r10-targeted, compared with r8a). Judge: keep both only if Q04 and Q09 improve, Q03 and Q18 lose their hedge sentences, Q34 keeps its section and the absent set stays at 0 false answers; keep a passing switch alone when the other fails.

dropUnsupportedHedges (src/main/answer/hedges.ts) deletes, after verification, a sentence marked unsupported that only says information is missing, when the answer keeps a supported sentence. In the run it deleted Q18's sentence (The duration for which the risk owner should monitor the risk is not explicitly stated in the provided sources.). Q03 had no hedge to delete, because with documentAffinity's source headers the model replaced it with an unsupported page claim (It is on the physical PDF page 32 and the printed page 32.). Since the filter only acts on the verified sentences, it was also applied to every recorded round 8a answer of the three sets: it deletes exactly four sentences, all unsupported hedges, Q03's (The physical PDF page and printed page are not specified in the sources.) and Q18's, plus one each in the formula questions Q07 and Q41, which are outside the gate; no supported sentence and no whole answer. Passes: kept, on in every preset.

documentAffinity as built in round 7, plus 6 sections (AFFINITY_MULTI_SECTIONS) when a question names two or more files. Q04 improves (both documents named, 6 sections: right section cited, attribution yes, coverage 0.50 to 1.00). Q09 does not: both guidances named, but the third ask is answered from the Value for Money Guidance's own Contract Management Plan section, so the expected section is still not cited and attribution falls from yes to no (coverage 0.86 both). Q34 loses its section: the Scanned Historical Records file is named, and the answer comes from page 17 instead of 19 (wrong agent and SUBJECT, coverage 0.50 to 0.00). Q30, an absent question in the tuning set that names the Template, is answered again (not specified ... [1] twice) instead of NOT_IN_SOURCES, as in round 7. The absent set stays at 0 of 10 false answers. Fails: documentAffinity stays off. Presets: verifyCitations, enumerateWhenAsked and dropUnsupportedHedges on; documentAffinity, enumerateFollowUp, noSummarizing, decomposeQuestions, paragraphSelection and verdictLine off.

**User test**: give the DMG by USB to one or two real target users with a one-page task sheet (install, add a folder, ask five questions). Do not help. Record where they stop and time to first answer. Executor: YOU.


### v1 result

Phase 2 closed on 2026-11-01 (owner decision). The kept configuration is config/presets.json:

| Tier | Ask | Chat model | Source |
| --- | --- | --- | --- |
| 32 GB and above | on | qwen3:14b-q4_K_M | Ollama library (digest bdbd181c33f2, the same weights as qwen3:14b) |
| 16 GB | on | hf.co/unsloth/Qwen3-14B-GGUF:Q3_K_M | Pinned: repository unsloth/Qwen3-14B-GGUF, revision a04a82c4739b3ef5fa6da7d10261db2c67dd1985, file Qwen3-14B-Q3_K_M.gguf, sha256 9694f1db203d5a18bea6f19a36be01b2d2c79bf9b7f8df553a4cc5cff870b47e, 7321313664 bytes. Ollama cannot pull a revision, so the app checks the pulled weights against the sha256 and refuses any other file (docs/presets.md) |
| 8 GB | off | none | The Ask page shows one line (Ask needs a Mac with 16 GB of memory or more; on this Mac use Browse and Find to read your documents.); Browse and Find are unchanged; only the embedder is pulled |

Every tier: embedder bge-m3:567m, context 8192 tokens, chunk maximum 2000 characters, no reranker (fused order with a vector floor), sections and floor per scope strict 3 / 0.6, Balanced 5 / 0.55 (the default), broad 6 / 0.5, temperature 0.1, thinking off, answerMode single, promptVariant default. Answer switches on: verifyCitations (round 2), enumerateWhenAsked (round 8a), dropUnsupportedHedges (after round 9). Unused options, built and measured but off on every tier: paragraphSelection, verdictLine, documentAffinity (with its 6 sections for questions naming several files), enumerateFollowUp, noSummarizing, decomposeQuestions, answerMode quoted, promptVariant strict and complete.

Metrics of the kept configuration on the 32 GB tier: round 8a (qwen3:14b-q4_K_M, context 8192, Balanced, one pass per question, Ollama restarted before every run; run folders ~/AskFiles-eval/runs/r8a-*). dropUnsupportedHedges came later and only deletes unsupported hedge sentences; applied to the recorded round 8a answers it deletes four (Q03, Q18 and the formula questions Q07, Q41) and changes no metric (Q03 coverage stays 1.00, Q18 0.60). Gated figures leave out cross_document and Q07 and Q41; the variance band is under Acceptance and stopping rules.

| Set | Right section cited | Attribution | Key element coverage | Median total | False refusals | False answers |
| --- | --- | --- | --- | --- | --- | --- |
| tuning (questions-v3.csv) | 92% (23/25) | 89% (24/27) | 74% | 18.4 s | 4% (1/25) | 0% (0/2) |
| check (questions-check-v2.csv) | 90% (9/10) | 79% (11/14) | 53% | 13.9 s | 0% (0/10) | 0% (0/4) |
| absent (questions-absent.csv, provisional) | - | - | - | 12.5 s | - | 0% (0/10) |

Attribution as measured: 24 of 27 answers on the tuning set and 11 of 14 on the check set have the right attribution (the expected section cited, or a correct refusal), so about 1 in 9 tuning answers and 1 in 5 check answers cite a section other than the expected one or miss it. The failures are Q03 (cites the Contents page as well), Q08 (OCR, retrieval miss) and Q27 on the tuning set, and Q33 (retrieval miss, fused rank 13), Q39 and Q40 (table arithmetic) on the check set.

The 16 GB model was measured in the quantization and context matrix (above) with the round 2' configuration, before enumerateWhenAsked and the hedge filter: tuning and check sets together 91% (32/35) cited, 80% (33/41) attribution, 68% coverage, 3% false refusals, 6% (1/16) false answers, median 15.9 s, 7.45 GiB for the chat model in memory against 9.17 GiB for q4_K_M. It ran on the 64 GB Mac; it has not run on a 16 GB Mac.

Completeness, graded by the owner from ~/AskFiles-eval/grading-all.md (round 8a answers as shown, the full expected section text and the key elements, formula questions left out): 28 of 35 complete: the sheet holds 37 entries (21 single_fact, 9 middle_of_long_doc, 5 table_number, 2 cross_document), and Q08 (OCR) and Q33 (retrieval miss) were left out of the grading. By category: single document and long document 25 of 28, tables 3 of 5, cross document 0 of 2.

Known limits of v1:

- Table reading: answers misread or miscompute table cells (Q25, Q39, Q40; 3 of 5 table questions complete).
- Cross-document questions: an answer that needs a section from each of two files usually finds one and says the other does not cover it (Q04, Q09; 0 of 2 complete). documentAffinity fixed Q04 but lost Q09 and Q34 and answered the absent Q30, so it is off.
- OCR quality: scanned pages give poor text for retrieval and for the answer (Q08 not retrieved; Q34 cites its page but gets the agent name partly unsupported).
- Spreadsheet formulas: the split does not keep a workbook's formulas (see Acceptance and stopping rules), so a question about a formula cannot be answered from the indexed text (Q07, Q41, marked unsupported and outside every metric).

### Indexing rounds, 2026-11-01

Three fixes in the indexing layer, each behind a switch in the preset's indexing block (docs/eval.md, Indexing switches), measured one at a time under the round rules above: kept only if no gating metric falls more than 3 points on any set. Same Mac, models and answer configuration as the v1 result (qwen3:14b-q4_K_M, context 8192, Balanced 5 / 0.55, verifyCitations, enumerateWhenAsked, dropUnsupportedHedges), one pass per question, Ollama restarted before every stage 2 run; branch local/indexing; run folders ~/AskFiles-eval/runs/i0-* to i3-*. Four sets: tuning (questions-v3.csv), check (questions-check-v2.csv), absent (questions-absent.csv) on the owner's first corpus, and a Chinese set (questions-zh.csv, 25 questions: 18 gated answerable, 2 cross_document, 5 absent) on the Chinese benchmark corpus (15 files: 12 PDFs, 1 Word, 1 workbook, 1 text file). Each corpus has its own eval workspace (askfiles-eval-en, askfiles-eval-zh), so indexing one never evicts the other. Every switch changes the section records, so each round reindexed the corpus it affects.

Answer keys follow the sections. A switch that moves or renames sections would otherwise fail questions whose facts did not move, so before each round's stage 2 the expected sections were remapped mechanically from the round's own split (stage 1 first, then the remap): the sections of the same file that hold the literal key elements of the old expected section, fewest first, the old title and pages preferred on a tie; a table row counts when all words of a key element are on one of its lines; a question whose old section still holds them all keeps its key (docs/eval.md, Indexing switches). Remapped in I1: Q05 and Q39 to the table section Bid/Proposal Example (using the 0 to 4 scale example above), Q40 to its table plus Initial Technical Score, Q33 back to the unsplit Market Research and Analysis (the table took enough text out that the section is no longer split by page), Chinese Q16 and Q17 to the specification table (one section for pages 3 to 9). In I2, 16 of the 25 Chinese questions moved, all to the sections the benchmark's own notes name (Q01 第五条, Q02 第二条, Q11 3.2.1 预付款, Q14 3.2.2 进度款, Q20 1. 评标方法 and so on); the old keys pointed at whichever font-size section happened to hold the text. The English keys did not change in I2 or I3. The remapped keys and the remap and gating scripts are in ~/AskFiles-eval/keys-indexing, outside the repository.

A harness hazard found on the way: document names come from the split key, so a second indexing under the same key reused the first one's document JSON and cached vectors although the code had changed, and every section after the first change was off by one. Each switch now carries a revision in the split key (INDEXING_REVISION in src/main/sections/types.ts), bumped whenever its output changes; the same mechanism makes a library reindex when a release changes a switch.

| Round | Change | Set | Right section cited | Attribution | Key element coverage | Median total | False refusals | False answers | Kept |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I0 | Baseline: the v1 configuration, separate eval workspaces | tuning | 92% (23/25) | 89% (24/27) | 74% | 18.4 s | 4% (1/25) | 0% (0/2) | baseline |
| I0 | same | check | 90% (9/10) | 79% (11/14) | 53% | 13.7 s | 0% (0/10) | 0% (0/4) | baseline |
| I0 | same | absent | - | - | - | 12.5 s | - | 0% (0/10) | baseline |
| I0 | same | Chinese | 78% (14/18) | 83% (19/23) | 90% | 14.0 s | 0% (0/18) | 0% (0/5) | baseline |
| I1 | structuredTables: tables as rows with header labels, own section, cut by rows, header in every chunk | tuning | 96% (24/25) | 93% (25/27) | 75% | 14.2 s | 4% (1/25) | 0% (0/2) | yes: cited +4, attribution +4 |
| I1 | same | check | 90% (9/10) | 79% (11/14) | 65% (58 to 65% over the same 9 questions) | 15.7 s | 0% (0/10) | 0% (0/4) | yes |
| I1 | same | absent | - | - | - | 8.4 s | - | 0% (0/10) | yes |
| I1 | same | Chinese | 89% (16/18) | 87% (20/23) | 95% | 13.2 s | 0% (0/18) | 0% (0/5) | yes: cited +11, attribution +4, coverage +5 |
| I2 | cjkHeadings revision 1, on I1 | Chinese | 72% (13/18) | 78% (18/23) | 93% | 6.4 s | 0% (0/18) | 0% (0/5) | no |
| I2 | cjkHeadings revision 2 (cover form lines are not headings), on I1 | Chinese | 67% (12/18) | 74% (17/23) | 93% | 6.4 s | 0% (0/18) | 0% (0/5) | no: cited -22, attribution -13 |
| I2 | revision 1, English sets (chunks identical to I1) | tuning | 96% (24/25) | 93% (25/27) | 77% | 14.4 s | 4% (1/25) | 0% (0/2) | unchanged |
| I2 | same | check | 90% (9/10) | 79% (11/14) | 63% | 15.7 s | 0% (0/10) | 0% (0/4) | unchanged |
| I2 | same | absent | - | - | - | 8.4 s | - | 0% (0/10) | unchanged |
| I3 | ocrUpscale: page images to about 300 dpi, at least 2400 px wide, before OCR, on I1 | tuning | 88% (22/25) | 81% (22/27) | 70% | 15.4 s | 4% (1/25) | 0% (0/2) | no: cited -8, attribution -12, coverage -5 |
| I3 | same | check | 90% (9/10) | 79% (11/14) | 65% | 15.7 s | 0% (0/10) | 0% (0/4) | no |
| I3 | same | absent | - | - | - | 8.8 s | - | 0% (0/10) | no |
| I3 | same (the Chinese corpus has no page images to OCR) | Chinese | 89% (16/18) | 87% (20/23) | 95% | 14.0 s | 0% (0/18) | 0% (0/5) | no |

Round I1 detail. Tables found by text positions in the PDFs (columns from gaps that run through every row, rows from the column with the most separate cells, lines of vertically centred cells to the nearest row), Word tables and sheets; only tables with a header row become sections, headerless ones (forms, layout boxes, clause and text side by side) stay in their section as row lines. Rejected as tables: bullet lists, fill-in-the-blank lines of the Chinese templates, gapped prose in boxes (cells starting in lower case), two-column runs with one row. A table over a page break is one table (the Chinese specification table runs from page 3 to page 9 with its header repeated per page). Sections and chunks: 843 sections and 1262 chunks to 899 and 1304 on the English corpus, 306 and 345 to 322 and 367 on the Chinese one. Table questions apart from the rest (gated, Q07 and Q41 left out):

| Set | Table questions | Before (I0) | After (I1) | Other answerable, before | Other answerable, after |
| --- | --- | --- | --- | --- | --- |
| tuning | Q05, Q24, Q25 | cited 3/3, attribution 3/3, coverage 61% | cited 3/3, attribution 2/3, coverage 67% | cited 20/22, attribution 19/22, coverage 75% | cited 21/22, attribution 21/22, coverage 76% |
| check | Q39, Q40 | cited 2/2, attribution 0/2, coverage 20% (2) | cited 1/2, attribution 0/2, coverage 33% (1) | cited 7/8, attribution 7/8, coverage 61% | cited 8/8, attribution 7/8, coverage 69% |
| Chinese | Q16, Q17, Q18 | cited 1/3, attribution 1/3, coverage 100% | cited 2/3, attribution 1/3, coverage 100% | cited 13/15, attribution 13/15, coverage 88% | cited 14/15, attribution 14/15, coverage 94% |

Q39 was wrong before (weighted scores 100, 50, 30, subtotal 180) and is right now (150, 50, 30, subtotal 230, total 240); the coverage figure cannot show it, because its key elements (weighted scores 150 50 30, Sustainability 10% 1 10) are no longer word for word in the labelled rows, so the harness leaves Q39 out of coverage. Q40 went the other way: it now reads 150 from the Illustrative Scoring Example 2 table instead of 100 from its own, and its key needs both the table and Initial Technical Score. Q05 gives the same right answer but also cites the parent section, which no longer holds the numbers, so attribution fails. Q25 coverage 0.17 to 0.33, Q27 and Q33 now cite their sections (Q33 was a retrieval miss in every round since 6), Q38 lost attribution and coverage (0.67 to 0.17), Chinese Q17 cited, Chinese Q03 and Q05 coverage 0.50 to 1.00. Median total fell on the tuning and absent sets (prompts are shorter: median 2776 to 2608 tokens on the tuning set) and rose 2.0 s on the check set (median prompt 2474 to 2776 tokens), still under 20 s. Kept: structuredTables on.

Round I2 detail. Chinese numbered headings (第X章, 第X节, 第X条, 一、, （一）, 1. 1.1 1.1.1) at line start next to the font-size headings, levels by nesting (font size first, then the numbering kind); articles split from their first sentence; wrapped titles joined; a numbered line as wide as a full line with the paragraph going on below it stays text; page numbers and running headers or footers removed; contents pages dropped; letter-spaced titles closed up; lines in reading order (pdf.js gives them in drawing order, which put each page's footer first and moved every heading of a dense page ahead of its text, a bug in the font-size path too, hidden while headings were sparse). Only for documents with at least 30 percent CJK, so the English chunks are byte for byte those of I1. 322 sections and 367 chunks to 687 and 693 on the Chinese corpus; the regulations went from 2 or 3 sections each to one per article (04: 2 to 7, 05: 2 to 25, 09: 3 to 29), the three standard templates from 94, 86 and 106 sections to 162, 152 and 220. Median total halved (13.2 to 6.4 s): the sections the model reads are short. The losses: Q08, Q11 and Q13 answer correctly with a citation to the expected section, but citation verification marks the sentence unsupported, because a paraphrased Chinese sentence shares under half of its character pairs with a 130 to 550 character section (Q11: 0.44 against 3.2.1 预付款, 0.58 against the old 693 character section that held the same sentence among others); Q01 cites the identical 第五条 of the Word copy of the same regulation (13_必须招标的工程项目规定.docx), which now has article sections with the same titles; Q05 loses one key element. Q19 gains. Both revisions fail the round, so cjkHeadings is off. The fix this points at is in the answer layer (verification threshold or passage for short CJK sources, a rule for identical sections in two files), which is a separate round for the owner to approve.

Round I3 detail. The scanned file (09_Scanned_Historical_Records.pdf, 26 garbled pages OCRed, images about 100 dpi, 1-bit) scaled to at least 2400 px wide before tesseract. Time per page, the 26 pages through the collector four at a time, fresh (cache set aside): 338 ms per page (8.8 s) before, 590 ms per page (15.3 s) after. The text does not get better: on the pages the three OCR questions need, the fields are read the same (page 7 still lacks 44-387 and MURKIN, page 17 still lacks SAC, Albany and the date in the OCR text, page 19 has 6/6/68 and GEORGE A. STRONG both times); the share of clean tokens over the 26 pages fell from 0.80 to 0.77. Q08 now answers (DIRECTOR, FBI (44-38861), SUBJECT MURKY) instead of refusing, Q29 and Q34 are unchanged, and Q03 (now refused) and Q27 lost their sections; neither is about the scanned file, and the cause was not traced. Not kept: ocrUpscale off.

Presets after the rounds: indexing structuredTables on in every tier; cjkHeadings and ocrUpscale built, unit tested and off. The gating figures of the kept configuration (round I1) beside the v1 result (the English rows are round 8a, docs/plan.md v1 result; the Chinese v1 row is run zh1-zh, made at the v1 commit 2693096c on 2026-11-01 before this branch):

| Set | Configuration | Right section cited | Attribution | Key element coverage | Median total | False refusals | False answers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tuning | v1 | 92% (23/25) | 89% (24/27) | 74% | 18.4 s | 4% (1/25) | 0% (0/2) |
| tuning | v1 + structuredTables | 96% (24/25) | 93% (25/27) | 75% | 14.2 s | 4% (1/25) | 0% (0/2) |
| check | v1 | 90% (9/10) | 79% (11/14) | 53% | 13.9 s | 0% (0/10) | 0% (0/4) |
| check | v1 + structuredTables | 90% (9/10) | 79% (11/14) | 65% | 15.7 s | 0% (0/10) | 0% (0/4) |
| absent | v1 | - | - | - | 12.5 s | - | 0% (0/10) |
| absent | v1 + structuredTables | - | - | - | 8.4 s | - | 0% (0/10) |
| Chinese | v1 | 78% (14/18) | 83% (19/23) | 90% | 14.2 s | 0% (0/18) | 0% (0/5) |
| Chinese | v1 + structuredTables | 89% (16/18) | 87% (20/23) | 95% | 13.2 s | 0% (0/18) | 0% (0/5) |

What the Browse outline shows for Chinese documents. With the kept presets the outline of a Chinese PDF is the same as in v1 except for tables: headings come from larger fonts, a table with a header row is an entry of its own under the heading it stands in, and the contents pages and letter-spaced cover titles stay as they were. The first ten entries of 01_标准设备采购招标文件_2017年版.pdf, indented by level:

```
附件 1
中 华 人 民 共 和 国
标 准 设 备 采 购 招 标 文 件
  使用说明
    （项目名称）设备采购
  招标文件
    招标人： （盖单位章）
      年 月 日
        目 录
          目 录 (page 4)
```

With cjkHeadings on (not in any preset) the same file reads:

```
附件 1
中华人民共和国
标准设备采购招标文件
  使用说明
    （项目名称）设备采购
  招标文件
第一卷
  第一章招标公告（适用于公开招标）
    （项目名称）设备采购招标公告
      1. 招标条件
```

and the regulations list their articles (第一条 to 第六条 for 04_必须招标的工程项目规定.pdf, which v1 showed as two entries). Known limits left by the rounds: a two-by-two diagram in a PDF can still pass for a two-column table (one remains on page 45 of the Procurement Strategy Guidance); a header row whose cells wrap over two lines can lose its second line to the first data row; footnote marks in a header cell stay in the label (一级1指标 on page 2 of the Chinese specification).

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

Write .github/workflows/mac.yml for macos-15 (originally macos-14): build, package, ad-hoc sign, upload the DMG, then smoke test by launching the app, polling /api/ping, uploading a sample PDF and making one chat call. Implement src/main/watcher with chokidar or fs.watch: debounce, upload, re-embed, remove, status events. Unit tests for the watcher. Success: workflow file lints; watcher tests green.

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
| 1 Shell | 6 to 11 | Package tests and copy tests | Analysis, skeleton, process manager, wizard logic, presets, model manager, CI workflow | Sessions A to G merged on 2026-10-29 (PRs 1 to 7). On the macos-14 CI runner (Session F PR; CI moved to macos-15 on 2026-10-30): build 65 s, package job 22 min, smoke test 3 min 45 s, one chat answer 38 s. Session I: DMG 695 967 267 bytes (663.7 MiB) before, 578 415 079 bytes (551.6 MiB) after; package job 26 min 45 s before, 4 min 15 s after with warm caches (9 min 27 s with empty ones) (docs/bundle-report.md) |
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
