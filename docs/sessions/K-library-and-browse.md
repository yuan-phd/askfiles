# Session K: library model, browse layout, indexing fixes, simple settings

Executor: CLOUD for code and tests; visual pass LOCAL
Dependencies: Sessions A to J merged on main. Runs in parallel with Session L, which owns the Ask page (src/renderer/search, to be renamed by L) and the new answer pipeline in src/main/answer. Session K must not edit those; the only Ask-related change K makes is the label of the top-bar switch.
Branch: whatever the session assigns
PR title: [Session K] Libraries, browse layout, indexing fixes, settings

## Why

First real use on a Mac (owner's test, 2026-10-30) found: setup forces a folder choice before the app is usable; one library only; xlsm files ignored; OCR pages lost; headings polluted by OCR noise and long sentences; browse navigation needs scrolling back to the top; the sub-tab state leaks when arriving from Read section; no way to change the answer behaviour at all.

## Part 1: libraries instead of one folder

1. First run no longer asks for a folder. The wizard does memory check, model download, settings, backend start, then opens the app.
2. A default library named All files exists from the first launch and cannot be deleted or renamed. The user can create more libraries, rename and delete them (delete asks once and removes the library's index and workspace; original files are never touched).
3. A library is one upstream workspace plus the shell's own records: its sources, its index.json, its browse index. Everything the watcher and browse index do today becomes per library.
4. Two ways to put content into the current library, behind one Add button in the top bar: Add files (copies the chosen files into the library's own folder under the data directory) and Add folder (links an existing folder; watched as today, never modified). A library can have several sources; each source is listed with a remove action. Drag and drop of files or folders anywhere in the window adds to the current library.
5. The top bar replaces the current Library path box with a library switcher (dropdown showing the current library and its indexed count and state), the Add button, and the Ask and Browse switch with the first label changed from Search to Ask. The bar stays fixed while content scrolls.
6. Empty state: a library with no sources shows one sentence and the Add button, in both Ask and Browse.

## Part 2: browse layout

1. Fixed left sidebar with four entries: Library, Headings, Find, Document. The content area scrolls on its own; the sidebar and the top bar never scroll away.
2. Document is the fourth entry. It exists whenever a document is open, shows the file name as its label, and the document outline below it in the sidebar. Read section from the Ask page and any click on a document always land on Document; the state of Library, Headings and Find is never changed by that navigation.
3. Headings: remove the checkbox. The page lists only headings present in two or more documents of the current library.
4. Keep the existing pages' behaviour otherwise. Regenerate the screenshots.

## Part 3: indexing fixes (src/main/sections and the watcher)

1. Accepted file types gain xlsm, xls and csv. Confirm read-excel-file handles xlsm; if not, add the smallest dependency that does and justify it.
2. Scanned PDFs are OCRed page by page so every section carries its page number; pages recorded as 0 only when the page itself cannot be read. Measure the cost per page with the shipped tesseract data and record it in the PR.
3. Heading quality filter in the splitter: a heading candidate is rejected and merged into the body when it is longer than 120 characters, ends with sentence punctuation, has less than 60 percent letters or CJK characters, or is mostly punctuation or digits. A document with no outline and no acceptable headings is split by page with titles Page N.
4. Heading hierarchy: record the heading level and the full path (parent titles) in each section record, from PDF bookmark nesting and Word heading styles. The browse outline nests by level; the section path is available to the answer pipeline through the section records.
5. PDF page labels: when a PDF defines printed page labels (pdfjs getPageLabels), record both the PDF page index and the printed label in the section record; the browse outline and the section records expose both.
6. Word headings: fix detection of heading styles that the current parser misses (owner's test: a section titled Preamble was not found). Cover Heading 1 to 6, Title and Subtitle styles, and headings set by outline level without a named style.
7. Reindex: a library can be reindexed from the library menu; the first run after this session reindexes existing libraries once because section records changed shape.

## Part 4: simple settings

1. A Settings page reachable from the app menu, with exactly these controls and nothing else: Answer scope (Strict, Balanced, Broad), Answer model (Faster, Better: the two tiers nearest the machine), Context length, Reindex this library. Each control has one line of plain explanation. Values are stored in shell.json and applied through the existing presets code; document which upstream or pipeline setting each one maps to. The mapping for Answer scope is defined together with Session L, which owns retrieval: K stores the value and exposes it through the bridge, L consumes it.
2. A Developer page, hidden unless ASKFILES_DEVELOPER=1, showing the raw preset values and the data directory.

## Tests and acceptance

- Unit tests for the library records, source add and remove, copy on Add files, the heading filter, hierarchy and page labels, xlsm acceptance, and the settings store.
- Playwright tests for the top bar switcher, empty state, sidebar navigation including the Document entry rule, and the Settings page with a stub bridge.
- Integration: a library with one linked folder and one added file is queryable; per-page OCR gives real page numbers for a two-page scanned fixture.
- Smoke script updated for the new first run (no folder step) and a linked folder added through the bridge-free path used today.
- Docs: docs/app.md and docs/plan.md updated; phase 3 interaction model text replaced by the libraries model.
- Mac workflow green; PR body lists everything not verified on a Mac.

## Rules

- Do not edit upstream/. No new patches expected; if one seems needed, stop and explain.
- Do not touch src/main/answer or src/renderer/search; Session L owns them.
- Watch the PR after opening it and fix mac runs until green.
