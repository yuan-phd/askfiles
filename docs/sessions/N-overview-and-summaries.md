Overview graph, document profiles and the summary layer. Start from main on a new branch local/overview. Local only until the end. No change to retrieval, presets or the answer pipeline except where this brief says so. Read docs/plan.md, docs/app.md, src/main/browse, src/main/sections and the Browse pages first.

## Part A: document kinds and profiles

1. Structural kind detection at index time, per document, from signals only, no model: normative (numbered articles or clauses such as 第X条, Article, Section 1.1, and many shall, must, 应当, 不得), explanatory (chapters of prose with few numbered clauses), template (placeholders, [insert, blank fields, mostly empty table cells), record (dates, speaker labels, Attendees, Action items, ticket ids, timestamps), data (xlsx, csv, table-dominated files), other. Score each kind by its signals, take the highest, ties go to other. Record the kind and the scores in the document record.
2. Profiles. A profile is a JSON file with: type names mapped from the structural kinds, a color per type, extra keyword cues per type, the band order for the layered layout, and the edge rules it enables. Ship three in config/profiles/: legal-finance (regulation, guidance, template, contract, record, data; edges: shared headings, explicit references, version chains), team-work (meeting, report, ticket, spec, other; edges: shared project names from titles, ticket ids by regex, title mentions, date adjacency), general (book, article, note, reference; edges: title mentions and relatedness by shared rare terms above a threshold; shared headings off). A library chooses its profile when created, with legal-finance as the default for now, and can change it in the library menu; changing it recomputes types and edges, never the index.
3. Per-document override: a type dropdown on the Library page; an overridden type is never replaced by detection. Store it in the library records.

## Part B: graph skeleton (src/main/graph), no model

1. Nodes are documents only: id, title, type, section count, family id, date if found in the title or front matter.
2. Edges by the profile's rules, each with a kind and a weight: shared normalized headings (at least two shared headings, weight equals the count), explicit references (one document's text mentions another's title or a clause reference that resolves to it), version chain (same family, ordered by date), relatedness (general profile only, top rare-term overlap above a documented threshold). Bidirectional pairs merge into one edge with summed weight. Keep the edge kinds in the data so the page can style them.
3. Families: documents whose normalized titles are the same or differ only by a year, version token or format (the PDF and Word copies of one regulation; the 2024 and 2025 issues) form a family; dates come from the title, front matter or file metadata. When detection is unsure, the pair is listed for the user to confirm in the Library page.
4. Deterministic initial positions from a seeded layout so the graph lands in the same place on every open. Build in seconds from the browse index; rebuild on library changes through the watcher events; expose through the bridge.

## Part C: Overview page, fifth entry in the Browse sidebar

Port the owner's earlier D3 graph (code supplied outside the repository in <eval-dir>; read it first) with these changes and nothing else changed in its feel:
1. D3 v7 bundled locally, never loaded from a CDN.
2. Force layout defaults as in the original: link distance 100, charge −300, collide 30; node radius from link count clamped 5 to 14; labels always visible; hover highlights the node and neighbours and fades the rest to 0.1; click opens the Document page; drag pins while dragging; search highlights matches and their neighbours; the legend stays fixed outside the zoom group.
3. A layered layout toggle replacing the people ring: bands by type in the profile's band order, using forceY with band positions computed from the current height, not fixed pixels.
4. Handle window resize; stop the previous simulation before starting a new one; fix the search selection so legend elements are never selected (select the node, label and link groups by class); re-apply the active search after a re-render.
5. Colors from the profile; the page follows the app's light and dark tokens; edge style by kind (solid for shared headings, dashed for references, dotted chain for versions).
6. Clicking an edge opens the Headings comparison for shared headings, or the referencing passage for a reference edge.

## Part D: summary layer (src/main/summaries)

1. Document summary: one sentence, at most 40 English words or 50 Chinese characters, from the title, outline and the first section; generated automatically after a document finishes indexing, one at a time, lowest priority, through the same Ollama model; cited to the document and verified like an Ask sentence. Shown on the Library page, the Document page and the Overview node tooltip. Nodes show a pending state until it exists.
2. Section summary: one sentence, at most 25 words or 35 Chinese characters, cited to the section and verified; off by default. Two entry points: a button on the Document page that generates for that document only, labelled with the estimated minutes; a library switch in the library menu that generates for every document and keeps generating for documents added later. Both have a hover tooltip: uses the model, Ask is slower meanwhile, can be paused. Unsupported sentences are dropped, never shown.
3. Queue rules: paused while any indexing is running and while a question is being answered; resumes after a few idle seconds; progress in the status bar as Summaries n of m with a pause control; file changed means only changed sections and the document summary are redone; file removed means its summaries and node are removed; a summary version key covering the model tag and prompt version marks old summaries stale and requeues them; the 8 GB tier generates no summaries.
4. Storage next to the section records, and a Markdown export folder per library (Obsidian-compatible: one file per document with front matter title, type, source path and the summaries, [[links]] to documents it references and to shared-heading pages, and one page per shared heading listing each document's section summary). Keep the export current as summaries and files change.

## Part E: Ask lockout during indexing

While the current library is indexing, the Ask question box is disabled and shows one line: reading new files, n left. It re-enables when indexing finishes. The summary queue pauses during indexing (Part D).

## Tests and acceptance

- Unit: kind detection on fixtures from both corpora, profile loading and override, edge rules including merge and weights, family detection with the PDF and Word copy case and the 2024/2025 case, seeded layout determinism, queue scheduling and pause rules, summary length caps and verification, export file contents.
- Playwright: Overview page renders both layouts, hover and search behave as specified, edge click opens the right view, tooltips on the two summary buttons, the Ask lockout during indexing.
- Integration (RUN_INTEGRATION=1, real backend): document summaries generated and verified for the English fixture corpus; a section summary for one document on demand; the export folder opens in Obsidian format (check front matter and links by parsing).
- Smoke: add one check that the overview data exists after indexing and lists the test documents.
- Docs: docs/graph.md, docs/profiles.md, docs/summaries.md, and the user guide updated with Overview and summaries in plain language.

Unit tests and lint, git checkout -- upstream, push the branch, write the PR body to <eval-dir>/pr-overview.md, print the compare URL, and wait for the PR number; then watch the mac workflow until green. Stop.
