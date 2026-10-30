# The app: windows, first run, bridge and watcher

Written by Session H (plan tasks 3.4 and 3.5). Code in src/main; pages in src/renderer.

## Start sequence

1. src/main/index.ts registers the askfiles scheme, opens the window on a starting page and, in the packaged app, hands over to AppController (src/main/app.ts).
2. AppController loads the preset for this Mac's RAM from config/presets.json (or ASKFILES_PRESETS_FILE), seeds the OCR language data (below), then starts Ollama, collector and server through the process manager with `askfiles://app` as an allowed origin (patch 005).
3. It reads `<dataDir>/shell.json`. Without the completed-setup marker the window shows the onboarding page and the first run starts; with it the window shows the Ask page and the folder watcher starts.

`<dataDir>` is ~/Library/Application Support/AskFiles.

## Pages

The window loads our pages from the app bundle, never from the server: `askfiles://app/<page>/index.html` maps to src/renderer/<page>/index.html inside app.asar (src/main/app-protocol.ts). A custom scheme rather than file://, because Chromium refuses ES modules from file:// URLs, and a standard secure scheme gives every page the one origin `askfiles://app`, which the server allows and which keeps the recent questions in localStorage. Pages: onboarding, search, models (menu AskFiles > Models, once set up), about (menu AskFiles > About AskFiles). `askfiles://app/THIRD-PARTY-NOTICES` serves the notices file from the app root for the About page.

The window title stays AskFiles whatever a page sets. Navigation is limited to `askfiles://app`, and to the server's origin only behind the developer switch.

## Developer switch to the upstream interface

`ASKFILES_UPSTREAM_UI=1` opens the upstream web interface the server serves instead of our pages. Environment variable only; there is no keyboard shortcut. On the Mac:

```
ASKFILES_UPSTREAM_UI=1 /Applications/AskFiles.app/Contents/MacOS/AskFiles
```

With ASKFILES_PORT (or the config file) the app connects to a server started by hand instead of its own: the Ask page by default (without the library, so it cannot answer), the upstream interface with ASKFILES_UPSTREAM_UI=1. That server must allow the page origin: start it with ANYTHING_LLM_ALLOWED_ORIGINS=askfiles://app.

## First run

src/main/first-run.ts, a state machine around the Session E wizard:

```
idle -> models (the wizard: RAM, tier, pull, .env, server restart, onboarding flag)
     -> chooseFolder (native dialog, or ASKFILES_LIBRARY_FOLDER, or the folder already stored)
     -> createLibrary (API key, library workspace with the preset's settings)
     -> indexing (watcher started, waits until the folder is indexed; unreadable files end on the dead-letter list and do not block)
     -> done
any step --throws--> error --retry()--> the step that failed
```

Marked complete by `setupCompletedAt` in `<dataDir>/shell.json`, written only when the run reaches done. A first run cut off by a quit starts again at the next launch; every step is safe to repeat (installed models are skipped, the stored folder is reused if it still exists, the stored key is kept if the server accepts it, the library workspace is found by name and gets the preset settings again, the watcher reconciles against index.json).

## Where the API key lives

`<dataDir>/shell.json`, mode 0600, next to the folder and the workspace slug:

```json
{ "version": 1, "folder": "/Users/anna/Documents", "workspaceSlug": "askfiles-library", "apiKey": "...", "setupCompletedAt": "2026-10-29T10:00:00.000Z" }
```

The key is a developer API key of the local server, created with POST /api/system/generate-api-key during the first run. The main process uses it for the watcher and the answer pipeline's vector search, and the Ask page gets it through the bridge for the library count.

## Bridge

One preload script, src/main/preload.ts, for every window. Windows run with contextIsolation, sandbox and nodeIntegration off; the preload loads nothing but electron and compiles to a plain script (tsconfig moduleDetection legacy). Types and channel names: src/main/bridge/contract.ts; main side: src/main/bridge/register.ts and AppController. Every on* function returns an unsubscribe function; errors reach the page as their plain message.

| Page call | Main process |
| --- | --- |
| `askfiles.setup.onEvent(cb)` | First-run events: wizard `state`, `tier`, `progress`; `setup` (state, failedStep, error, folder); `indexing` (watcher status). A late subscriber gets a replay of the current state |
| `askfiles.setup.start()`, `.retry()` | FirstRun.start (joins a run in progress), FirstRun.retry |
| `askfiles.setup.chooseFolder()` | Native folder dialog; `{ folder }`, or null when cancelled |
| `askfiles.models.list()`, `.pull(tag)`, `.onProgress(cb)`, `.remove(tag)`, `.switchChat(tag)` | ModelManager (Session E); a switch restarts the backend and reloads the Ask page; the answer pipeline reads the chat model from the server .env |
| `askfiles.watcher.status()`, `.onStatus(cb)` | Watcher status plus `folder`, and `error` when the folder cannot be watched |
| `askfiles.library.resolveSources(sources)` | FolderWatcher.resolveSources: section title and pages for vector-search results |
| `askfiles.library.openOriginal(source)` | Reveals the original file in Finder, mapped through index.json from the file URL, the stored document path or the upload file name (src/main/open-original.ts); false when no indexed file matches |
| `askfiles.browse.documents()` | BrowseIndex.listDocuments: every document with path, title, size, modified time and outline, no section text |
| `askfiles.browse.document(ref)` | BrowseIndex.getDocument: one document with its sections, by `{ id }` or by a source's `{ url, title }`; null when unknown |
| `askfiles.browse.headings(key)` | BrowseIndex.headings: headings grouped across documents, most documents first; with a key, that group only, with section text |
| `askfiles.browse.search(query)` | BrowseIndex.search: keyword hits grouped by document and section, with snippet and match positions |
| `askfiles.answer.ask(question)` | AnswerService.ask (src/main/answer/service.ts): starts the pipeline, returns `{ id }`; a new question cancels the one before |
| `askfiles.answer.onEvent(cb)` | Events of the asking page's runs, each with the run `id`: `stage` (retrieving, answering), `sources` (the numbered sections the model reads), `delta` (text and citation parts), `trace` (developer mode only), `done` (`result`: text, notFound, claims, cited, considered, nearest, timings), `error` |
| `askfiles.answer.cancel(id)` | Stops the run |
| `askfiles.answer.developer()`, `.setOverrides(o)`, `.saveCase(c)` | Developer panel, only with ASKFILES_DEVELOPER=1: last trace and live section count and rerank floor for the next question; Save as eval case appends to `<dataDir>/eval-questions.csv` (ASKFILES_EVAL_QUESTIONS overrides) |
| `askfiles.app.info()` | `{ name, version }` for the About page |
| `askfiles.app.pageReady(info)` | Logs `[main] page ready ask connected=true documents=N`; the smoke test waits for it |
| `window.shellConfig` | `{ baseUrl, apiKey, workspace, folder, resolveSources, openSource }`, read once per page load |

src/main/bridge/bridge.test.ts runs the preload in the same function wrapper the sandbox uses, wired to the real registerBridge, and fails when a page calls a function the bridge does not expose.

## Ask page status bar

Folder, indexed file count, indexing state (Indexing, N left; Up to date; Folder not available) and the number of files on the dead-letter list, with their errors in the tooltip, all from watcher events through the bridge.

## Browse view

The switch at the left of the status bar shows Ask or Browse in the same page (src/renderer/ask/index.html); both stay in the page, so each keeps its state and nothing reloads. Browse (src/renderer/browse/view.js, also standalone at browse/index.html) has a library page (every document, outline collapsed, sort by name or last change, indexing state), a document page (sections in order with an outline rail, an anchor per section, Open original), a headings page (headings found in two or more documents, optionally all; a heading shows that section from every document side by side) and a find page (keyword search, hits grouped by document and section). Source cards and the section list on the Ask page have Read section, which opens the cited section on the document page. No model and no server call: everything comes from the browse index.

The browse index (src/main/browse) is one JSON file per document in `<dataDir>/browse/<id>.json`, id the first 16 hex digits of sha256 of the file path:

| Key | Content |
| --- | --- |
| `version`, `id`, `path`, `url`, `relPath`, `title` | 1; the id; the file's path, file URL, path in the library folder and file name |
| `size`, `mtimeMs`, `hash`, `splitKey`, `indexedAt` | From the index.json record; hash and splitKey decide when the sections are read again |
| `outline` | `{ title, level, sectionIndex, page, children }`, nested by heading level; a heading the splitter folded into the next section (a chapter heading right above its first subsection) gets an entry one level up pointing at that section; text before the first heading gets none |
| `sections` | `{ index, title, level, lead, heading, pageStart, pageEnd, text }`: index is the sectionIndex of the section documents and search sources; text is the section's sub-chunks joined again, the heading lines the chunker put in front of each taken off; heading is the normalized key, empty for text before the first heading and for the Page N sections of a PDF without headings |

Built from the index.json record and the section documents under STORAGE_DIR/documents, so it shows exactly the split that retrieval embeds, OCR text included. Kept current from the watcher's file events (indexed, unchanged, removed); after every watcher start, sync drops entries for files the watcher no longer has and builds missing ones. Loaded before the watcher starts, so the library shows during a long reconcile.

Heading normalization (src/main/browse/normalize.ts): NFKC, which turns full-width letters, digits and punctuation into half-width; lower case; numbering prefixes removed, repeatedly (1, 1., 1.2.3, 1), 1、, (1), (a), a), I., IV), Chapter 3, Section 2.1, Part II, Article 5, Appendix A, § 4, 第一章, 第12节, 第三条, 第二部分, 一、, (一)); then punctuation and symbols removed and whitespace collapsed. Number parts have at most three digits, so 2026 Budget keeps its year. A heading that is only numbering (第一章 alone) keeps it.

Keyword search (src/main/browse/search.ts): the query is split at whitespace; each term, folded the same way (NFKC, lower case), must occur as a substring of the section title or text. No word boundaries, so Chinese matches inside a sentence. Documents with the most matches come first, sections in document order; at most 200 sections are returned, the total is always counted.

## Answer pipeline

The Ask page answers through the shell (src/main/answer), not through the upstream chat route; upstream stays the document store, parser, OCR, embedder and vector database (docs/plan.md, Decisions). For each question:

1. Candidates. Vector: POST /api/v1/workspace/:slug/vector-search with scoreThreshold 0 and topN vectorTopK; each chunk is mapped to its section by text through the watcher's records (resolveSources). Keyword: terms from the question (quoted phrases, numbers and codes, capitalized names, rare words and word pairs, rare Chinese 2 to 4 character n-grams; rare means in few sections of the browse index) ranked by BM25 over the browse index's section text (src/main/browse/rank.ts), any term matching. Both lists are fused by reciprocal rank fusion and summed per section.
2. Sections: the best candidateSections sections, their text from the browse index (sub-chunks joined in document order), cut to twice the chunk maximum around the vector hit.
3. Rerank: a cross-encoder scores question and section path plus text. It runs in a child process of the app's binary (ELECTRON_RUN_AS_NODE, src/main/answer/reranker-worker.ts), because onnxruntime-node blocks the calling thread for the whole model call (measured: 1.7 s for 8 sections with MiniLM on 4 Linux vCPUs, during which a main-process timer did not fire); it loads @xenova/transformers from the bundled server's node_modules, starts on the first question and stays loaded until quit; the model files are in `<dataDir>/models/reranker/<repo>`, fetched by the first-run wizard (and in the background on the first launch of a library set up before this existed). Without them, or for a mainly Chinese question or candidate when rerankerBypassCjk is on, the fused order is used and no floor applies.
4. Select: sections at or above the rerank floor, at most the scope's section count, within the token budget (context length minus 1536); whole sections, the longest trimmed only when they do not fit. Answer scope comes from the settings store (Session K); until it exists, Balanced.
5. Prompt and model: numbered sources with their section path, never a file name or page; one streamed POST /api/chat to the bundled Ollama with think false, the preset's temperature and num_ctx. When no section passes the floor the model is not called.
6. Output: [n] citations are parsed as they stream (a citation cut between chunks is held back); the cards show the cited sections in citation order with file name, section path, PDF pages and printed page label (when the section records carry one), and the passage the model read, all from the section records. Selected but uncited sections are under Other sections considered. The reply NOT_IN_SOURCES shows the nothing-found list with the best reranked sections. A sentence without a citation gets a muted marker.

The main log gets one line per question, without the question text: `[answer] 2 cited of 3 selected, 12 candidates, vector 45 ms, keyword 2 ms, rerank 640 ms, first token 900 ms, total 4100 ms`.

## OCR in the watcher

A PDF without a text layer is uploaded once to the collector without embedding, its text kept and the collector's copy deleted; the text is cached by file hash in `<dataDir>/ocr-cache`. The splitter then treats it as plain text, so its sections record page 0, stored as no page in index.json. The same path the eval harness takes (scripts/eval/library.ts). Languages: TARGET_OCR_LANG from the preset (eng,chi_sim), written into server/.env by the wizard.

The language data never downloads: @tesseract.js-data/eng and @tesseract.js-data/chi_sim (4.0.0_best_int) are runtime dependencies of the shell and ship in app.asar; at every launch src/main/tesseract.ts copies any missing language, unpacked, to `<dataDir>/storage/models/tesseract`, where the collector's tesseract.js looks first. Session B had not shipped these files, so Session H added the packages.

## Smoke test

scripts/smoke-mac.sh starts the packaged app on an emptied data directory (the model cache is kept) with ASKFILES_PRESETS_FILE=test/fixtures/presets-smoke.json (qwen3:0.6b, all-minilm, threshold 0) and ASKFILES_LIBRARY_FOLDER set to a temp folder holding test/fixtures/handbook.pdf and test/fixtures/scanned.pdf. The app is also started with ASKFILES_SMOKE_QUESTION, which makes it ask that question through the answer pipeline once the Ask page reports ready and log the result. The script waits for the first run to finish, for the Ask page's ready line in main.log, then checks the library, the index, the browse index (both PDFs listed in `<dataDir>/browse`), the reranker files and the OCR result, and waits for the `[answer] smoke` line with a [1] citation.

## Third-party notices

THIRD-PARTY-NOTICES at the repository root lists every bundled package with its license and each license text once; the About page shows it. A package that ships no license file gets the standard text of the license its package.json names, from scripts/license-texts (SPDX license-list-data v3.27.0: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, LGPL-3.0 with the GPL-3.0 text it builds on, MPL-2.0, CC0-1.0); when package.json names none, the license its readme states under a License heading, marked as from the readme. A package with no license anywhere is listed with its dependency path. scripts/third-party-notices.test.mjs fails when a listed package that names a license has no text in the file.

`npm run package:mac` regenerates the file on the Mac after scripts/build.sh has pruned the trees and before electron-builder and signing, and runs the test there; the mac workflow does the same and uploads the result. docs/packaging.md, Third-party notices, has the details. To regenerate the repository copy in a cloud session:

```
PACKAGE_TARGET=linux-x64 bash scripts/build.sh
npm run notices -- --strict
```
