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

## Running from source (npm run dev)

For testing on the Mac without packaging. Once per checkout, and again after upstream or patches change:

```
npm install
npm run build:upstream
```

Then:

```
npm run dev
```

It compiles src/main, makes sure the patches are applied to upstream/ (idempotent; build.sh leaves them applied) and starts Electron on the repository with ASKFILES_DEV=1. With that variable the unpackaged app runs the same AppController as the packaged one, with three differences (src/main/app-mode.ts, devBackend):

- Server and collector come from upstream/server and upstream/collector and run under the Node that runs npm (npm_node_execpath), not under Electron, because yarn built their native modules for that Node.
- No bundled Ollama: the app uses the Ollama already running on 127.0.0.1:11434 (ASKFILES_OLLAMA_PORT for another port) and its models in ~/.ollama. Start the Ollama app first; the start fails with a message when nothing answers. The first run pulls the tier's models there if they are missing, and the Models page removes from there.
- Data in ~/Library/Application Support/AskFiles-dev, logs in ~/Library/Logs/AskFiles, so a dev run never touches the installed app's library.

Pages load from src/renderer, so a page change needs only a reload (Cmd+R); a change in src/main needs a new npm run dev. Add ASKFILES_DEVELOPER=1 for the developer panel and the Developer page (`ASKFILES_DEVELOPER=1 npm run dev`), and ASKFILES_PRESETS_FILE to try a presets file. A preset with rerankerModel none, the current default (docs/eval.md), needs no reranker files; any other reranker runs in a child of the Electron binary as in the packaged app.

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
| graph.json | The library graph (docs/graph.md), rebuilt after browse changes |
| summaries/ | Document and section summaries, one JSON file per document (docs/summaries.md) |
| export/ | The Markdown export of the summaries, an Obsidian-compatible folder |

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
      "folders": [{ "id": "folder-1", "path": "/Users/anna/Documents", "addedAt": "..." }], "createdAt": "...",
      "profile": "legal-finance", "typeOverrides": { "legal-finance": { "<document id>": "contract" } },
      "familyDecisions": { "<id>|<id>": true }, "sectionSummaries": false }
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
| `askfiles.graph.data()`, `.onChange(cb)` | The current library graph (docs/graph.md) with each document's summary state; onChange after a rebuild |
| `askfiles.graph.profiles()`, `.setType(id, type)`, `.answerFamily(a, b, same)` | The profiles (docs/profiles.md); a document's type override (null for Detected, back to detection); a family answer (null forgets it) |
| `askfiles.libraries.create(name, profile)`, `.setProfile(profile)` | A new library's profile; the current library's profile, which rebuilds types and edges, not the index |
| `askfiles.summaries.status()`, `.onEvent(cb)`, `.pause()`, `.resume()` | The summary queue (docs/summaries.md): Summaries n of m and why it waits; events `status` and `changed` (document ids) |
| `askfiles.summaries.document(id)`, `.requestSections(id)`, `.setLibrary(on)`, `.openExport()` | A document's summary, section summaries and estimate; its section summaries on request; the library switch; the export folder in Finder |
| `askfiles.app.info()` | `{ name, version }` for the About page |
| `askfiles.app.pageReady(info)` | Logs `[main] page ready ask connected=true documents=N`; the smoke test waits for it |
| `window.shellConfig` | `{ baseUrl, apiKey, workspace, libraryId, libraryName, folder (always null), resolveSources, openSource }`, read once per page load; workspace is the current library's |

src/main/bridge/bridge.test.ts runs the preload in the same function wrapper the sandbox uses, wired to the real registerBridge, and fails when a page calls a function the bridge does not expose.

## Top bar

src/renderer/shared/topbar.js and topbar.css, mounted by the Ask page into `<header id="top-bar">`. It stays fixed while the views scroll (the body is a column; only the view scrolls). At the far left the Ask and Browse switch, inset like the Browse sidebar's entries so it stands over them. At the right the library switcher (library name, indexed count, indexing state: Indexing, N left; Up to date; Folder not available; the dead-letter count with errors in the tooltip), whose menu opens from its right edge and lists the libraries with their counts, creates one, and for the current library lists its sources with Remove, renames it, reindexes it and deletes it (asks once); then, after a clear gap, the Add button (Add files, Add folder). The result of an add shows just left of the library switcher. A library without sources shows one sentence and the Add button in place of both views. Dropping files or folders anywhere in the window adds them to the current library. The Ask page keeps the test ids status-count, status-state and status-failed.

## Browse view

The Ask and Browse switch in the top bar shows either view in the same page (src/renderer/ask/index.html); both stay in the page, so each keeps its state and nothing reloads. Browse (src/renderer/browse/view.js, also standalone at browse/index.html) has a fixed sidebar with Library, Compare, Find, Graph (Session N, docs/graph.md) and, once a document is open, Document (labelled with the file name, its nested outline below it); only the content area scrolls, and each page keeps its scroll position. Library: every document, outline collapsed, sort by name or last change, indexing state. Compare (called Headings before 2026-11-04): its title with one line under it, The same heading across several files, shown side by side; the headings found in two or more documents, and a heading shows that section from every document side by side. Parts the splitter cut from one section (T (page N), T (continued)) merge into their parent: the heading appears once, and its card holds the parent section's full text, every part in order, with the page range. Cards show no summaries. Find: keyword search, hits grouped by document and section (src/main/browse/search.ts): every word must occur in the section, and words in quotes ("annual leave", “年假 结转”) are one phrase that must occur as written. Sections where the words stand next to each other in the query's order come first, then sections with all words in one paragraph, then the rest; documents are ordered by their best section, and the ranking is done before the 200-hit limit cuts. The snippet is the stretch of the section where the words are densest. Document: sections in order, an anchor per section, the page and the printed page label when the PDF has one, Open original. Opening a document from any page, or Read section on the Ask page, always lands on Document and never changes the state of Library, Headings or Find.

Page history (src/renderer/shared/history.js): every move between Ask, the Browse pages and documents is an entry, with what it needs to come back as it was left: the scroll position, the heading selected, the words found, the document and section. Back at the top of the Browse sidebar, above Library (always shown, disabled when there is nothing to go back to), and Cmd+[ anywhere return to the entry before; the Ask results stay as they were. Changing the library clears the history. The standalone browse page keeps a history of its own. Find results carry no label for their rank; the order is the ranking. No model and no server call: everything comes from the browse index.

The browse index (src/main/browse) is one JSON file per document in `<dataDir>/libraries/<library id>/browse/<id>.json`, id the first 16 hex digits of sha256 of the file path:

| Key | Content |
| --- | --- |
| `version`, `id`, `path`, `url`, `relPath`, `title` | 3 (files of other versions are rebuilt); the id; the file's path, file URL, shown path (linked folder's name and the path in it, or the added file's name) and file name |
| `size`, `mtimeMs`, `hash`, `splitKey`, `indexedAt` | From the index.json record; hash and splitKey decide when the sections are read again |
| `outline` | `{ title, level, sectionIndex, page, pageLabel, children }`, nested by heading level; a heading the splitter folded into the next section (a chapter heading right above its first subsection) gets an entry one level up pointing at that section; text before the first heading gets none. Parts the splitter cut from one section (titles ending in (page N), and the text after a table titled (continued)) fold into the entry of that section, which then also has `pageEnd`, `pageLabelEnd` and `parts` (the section index of every part, in order); the outline shows one entry with its page range and lights it for any part, while the Document page still renders every part in order. Built from the sections when a stored file loads, so older files show the folded outline with no reindex |
| `sections` | `{ index, title, level, lead, heading, path, pageStart, pageEnd, pageLabelStart, pageLabelEnd, text, parts }`: parts is the sub-chunk bodies in order (version 3), which the answer pipeline assembles passages from; path is the full heading path from the section records; index is the sectionIndex of the section documents and search sources; text is the section's sub-chunks joined again, the heading lines the chunker put in front of each taken off; heading is the normalized key, empty for text before the first heading and for the Page N sections of a PDF without headings |

Built from the index.json record and the section documents under STORAGE_DIR/documents, so it shows exactly the split that retrieval embeds, OCR text included. Kept current from the watcher's file events (indexed, unchanged, removed); after every watcher start, sync drops entries for files the watcher no longer has and builds missing ones. Loaded before the watcher starts, so the library shows during a long reconcile.

The Compare page asks for headings found in two or more documents only (BrowseIndex.headings, minDocuments 2). On the Document page a part the splitter cut by page or after a table shows no title of its own, only its page marker (Page 5); the parent title appears once above the first part. The per-section summary lines stay at each part.

Heading normalization (src/main/browse/normalize.ts, numbering prefixes from src/main/sections/headings.ts): NFKC, which turns full-width letters, digits and punctuation into half-width; lower case; numbering prefixes removed, repeatedly (1, 1., 1.2.3, 1), 1、, (1), (a), a), I., IV), Chapter 3, Section 2.1, Part II, Article 5, Appendix A, § 4, 第一章, 第12节, 第三条, 第二部分, 一、, (一)); then punctuation and symbols removed and whitespace collapsed. Number parts have at most three digits, so 2026 Budget keeps its year. A heading that is only numbering (第一章 alone) keeps it.

Keyword search (src/main/browse/search.ts): the query is split at whitespace; each term, folded the same way (NFKC, lower case), must occur as a substring of the section title or text. No word boundaries, so Chinese matches inside a sentence. Documents with the most matches come first, sections in document order; at most 200 sections are returned, the total is always counted.

While the current library is indexing, the Ask page's question box is off with one line, Reading new files, n left (Session N, docs/summaries.md). The Library page shows each document's type (Regulation (detected) when detection chose it, Regulation alone when the user set it; a click opens a dropdown of Detected: <type> and the types of the library's profile) and its summary, and asks about possible copies of one document; the Document page shows the summary, the section summaries and the Summarize each section button. The top bar shows Summaries n of m with Pause while the summary queue works, and the library menu holds Kind of documents, Summarize every section and Open Markdown export.

## Answer pipeline

The Ask page answers through the shell (src/main/answer), not through the upstream chat route; upstream stays the document store, parser, OCR, embedder and vector database (docs/plan.md, Decisions). For each question:

1. Candidates. Vector: POST /api/v1/workspace/:slug/vector-search with scoreThreshold 0 and topN vectorTopK; each chunk is mapped to its section by text through the watcher's records (resolveSources). Keyword: terms from the question (quoted phrases, numbers and codes, capitalized names, rare words and word pairs, rare Chinese 2 to 4 character n-grams; rare means in few sections of the browse index) ranked by BM25 over the browse index's section text (src/main/browse/rank.ts), any term matching. Both lists are fused by reciprocal rank fusion (src/main/answer/fusion.ts): a section scores the RRF of its best sub-chunk plus the RRF of its keyword rank; its further sub-chunks add a tie-breaker of at most 10 percent of that. Summing every sub-chunk, as before 2026-10-31, let long sections with several weak hits outrank the section both lists put first.
2. Sections: the best candidateSections sections, their passage from the browse index (src/main/answer/sections.ts, assembleSection). A section that fits twice the chunk maximum is sent whole; a longer one is assembled from its matched sub-chunks (any of its sub-chunks in the vector top 30, or holding a keyword term) each with one neighbour on both sides, in document order without repeats, ... marking left-out parts, within the section cap (sectionCapChars, default twice the chunk maximum). When the cap cannot hold them all, matched sub-chunks go before neighbours; with no match the section's start is used.
3. Rerank: a cross-encoder scores question and section path plus text. With rerankerModel none (the presets' value for now: onnxruntime-node crashed with EXC_BREAKPOINT on the owner's Mac when a bge reranker loaded, 2026-10-30) this step is skipped: the fused order stands and the floor in step 4 applies to vectorFloor, the best vector similarity among the section's sub-chunks, instead of rerankFloor; a section only the keyword index found has none and passes only a floor of 0. It runs in a child process of the app's binary (ELECTRON_RUN_AS_NODE, src/main/answer/reranker-worker.ts), because onnxruntime-node blocks the calling thread for the whole model call (measured: 1.7 s for 8 sections with MiniLM on 4 Linux vCPUs, during which a main-process timer did not fire); it loads @xenova/transformers from the bundled server's node_modules, starts on the first question and ends after 15 minutes without one (`[answer] reranker <name> unloaded after 15 min idle`), so its memory goes back; the next question loads it again (`reloading`, then the worker's `loaded in N ms`); the model files are in `<dataDir>/models/reranker/<repo>`, fetched by the first-run wizard (and in the background on the first launch of a library set up before this existed). Without them, or for a mainly Chinese question or candidate when rerankerBypassCjk is on, the fused order is used and no floor applies.
4. Select: sections at or above the rerank floor (vector floor without a reranker), at most the scope's section count, within the token budget (context length minus 1536); whole sections, the longest trimmed only when they do not fit. Answer scope comes from the settings store (Session K); until it exists, Balanced.
5. Prompt and model: when the sources do not state the specific fact asked, even if they discuss related material, the model must reply NOT_IN_SOURCES and may add one sentence citing the sources it checked (kept as result.checked); numbered sources with their section path, never a file name or page; one streamed POST /api/chat to the bundled Ollama with think false, the preset's temperature and num_ctx. When no section passes the floor the model is not called.
With answerMode quoted (src/main/answer/quoted.ts) steps 4 and 5 differ: the top extractSections sections above the floor, table-of-contents sections left out (isContentsSection: a Contents title on the path, or mostly lines with a dot leader before the page number; lines that merely end in a number, as score sheets and currency tables do, are not enough), go to an extraction call with Ollama structured output and thinking off, which returns per section the verbatim excerpts relevant to the question. Code keeps an excerpt only when it is found in that section's text after normalization (NFKC, case, dashes, quotes, a word broken across a line, all whitespace; a piece shorter than 12 characters is dropped; an excerpt with ... is checked piece by piece) and logs `[answer] quoted: 6 sections, 9 excerpts, 7 verified, 2 dropped, extraction 8400 ms`. With no verified excerpt the not-found state shows the nearest sections and no second call is made. Otherwise the sections with verified excerpts, renumbered 1 to k, go to a composition call with the excerpts as their text; a sentence citing a number outside 1 to k (no verified excerpt) is unsupported, and the source cards show the verified excerpts as passages. The default stays single.

Switches that change the single mode, each off in the presets until an eval round keeps it (docs/plan.md, phase 2). The presets turn on verifyCitations, enumerateWhenAsked, dropUnsupportedHedges, cjkOverlap, crossDocQuota, scopedQuotaV2 and headingPathBonus; crossDocument, fileScopedQuota, paragraphSelection, verdictLine, documentAffinity, enumerateFollowUp, noSummarizing decomposeQuestions, perFileSubquery, namedFileQuota8, sourceFileNames, sourceDisplayNames, questionFileNames, verifyStripNames, dropAnswerFileNames and judgeRerank, like answerMode quoted and promptVariant strict or complete, are unused options: built, measured, not kept, off on every tier (docs/plan.md, Phase 2 result).
- paragraphSelection (src/main/answer/paragraphs.ts): every section longer than twice the chunk maximum is split into paragraphs of about 200 to 500 characters, each embedded with the library's embedding model through Ollama's /api/embed and stored per document in `<library>/paragraphs/<document id>.json` (base64 float32, rebuilt when the file's hash, split, model or chunk maximum changes). The app brings the store up to date in the background on each question; until a document is done its sections go as in step 2. At question time a selected long section is sent as its 3 paragraphs with the highest cosine similarity to the question plus 0.05 per question term they contain (at most 4), each with one neighbour on both sides, in document order with ... for gaps, within the section cap; shorter sections are sent whole. One embedding call for the question, no model call; `[answer] paragraphs: 2 of 5 sections cut to paragraphs`.
- verdictLine (src/main/answer/prompt.ts, readVerdict): the two NOT_IN_SOURCES rules are replaced by: begin with one line holding only FOUND or NOT_FOUND. Nothing is shown until that line is complete. NOT_FOUND shows the not-found state with the nearest sections and discards the rest of the reply; FOUND is removed and the answer streams as usual. A reply without the line goes through the NOT_IN_SOURCES check as before.
- verifyCitations (src/main/answer/verify.ts): after the reply, every sentence with at least two content tokens (words of three or more letters that are not stopwords, numbers, Chinese character pairs) is checked against the passage of the source it cites: the share of its distinct tokens found there. At 0.5 or more it keeps the citation; below, it moves to the selected source with the highest share if that one reaches 0.5, else it is marked unsupported and loses its citations. A sentence without a citation is treated the same way. The cards then show only the sections still cited; `[answer] verify: 4 sentences, 1 re-attributed, 0 attributed, 1 unsupported`. With cjkOverlap (on in the presets, round A1) a sentence whose letters and digits are at least 30 percent Chinese, Japanese or Korean is measured by character pairs, with the spaces PDF text puts between characters closed up first, against a threshold of 0.3 (VERIFY_MIN_OVERLAP_CJK) instead of 0.5; English sentences are unchanged.
- crossDocument (src/main/answer/pipeline.ts, src/main/browse/identifiers.ts namedFileGroups; off, round A2): a question that names two or more files, by the identifiers above plus the Chinese title in a file name (标准设备采购招标文件 for 01_标准设备采购招标文件_2017年版.pdf, matched without word boundaries) and a name two formats of one document share (counted as one mention of both), gets three parts, each of which crossDocumentParts can leave out. quota: each named file's top 3 sections of the fused list (CROSS_DOCUMENT_QUOTA) are candidates and selected whatever their score, plus the overall top sections up to the scope's count above the floor; quota first, so the budget drops an overall section first. grouped: sources ordered by named file, each group under a line Sources from <file>:, the others under Sources from other files:, and in place of the rule against file names the rules to answer per file first, in a paragraph naming the file as the question does and citing only its sources, then compare. verify: a sentence that names a file may keep or move its citation only to that file's sources. `[answer] cross-document: <files>; 5 quota sections` and `[answer] cross-document: 4 of 9 sentences name a file`. A question naming one file is unchanged. crossDocQuota (on in the presets, round A2a) is the quota part alone, with the prompt and verification unchanged. fileScopedQuota (round C1) takes each named file's quota sections from retrieval inside that file (its chunks of one vector search of 2000 chunks, its sections in the keyword ranking, fused by RRF, top 3) instead of from the library-wide fused list; the log line ends with (file-scoped). scopedQuotaV2 (on in the presets, round C3) uses the same search without the file's table-of-contents sections, takes 5 quota sections per file and gives a question naming two or more files at most 8 sections, each file's best first and the files in turn (two named files: the top 4 of each); the log line ends with (file-scoped v2). perFileSubquery (round X1, off) searches each named file inside with the clause of the question that names that file alone (src/main/answer/subquery.ts), the whole question for a file without one; `[answer] subquery: <file>: <clause>` or `(whole question)` per file. namedFileQuota8 (round X3, off) raises scopedQuotaV2's numbers to 8 per file and at most 10 sections for questions naming two or more files.
- headingPathBonus (src/main/answer/heading-bonus.ts; on in the presets, round X2): in fusion a section whose heading path holds one of the question's keyword terms (English by Porter stem as whole words, Chinese n-grams) gets a fixed bonus of 0.5/(k+1), once per section; it never lifts a section found by one list over a section both lists rank in their top 16, and a section in neither list gets nothing. Every question, library-wide and inside each named file.
- judgeRerank (src/main/answer/judge.ts; off, round B): for a question naming two or more files, each named file's first 15 sections of its in-file list (searched with the file's own clause, src/main/answer/subquery.ts) are scored 0 to 3 by the chat model, one call each, sequentially, with a fixed prompt (temperature 0, thinking off, seed 42), from the question as asked, the section's heading path and its matched sub-chunks only, and reordered by that score before the file's 5 quota sections are taken; a reply that is not a single digit keeps the candidate's fused position and is logged (`[answer] judge: no score for ...`). Questions naming two or more files take about 50 seconds longer with it on (round B: median 50 s of judge calls, 8 to 69 s, 0.7 to 3 s per call on qwen3:14b on an M1 Max); other questions are unchanged. `[answer] judge: <document id>: 15 candidates in 22250 ms, scores 3:2 2:3 1:10 0:0 missing:0`.
- documentAffinity (src/main/browse/identifiers.ts, src/main/answer/pipeline.ts): the browse index keeps per file the names a question may use for it, rebuilt after any change and stored as `<library>/browse/identifiers.json`: the file name, its stem and the stem in words with and without a trailing year (Procurement Regulations 2025, Procurement Regulations), the cover title of a PDF (its top-level outline entries on page 1) and cover lines ending in a type word (Bank Procedure), and a type word (Policy, Directive, Procedure, Regulations, Guidance, Guidelines, Template, Request for Bids or Proposals, Memorandum, Manual, Handbook) when only one file has it, else the word before it plus the type (Strategy Guidance). A name of several words matches in any case; a bare type word only capitalized, so a streamlined procedure names nothing. A name that two files share is dropped. When the question names files, the fused score of their sections is multiplied by 1.5 before the candidate cut (`[answer] affinity: <files>`); when it names exactly one and at least one of its sections is selected, verification lets a sentence keep or move to only that file's sources. Source headers become `[n] file | type | section path`, with a note when another source has the same section title from a different file, and among such same-title sources verification takes the one with the higher overlap, also over the model's own citation, and cites all of them on an exact tie. A question naming two or more files gets 6 sections (AFFINITY_MULTI_SECTIONS) instead of the scope's count.
- enumerateWhenAsked (src/main/answer/enumerate.ts; on in the presets since round 8a, the follow-up stays off): a set question (a number word or digit before a plural noun, at most one word between, years and decimals not counted; or what are the, list, each, all, components, steps, conditions, requirements, activities, elements, factors, or Chinese equivalents) gets one more rule: count the items in the cited sources that answer the question, then give every one with its citation, without summarizing them into fewer. enumerateFollowUp adds a check after the reply: when the question states a count and the reply enumerates fewer items (list lines, else inline (1) (a) markers, else cited sentences), one more call with the same messages, the reply and a request for only the missing items, streamed after a blank line; `[answer] enumerate: 2 of 3 items, completed by a follow-up in 2100 ms`.
- noSummarizing (prompt.ts, off; round 9a): the enumerateWhenAsked set rule is replaced by one rule on every question: do not summarize, merge or group; state each item the sources list separately, with its citation; give every member of a set.
- decomposeQuestions (src/main/answer/decompose.ts, off; round 9b): a question is split only on structure it shows: asks joined by and, as well as or a comma list, each starting with a question word, after a lead-in (Under paragraph 4.7 of the Procurement Regulations, ...); or Compare A and B: ask, one part per member. A later ask that points back (it, its, that, there), the former / the latter with no two-member list to resolve them, no lead-in, two question sentences or more than 4 parts leave it whole; a one- or two-word ask (why) joins the one before. Each part runs retrieve, choose and answer on its own; the answer streams part by part under the part's ask as a lead-in, the sources list only grows so numbers already shown stay, citations are renumbered to the union, a section two parts share is one card, and a part its sources do not answer reads The documents do not state this. The result is not found only when every part is. The trace panel shows the first part. `[answer] decompose: asks, 2 parts: "What action initiates the Standstill Period?" | "Which paragraph range governs the Standstill Period requirements?"`.
- dropUnsupportedHedges (src/main/answer/hedges.ts, on in the presets): after citation verification a sentence marked unsupported that only says something is missing (The physical PDF page and printed page are not specified in the sources.) is deleted when the answer keeps at least one supported sentence, so the user does not see a muted warning on a remark that is not a claim. Supported sentences are never deleted, and nothing is deleted when no supported sentence would remain. `[answer] hedge dropped: <sentence>`.

6. Output: [n] citations are parsed as they stream (a citation cut between chunks is held back); the cards show the cited sections in citation order with file name, section path, PDF pages and printed page label (when the section records carry one), and the passage the model read, all from the section records. Selected but uncited sections are under Other sections considered. The reply NOT_IN_SOURCES shows the nothing-found list with the best reranked sections, up to 8, with no floor. A sentence no source supports stays muted and gets an asterisk after it; one line under the answer says that starred sentences have no supporting passage in the library and may be inaccurate.

The main log gets one line per question, without the question text: `[answer] 2 cited of 3 selected, 12 candidates, vector 45 ms, keyword 2 ms, rerank 640 ms, first token 900 ms, total 4100 ms`.

## Indexing time

The watcher logs one line per indexed file with the time per stage, and the browse follower one for the browse index:

    [watcher] timing 01_Procurement_Regulations_2025.pdf: split 513 ms, ocr 0 ms, write 47 ms, embed 28128 ms, total 28688 ms, 328 sections
    [browse] timing 01_Procurement_Regulations_2025.pdf: browse index 21 ms

split is parsing and chunking without OCR; ocr the time in the OCR hook (zero when the OCR cache has the file); write the section documents written to the server's document store (the shell writes them directly, there is no upload request); embed the update-embeddings call and the workspace reads around it. The graph logs each build (`[graph] built ... in N ms`) and the summaries each job.

Measured on 2026-11-04 with Reindex of the owner's English folder in the dev app (13 files with the one added file, 1311 sections; OCR cache moved aside so the scanned file was OCRed; qwen3 14B, bge-m3, M1 Max), before and after the fixes below:

| Stage | Before | After |
| --- | --- | --- |
| Clearing the old index (Reindex only, before any file) | 289 s | 6 s |
| Split (13 files) | 4.3 s | 3.9 s |
| OCR (09_Scanned_Historical_Records.pdf, 26 garbled pages; no other file) | 19.2 s | 19.1 s |
| Write section documents | 0.2 s | 0.2 s |
| Embed (one update-embeddings call per file; upstream embeds each section document on its own) | 110.6 s | 113.4 s |
| Browse index (13 updates) | 0.1 s | 0.1 s |
| Graph | 14 builds, 1.1 s | 2 builds, 0.4 s |
| Reindex call to indexing done | 427 s | 145 s |
| Document summaries done, after the reindex | 497 s | 177 s |

What the table showed, against the first suspects:

- **Clearing.** Reindex unembeds every section first, and upstream deleted each document's vectors with its own LanceDB delete, one new table version each. patches/008-bulk-remove-documents.patch deletes them in batches. This was 68 percent of the reindex.
- **Summaries between files.** Not seen: the indexing gate stayed closed through the batch and the first summary started after the last file. The queue's wait is for the whole batch (watcher pending counts settling, queued and running files). The Markdown export was written 2 s after every file, though, and writing it read the graph, which rebuilt it each time; the export and the graph now wait for the batch too (GraphService.setIndexing, SummaryService.setIndexing).
- **One request per section.** The shell sends one update-embeddings request per file; inside it upstream embeds each section document with its own Ollama call and LanceDB add, about 85 ms per section. This is the same cost the eval harness pays (its embedding of the English corpus takes about the same two minutes) and is what remains; batching it means changing upstream's document embedding loop, not done here.
- **OCR on good pages.** Not seen: only the scanned file's 26 garbled pages went to OCR.
- **Graph and browse index per file.** The browse index has to take each file (1 to 22 ms); the graph now builds once per batch.

## OCR in the watcher

A PDF with a text layer can still have garbled pages: a scan whose own OCR layer is poor. The PDF parser (src/main/sections/pdf.ts, pageQuality) measures each page: the share of non-space characters that are letters, digits or CJK, runs of three or more of one punctuation mark (contents leaders) left out, and the share of words that are plausible (any CJK, or two or more letters with at most an apostrophe, hyphen or period between them; numbers and punctuation-only tokens count for neither side). A page of at least 40 characters with either share below 0.85 is garbled. In a PDF with at least one garbled page, a page with fewer than 200 characters that draws an image is OCRed too: a scanned page whose layer lost most of its text. Thresholds from the owner's first corpus: no page of its eight digital PDFs (599 pages) went below 0.92 for characters or 0.88 for words; the scanned one goes down to 0.52 and 0.55. The splitter (src/main/watcher/splitter.ts, splitWithOcr, shared with the eval harness) OCRs those pages through the same per-page path as below, cached by file hash and page list, and parses the file again with their OCR text in place of the layer; headings from bookmarks still apply, and OCR lines are never taken for font-size headings. A page whose OCR finds nothing keeps its layer. The log says which pages were replaced: `[watcher] <file>: garbled text layer on pages 4, 7, 8; replaced with OCR: 4, 7, 8`.

Long sections without sub-headings are split by page in the chunker (src/main/sections/chunk.ts, splitLongByPage): a section whose own text (up to the next heading of any level, so without sub-headings) is longer than three chunk maximums and spans more than one page becomes one sub-section per page, titled with the parent title and the page (Operational Procurement Matters (page 1)), one level down, the parent title kept as the first one's folded heading so the outline still shows it. A section followed by deeper sections is split too: the owner's nine-page cover section had sub-sections after it. SPLITTER_VERSION 3 makes every library reindex once. The outline folds the page parts back into one entry with the page range (browse/build.ts buildOutline).

A PDF without a text layer is OCRed page by page (Session K): the page images are taken out of the PDF with pdfjs (no canvas; JPEG and CCITT decode in JavaScript, JBIG2 and JPEG 2000 with the WebAssembly decoders pdfjs-dist ships, loaded through wasmUrl from node_modules/pdfjs-dist/wasm; before 2026-10-31 that option was missing and JBIG2 scans gave no page images, unnoticed because the fixtures are JPEG), encoded as PNG (gray scans as 8-bit gray) and uploaded to the collector one page per upload without embedding, up to min(CPUs, 4) pages at once like the collector's own whole-file OCR; each text is kept and the collector's copy deleted. Every page becomes a section titled Page N with its real page number. Only when no page holds an image is the whole file sent as before, its text recorded as page 0. The result is cached by file hash in `<dataDir>/ocr-cache/<hash>.pages.json`. Languages: TARGET_OCR_LANG from the preset (eng,chi_sim), written into server/.env by the wizard. Measured in the cloud container (Linux x86_64, 4 vCPU): about 1.1 s for a 1240 by 700 page and about 9 s per A4 page at 300 dpi on one worker, 12.1 s for three A4 pages in parallel against 11.4 s for the old whole-file upload; not measured on a Mac.

Indexing switches (the preset's indexing block; docs/eval.md, Indexing switches): structuredTables (on in every tier since round I1) keeps PDF, Word and spreadsheet tables with a header row as sections of their own, one line per row with the header cells as labels, cut only between rows, the header repeated in every chunk; Browse shows such a table as an entry under the heading it stands in, titled by its caption when it has one. cjkHeadings (Chinese numbered headings, running headers, contents pages) is on in every tier by owner ruling after answer round C4; ocrUpscale (page images scaled to about 300 dpi before OCR, cached as `<hash>-up.pages.json`) is built and off. Each switch is part of the split key with its revision, so turning one on, or a release that changes one, reindexes every library once.

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
