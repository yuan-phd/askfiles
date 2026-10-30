# Session J: browse view (plan phase 4) and the notices fix

Executor: CLOUD for all code and tests; the visual pass is LOCAL
Dependencies: Sessions A to I merged on main. The app has a first run, a search page, a watcher with section records (index.json and the section documents it writes) and a preload bridge.
Branch: whatever the session assigns
PR title: [Session J] Browse view: document pages, outlines, heading index, keyword search

## Goal

The user can read without asking. Next to Search, the window gets a Browse view: a library index, a page per document with its outline, a cross-document heading index, and keyword search. No model is involved anywhere in this view; everything is built from the section records the watcher already produces plus a small index the shell maintains.

## Read first

- src/main/watcher and src/main/sections: what a section record contains (file, section title, section index, page, text, hash) and where it is stored.
- src/renderer/search and the preload bridge: the page conventions, shellConfig, resolveSources, openOriginal, the status bar.
- docs/plan.md phase 4 and the Decisions table.

## Deliverables

1. Shell-side index (src/main/browse): built and kept current from watcher events, stored in the data directory. It holds, per document: path, title, size, modified time, outline (section titles with index and page, nested by heading level when the splitter provides levels), and per section: normalized heading text and the section text. Normalization strips numbering prefixes, full-width punctuation and case so that the same heading in different files groups together. Provide: list documents, get document with outline and sections, headings grouped across documents, and keyword search over section text returning hits grouped by document and section with a short snippet. Keyword search must handle Chinese: substring match or character n-grams, no word-boundary assumption. Use Node built-ins or SQLite through a dependency already in the tree; justify any new dependency in one line.
2. Bridge additions in the preload for the four calls above, with the contract test extended.
3. Browse pages under src/renderer/browse, plain HTML, CSS and JS, same look as the search page, light and dark:
   - Library: every document with its outline collapsed, sortable by name and date, with the indexing state from the status bar.
   - Document: the original text rendered section by section with the outline as a side rail, section anchors, and an Open original button through the existing bridge call.
   - Headings: the cross-document heading index; clicking a heading shows that section from every document side by side, each with its file name and an Open original button.
   - Find: keyword search with hits grouped by document and section; a hit opens the document page scrolled to the section.
4. Navigation: a two-item switch between Search and Browse in the window, state kept per view, no reload. The search page's source cards gain a link into the document page at the cited section.
5. Tests: unit tests for normalization (numbered headings, full-width punctuation, mixed case, Chinese and English), grouping, keyword search including Chinese queries, and index updates on add, change and delete events. Playwright tests for the four pages against a seeded index with the bridge stub, plus one real-backend test that drops two files with a shared heading into a watched folder and checks the heading index groups them.
6. Smoke: add one check to scripts/smoke-mac.sh that the browse index exists after indexing and lists the test documents.
7. Notices fix (small, from Session I): THIRD-PARTY-NOTICES lists libvips as LGPL-3.0-or-later but ships no LGPL text, and the packages ship none either. Make scripts/third-party-notices.mjs include the full license text for every package whose license file is missing, from a small bundled set of standard texts keyed by SPDX id (at least MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, LGPL-3.0, MPL-2.0), and add a test that fails when a listed license has no text in the file.

## Rules for this session

- Do not edit upstream/. The browse view reads the shell's own records, never the upstream database.
- No model calls in this view, by design.
- Everything that needs the real window is written and tested with stubs here and listed under Not verified in the PR.
- Watch the PR after opening it: read each failed mac run, fix, push, until green.

## Acceptance

- npm test, npm run lint and the Playwright tests green in this container.
- The mac workflow on the PR is green with the new smoke check.
- PR body lists the index format, the bridge calls added, the normalization rules, and everything not verified.
