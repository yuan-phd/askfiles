# The app: windows, first run, bridge and watcher

Written by Session H (plan tasks 3.4 and 3.5). Code in src/main; pages in src/renderer.

## Start sequence

1. src/main/index.ts registers the askfiles scheme, opens the window on a starting page and, in the packaged app, hands over to AppController (src/main/app.ts).
2. AppController loads the preset for this Mac's RAM from config/presets.json (or ASKFILES_PRESETS_FILE), seeds the OCR language data (below), then starts Ollama, collector and server through the process manager with `askfiles://app` as an allowed origin (patch 005).
3. It reads `<dataDir>/shell.json` (a version 1 file from before Session K becomes version 2 here, see Libraries). Without the completed-setup marker the window shows the onboarding page and the first run starts; with it the window shows the Ask page and the current library's watcher starts.

`<dataDir>` is ~/Library/Application Support/AskFiles.

## Pages

The window loads our pages from the app bundle, never from the server: `askfiles://app/<page>/index.html` maps to src/renderer/<page>/index.html inside app.asar (src/main/app-protocol.ts). A custom scheme rather than file://, because Chromium refuses ES modules from file:// URLs, and a standard secure scheme gives every page the one origin `askfiles://app`, which the server allows and which keeps the recent questions in localStorage. Pages: onboarding, ask (the Ask view and the Browse view under one top bar), settings (menu AskFiles > Settings..., Cmd+comma, once set up), models (no menu entry since Session K: Settings chooses the answer model; opened from the Developer page), developer (menu AskFiles > Developer, only with ASKFILES_DEVELOPER=1), about (menu AskFiles > About AskFiles). `askfiles://app/THIRD-PARTY-NOTICES` serves the notices file from the app root for the About page.

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
     -> createLibrary (API key, the All files workspace with the preset's settings)
     -> done
any step --throws--> error --retry()--> the step that failed
```

No folder is asked for (Session K): the app opens on the empty All files library, which shows one sentence and the Add button. Marked complete by `setupCompletedAt` in `<dataDir>/shell.json`, written only when the run reaches done. A first run cut off by a quit starts again at the next launch; every step is safe to repeat (installed models are skipped, the stored key is kept if the server accepts it, the workspace is found by name and gets the preset settings again).

## Libraries

src/main/libraries.ts (LibraryManager). A library is one upstream workspace plus the shell's own records under `<dataDir>/libraries/<id>/`:

| Path | Contents |
| --- | --- |
| index.json | The watcher's records: per file its hash, shown path, source id and section records (title, index, level, full heading path, pages, printed page labels, document location) |
| browse/ | The browse index, one JSON file per document |
| files/ | Copies of files added with Add files or by dropping files; the library's own, deleted with it |

Section documents go to `STORAGE_DIR/documents/askfiles/<id>/`. The default library, All files (id all-files, workspace askfiles-library as before Session K), exists from the first launch and cannot be renamed or deleted. Others get an id lib-xxxxxx and a workspace askfiles-<id>.

- Sources: linked folders (watched recursively, never modified, listed in shell.json) and the added files (the entries of files/). A folder inside a linked one is refused; a folder holding linked ones replaces them; a folder that holds or lies inside the data directory is refused. Files of a type the splitter cannot read are left out and reported.
- Only the current library runs a watcher (one FolderWatcher over all its roots, one queue). A folder that cannot be read at start (an unplugged drive) keeps its files in the index and shows as not available; a folder removed from the library loses its files at the next reconcile.
- Switching libraries restarts the watcher on the new library and reloads the main window, because the Ask page reads its workspace once per load.
- Delete removes the workspace (vectors included), the library's section documents and its folder under the data directory. Linked folders and original files are never touched.
- Reindex clears the library's index and documents and indexes every file again. SPLITTER_VERSION 2 does the same once for every library after the update from Session J, because the section records changed shape.
- Migration from shell.json version 1: the one folder becomes a linked folder of All files, and `<dataDir>/index.json` and `<dataDir>/browse` move to `libraries/all-files/`.

## Where the API key lives

`<dataDir>/shell.json`, mode 0600, with the libraries and the settings:

```json
{
  "version": 2,
  "apiKey": "...",
  "setupCompletedAt": "2026-10-30T10:00:00.000Z",
  "libraries": [
    { "id": "all-files", "name": "All files", "workspaceSlug": "askfiles-library",
      "folders": [{ "id": "folder-1", "path": "/Users/anna/Documents", "addedAt": "..." }], "createdAt": "..." }
  ],
  "currentLibrary": "all-files",
  "settings": { "answerScope": "balanced", "answerModel": "better", "contextLength": null }
}
```

The key is a developer API key of the local server, created with POST /api/system/generate-api-key during the first run. The main process uses it for the watcher and the answer pipeline's vector search, and the Ask page gets it through the bridge for the library count.

## Settings

src/main/settings.ts, the Settings page (src/renderer/settings). Exactly four controls:

| Control | Choices | Stored as | Applied to |
| --- | --- | --- | --- |
| Answer scope | Strict, Balanced (default), Broad | settings.answerScope | Read by Session L's answer pipeline through `askfiles.settings.get()` (section count and rerank floor); no effect before that pipeline merges |
| Answer model | Faster, Better (default) | settings.answerModel | OLLAMA_MODEL_PREF in server/.env. Better is this Mac's tier's chat model, Faster the next lower tier's; the lowest tier has no Faster. A model not yet installed is pulled first, with progress on the page |
| Context length | 4K, 8K, 16K tokens; null means the preset's (8K) | settings.contextLength | OLLAMA_MODEL_TOKEN_LIMIT in server/.env, sent to Ollama as num_ctx |
| Reindex this library | button | not stored | LibraryManager.reindex() |

Model and context changes write the .env through the presets code (writeServerEnv) and restart the server. The Developer page (ASKFILES_DEVELOPER=1 only) shows the data directory, the presets file, the settings, the preset of this Mac's tier and the preset with the settings applied.

## Bridge

One preload script, src/main/preload.ts, for every window. Windows run with contextIsolation, sandbox and nodeIntegration off; the preload loads nothing but electron and compiles to a plain script (tsconfig moduleDetection legacy). Types and channel names: src/main/bridge/contract.ts; main side: src/main/bridge/register.ts and AppController. Every on* function returns an unsubscribe function; errors reach the page as their plain message.

| Page call | Main process |
| --- | --- |
| `askfiles.setup.onEvent(cb)` | First-run events: wizard `state`, `tier`, `progress`; `setup` (state, failedStep, error). A late subscriber gets a replay of the current state |
| `askfiles.setup.start()`, `.retry()` | FirstRun.start (joins a run in progress), FirstRun.retry |
| `askfiles.models.list()`, `.pull(tag)`, `.onProgress(cb)`, `.remove(tag)`, `.switchChat(tag)` | ModelManager (Session E); a switch restarts the backend and reloads the Ask page; the answer pipeline reads the chat model from the server .env |
| `askfiles.watcher.status()`, `.onStatus(cb)` | The current library's watcher status plus `libraryId`, `unavailable` (folders that cannot be read) and `error` |
| `askfiles.libraries.list()`, `.onChange(cb)` | `{ current, libraries: [{ id, name, isDefault, isCurrent, indexed, sources: [{ id, kind, path, name, available }] }] }` |
| `askfiles.libraries.select(id)`, `.create(name)`, `.rename(id, name)`, `.remove(id)` | LibraryManager; select, create and a delete of the current library reload the main window |
| `askfiles.libraries.addFiles()`, `.addFolder()` | Native dialog, then copy or link into the current library; `{ added, skipped: [{ name, reason }] }`, null when cancelled |
| `askfiles.libraries.addPaths(paths)`, `.pathForFile(file)` | Drag and drop: the preload turns each dropped File into its path (webUtils.getPathForFile); folders are linked, files copied |
| `askfiles.libraries.removeSource(id)`, `.reindex()` | Unlink a folder or delete an added file's copy; reindex the current library |
| `askfiles.settings.get()`, `.set(change)` | The Settings page values, model choices and context choices; a model or context change restarts the server |
| `askfiles.developer.info()` | Data directory, presets file, settings, machine and effective preset; refused unless ASKFILES_DEVELOPER=1 |
| `askfiles.developer.openModels()` | Opens the Models window, which has no menu entry; refused unless ASKFILES_DEVELOPER=1 and set up |
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
| `window.shellConfig` | `{ baseUrl, apiKey, workspace, libraryId, libraryName, folder (always null), resolveSources, openSource }`, read once per page load; workspace is the current library's |

src/main/bridge/bridge.test.ts runs the preload in the same function wrapper the sandbox uses, wired to the real registerBridge, and fails when a page calls a function the bridge does not expose.

## Top bar

src/renderer/shared/topbar.js and topbar.css, mounted by the Ask page into `<header id="top-bar">`. It stays fixed while the views scroll (the body is a column; only the view scrolls). From left to right: the library switcher (library name, indexed count, indexing state: Indexing, N left; Up to date; Folder not available; the dead-letter count with errors in the tooltip), whose menu lists the libraries with their counts, creates one, and for the current library lists its sources with Remove, renames it, reindexes it and deletes it (asks once); the Add button (Add files, Add folder); the Ask and Browse switch. A library without sources shows one sentence and the Add button in place of both views. Dropping files or folders anywhere in the window adds them to the current library. The Ask page keeps the test ids status-count, status-state and status-failed.

## Browse view

The Ask and Browse switch in the top bar shows either view in the same page (src/renderer/ask/index.html); both stay in the page, so each keeps its state and nothing reloads. Browse (src/renderer/browse/view.js, also standalone at browse/index.html) has a fixed sidebar with Library, Headings, Find and, once a document is open, Document (labelled with the file name, its nested outline below it); only the content area scrolls, and each page keeps its scroll position. Library: every document, outline collapsed, sort by name or last change, indexing state. Headings: headings found in two or more documents; a heading shows that section from every document side by side. Find: keyword search, hits grouped by document and section. Document: sections in order, an anchor per section, the page and the printed page label when the PDF has one, Open original. Opening a document from any page, or Read section on the Ask page, always lands on Document and never changes the state of Library, Headings or Find. No model and no server call: everything comes from the browse index.

The browse index (src/main/browse) is one JSON file per document in `<dataDir>/libraries/<library id>/browse/<id>.json`, id the first 16 hex digits of sha256 of the file path:

| Key | Content |
| --- | --- |
| `version`, `id`, `path`, `url`, `relPath`, `title` | 2 (files of version 1 are rebuilt); the id; the file's path, file URL, shown path (linked folder's name and the path in it, or the added file's name) and file name |
| `size`, `mtimeMs`, `hash`, `splitKey`, `indexedAt` | From the index.json record; hash and splitKey decide when the sections are read again |
| `outline` | `{ title, level, sectionIndex, page, pageLabel, children }`, nested by heading level; a heading the splitter folded into the next section (a chapter heading right above its first subsection) gets an entry one level up pointing at that section; text before the first heading gets none |
| `sections` | `{ index, title, level, lead, heading, path, pageStart, pageEnd, pageLabelStart, pageLabelEnd, text }`: path is the full heading path from the section records; index is the sectionIndex of the section documents and search sources; text is the section's sub-chunks joined again, the heading lines the chunker put in front of each taken off; heading is the normalized key, empty for text before the first heading and for the Page N sections of a PDF without headings |

Built from the index.json record and the section documents under STORAGE_DIR/documents, so it shows exactly the split that retrieval embeds, OCR text included. Kept current from the watcher's file events (indexed, unchanged, removed); after every watcher start, sync drops entries for files the watcher no longer has and builds missing ones. Loaded before the watcher starts, so the library shows during a long reconcile.

The Headings page asks for headings found in two or more documents only (BrowseIndex.headings, minDocuments 2).

Heading normalization (src/main/browse/normalize.ts, numbering prefixes from src/main/sections/headings.ts): NFKC, which turns full-width letters, digits and punctuation into half-width; lower case; numbering prefixes removed, repeatedly (1, 1., 1.2.3, 1), 1、, (1), (a), a), I., IV), Chapter 3, Section 2.1, Part II, Article 5, Appendix A, § 4, 第一章, 第12节, 第三条, 第二部分, 一、, (一)); then punctuation and symbols removed and whitespace collapsed. Number parts have at most three digits, so 2026 Budget keeps its year. A heading that is only numbering (第一章 alone) keeps it.

Keyword search (src/main/browse/search.ts): the query is split at whitespace; each term, folded the same way (NFKC, lower case), must occur as a substring of the section title or text. No word boundaries, so Chinese matches inside a sentence. Documents with the most matches come first, sections in document order; at most 200 sections are returned, the total is always counted.

## Answer pipeline

The Ask page answers through the shell (src/main/answer), not through the upstream chat route; upstream stays the document store, parser, OCR, embedder and vector database (docs/plan.md, Decisions). For each question:

1. Candidates. Vector: POST /api/v1/workspace/:slug/vector-search with scoreThreshold 0 and topN vectorTopK; each chunk is mapped to its section by text through the watcher's records (resolveSources). Keyword: terms from the question (quoted phrases, numbers and codes, capitalized names, rare words and word pairs, rare Chinese 2 to 4 character n-grams; rare means in few sections of the browse index) ranked by BM25 over the browse index's section text (src/main/browse/rank.ts), any term matching. Both lists are fused by reciprocal rank fusion and summed per section.
2. Sections: the best candidateSections sections, their text from the browse index (sub-chunks joined in document order), cut to twice the chunk maximum around the vector hit.
3. Rerank: a cross-encoder scores question and section path plus text. It runs in a child process of the app's binary (ELECTRON_RUN_AS_NODE, src/main/answer/reranker-worker.ts), because onnxruntime-node blocks the calling thread for the whole model call (measured: 1.7 s for 8 sections with MiniLM on 4 Linux vCPUs, during which a main-process timer did not fire); it loads @xenova/transformers from the bundled server's node_modules, starts on the first question and ends after 15 minutes without one (`[answer] reranker <name> unloaded after 15 min idle`), so its memory goes back; the next question loads it again (`reloading`, then the worker's `loaded in N ms`); the model files are in `<dataDir>/models/reranker/<repo>`, fetched by the first-run wizard (and in the background on the first launch of a library set up before this existed). Without them, or for a mainly Chinese question or candidate when rerankerBypassCjk is on, the fused order is used and no floor applies.
4. Select: sections at or above the rerank floor, at most the scope's section count, within the token budget (context length minus 1536); whole sections, the longest trimmed only when they do not fit. Answer scope comes from the settings store (Session K); until it exists, Balanced.
5. Prompt and model: numbered sources with their section path, never a file name or page; one streamed POST /api/chat to the bundled Ollama with think false, the preset's temperature and num_ctx. When no section passes the floor the model is not called.
6. Output: [n] citations are parsed as they stream (a citation cut between chunks is held back); the cards show the cited sections in citation order with file name, section path, PDF pages and printed page label (when the section records carry one), and the passage the model read, all from the section records. Selected but uncited sections are under Other sections considered. The reply NOT_IN_SOURCES shows the nothing-found list with the best reranked sections, up to 8, with no floor. A sentence without a citation gets a muted marker.

The main log gets one line per question, without the question text: `[answer] 2 cited of 3 selected, 12 candidates, vector 45 ms, keyword 2 ms, rerank 640 ms, first token 900 ms, total 4100 ms`.

## OCR in the watcher

A PDF without a text layer is OCRed page by page (Session K): the page images are taken out of the PDF with pdfjs (no canvas; JPEG, JBIG2 and CCITT decode in JavaScript), encoded as PNG (gray scans as 8-bit gray) and uploaded to the collector one page per upload without embedding, up to min(CPUs, 4) pages at once like the collector's own whole-file OCR; each text is kept and the collector's copy deleted. Every page becomes a section titled Page N with its real page number. Only when no page holds an image is the whole file sent as before, its text recorded as page 0. The result is cached by file hash in `<dataDir>/ocr-cache/<hash>.pages.json`. Languages: TARGET_OCR_LANG from the preset (eng,chi_sim), written into server/.env by the wizard. Measured in the cloud container (Linux x86_64, 4 vCPU): about 1.1 s for a 1240 by 700 page and about 9 s per A4 page at 300 dpi on one worker, 12.1 s for three A4 pages in parallel against 11.4 s for the old whole-file upload; not measured on a Mac.

The language data never downloads: @tesseract.js-data/eng and @tesseract.js-data/chi_sim (4.0.0_best_int) are runtime dependencies of the shell and ship in app.asar; at every launch src/main/tesseract.ts copies any missing language, unpacked, to `<dataDir>/storage/models/tesseract`, where the collector's tesseract.js looks first. Session B had not shipped these files, so Session H added the packages.

## Smoke test

scripts/smoke-mac.sh starts the packaged app on an emptied data directory (the model cache is kept) with ASKFILES_PRESETS_FILE=test/fixtures/presets-smoke.json (qwen3:0.6b, all-minilm, threshold 0) and ASKFILES_LIBRARY_FOLDER set to a temp folder holding test/fixtures/handbook.pdf and the two-page test/fixtures/scanned.pdf. The first run asks for no folder; once it is done the app links that folder into All files without the bridge. The script waits for the first run, for the Ask page's ready line in main.log and for both PDFs in libraries/all-files/index.json, then checks the workspace, the OCR pages (1 and 2), the browse index (both PDFs listed in libraries/all-files/browse), then waits for the `[answer] smoke` line with a [1] citation: the app is started with ASKFILES_SMOKE_QUESTION and asks that question through the answer pipeline once the Ask page is ready and the library indexed. It also checks the reranker files the first run fetched.

## Third-party notices

THIRD-PARTY-NOTICES at the repository root lists every bundled package with its license and each license text once; the About page shows it. A package that ships no license file gets the standard text of the license its package.json names, from scripts/license-texts (SPDX license-list-data v3.27.0: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, LGPL-3.0 with the GPL-3.0 text it builds on, MPL-2.0, CC0-1.0); when package.json names none, the license its readme states under a License heading, marked as from the readme. A package with no license anywhere is listed with its dependency path. scripts/third-party-notices.test.mjs fails when a listed package that names a license has no text in the file.

`npm run package:mac` regenerates the file on the Mac after scripts/build.sh has pruned the trees and before electron-builder and signing, and runs the test there; the mac workflow does the same and uploads the result. docs/packaging.md, Third-party notices, has the details. To regenerate the repository copy in a cloud session:

```
PACKAGE_TARGET=linux-x64 bash scripts/build.sh
npm run notices -- --strict
```
