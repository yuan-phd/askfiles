# The library graph

Session N. Code in src/main/graph (no model anywhere) and src/renderer/browse/graph.js. The Graph page (named Overview until 2026-11-04) is an entry of the Browse sidebar, after Find. It shows a library's documents as a graph: one node per document, coloured by type, linked by what the documents share. Types, colours and the links drawn depend on the library's profile (docs/profiles.md).

## Where it comes from

src/main/graph/service.ts (GraphService) builds the graph from the current library's browse index (src/main/browse) when a page asks for it. The browse index reports every change through BrowseIndex.onChange: a document built again, a document dropped, and the end of a load or sync. Those changes come from the watcher's file events. After one, the graph is marked stale. 400 ms later it is rebuilt and the pages are told on the graphEvent channel. Changing the profile, a document's type or a family answer rebuilds it too. Nothing is indexed again.

The graph is stored as `<dataDir>/libraries/<id>/graph.json`, beside browse/. The smoke tests read it to check that the graph lists the test documents (scripts/smoke-mac.sh, scripts/smoke-windows.mjs).

Build time, measured on the two test corpora on an M1 Max: 270 ms for the 12 English documents, 50 ms for the 15 Chinese ones. Most of the time goes to the reference search.

## Kinds

src/main/graph/kinds.ts, detectKind. Each document gets a structural kind when its browse entry is built (browse/build.ts). The kind is stored in the entry as `kind: { kind, scores, words }`, which is the document record the brief means. A browse file stored before Session N gets one when the index loads, written back once.

Signals, counted over at most 200,000 characters:

| Kind | Signals |
| --- | --- |
| normative | Numbered clauses at the start of a line: 第X条, Article 5, Section 1.1 / 1.1.1, (一), 一、. Obligation words: shall, must, may not, is required to, 应当, 不得, 必须, 禁止, 须在, 不予 |
| explanatory | The share of the text in prose paragraphs: 200 characters or more (80 for CJK), lines of 100 or more on average (40 for CJK), not table rows. Lowered by clause and obligation density |
| template | Placeholders ([insert name], [ ], ____, {{x}}, <name>, XXX, ……, （盖章）) and empty fields (a short label with nothing after its colon) |
| record | Dates, speaker labels (Ann Lee: ...), record words (attendees, agenda, action items, minutes of, 参会人员, 会议纪要, 议程), ticket ids (ABC-123), timestamps |
| data | 1 for xlsx, xlsm, xls and csv files; otherwise the share of lines that are table rows (cells joined by \|) |

Every density is counted per thousand words, a CJK character counting as two thirds of a word. A density d against its scale k scores 1 - exp(-d / k). Each is also scaled by a minimum count: full weight from 3 hits, so one stray "must" in a 100-word note does not make it normative. The scales:

- normative: clauses 5 and obligations 6 per thousand words, half each.
- template: 4.
- record: dates 8 (0.3 of the score), speakers 6 (0.25), record words 3 (0.35), tickets and timestamps 4 (0.1).

The highest score wins. A best score below 0.25 (MIN_KIND_SCORE), or a tie, gives other.

Calibration: corpus S and L in test/fixtures, and the two private test corpora (public procurement regulations and guidance, 12 English and 15 Chinese files), read from the browse files their eval runs keep. On those, regulations and procedures come out normative, guidance documents and policies explanatory, plan templates and bidding documents template, and spreadsheets and table-heavy standards data.

src/main/graph/kinds.test.ts checks these when ASKFILES_EVAL_RUNS points at the runs folder and skips otherwise.

## Families

src/main/graph/families.ts. Two documents are one family when their family keys are equal. The key is the file name with these taken off:

- the extension;
- a leading file number (04_, 13_);
- dates and years (2024, 2017年版);
- version tokens (v2, version 3, rev 1, draft, final, 第二版, 修订版, 试行);
- a copy marker ((2), 副本);
- every character that is not a letter or digit.

Examples: the PDF and Word copy of 差旅费管理办法, and Staff Regulations 2024 and 2025. A key needs at least 4 letters, or 3 CJK characters.

A family's members are ordered oldest first:

1. by date: from the title, then front matter, then the file's modification time;
2. then by version number;
3. then by name.

Two keys that are close but not equal are a question for the user:

- each key has 6 or more characters;
- and either the edit distance is at most 20 percent of the longer key (at least 2),
- or one key is the start of the other with at most a quarter left over.

The Library page lists the questions under "Are these the same document?" with Same document and Different. The answers are stored per pair in the library record (`familyDecisions`) and win over detection both ways: Different splits a pair detection had joined.

## Edges

src/main/graph/edges.ts. Each edge has a kind and a weight. A pair linked by the same rule in both directions is one edge, with the weights summed and the passages of both directions kept. Which rules run is the profile's choice.

| Kind | Rule | Weight |
| --- | --- | --- |
| headings | At least 2 shared normalized headings (the browse heading key). The page parts of one long section (Title (page 2)) and (continued) count once. Headings that are only numbering (第一章, Chapter 3) are left out | Number of shared headings |
| reference | One document's text names another. Names are the browse identifiers of several words or of 4 or more CJK characters: Staff Regulations, 差旅费管理办法. A 《title》 mark counts when it holds the name. With clauseReferences (legal-finance), a single type word counts after a clause reference: paragraph 5.9 of the Regulations. Documents of one family are not linked this way | Sections that mention it; up to 5 passages kept |
| version | Consecutive members of a family. sameIssue marks two formats of one issue | 1 |
| related | General profile only. Rare terms are content words of 4 or more letters and CJK character pairs found in at least 2 documents and at most 10 percent of them (2 in a small library). A pair needs 5 shared rare terms (RELATED_MIN_SHARED) and a set cosine of 0.08 (RELATED_MIN_SCORE: shared terms over the geometric mean of both sets), and must be among the 3 best pairs of both documents | Shared rare terms |
| project | Team work. A title word of 3 or more letters, not a cue word, month or number, in at least 2 titles and at most 30 percent of them; Chinese titles by character pairs, two pairs making one name | Shared names |
| ticket | Team work. The same ticket id (ABC-123) in two documents | Shared ids |
| date | Team work. Two documents of one type, dated in the title or front matter, at most 31 days apart, next to each other in date order | 1 |

In a large library (below) a shared-headings edge needs 3 shared headings, and each document keeps at most its 5 strongest edges.

On the English test corpus (legal-finance) this gives 7 shared-heading edges and 20 reference edges. The Chinese test corpus gives 3 shared-heading edges between three bidding templates, 6 reference edges from texts that cite another document by its title in 《》 marks, and 1 version edge between the PDF and the Word copy of one document.

Chinese relatedness works on character pairs and is rougher than English.

## Layout

src/main/graph/layout.ts gives every node two seeded positions in -1 to 1:

- organic: a sunflower spiral, grouped by band, nudged by a generator seeded from the document id;
- layered: one row per band, in id order.

The page scales them to its size and runs d3-force from there. d3-force is deterministic from given positions, so the graph opens the same way every time.

## The page

src/renderer/browse/graph.js is a port of the owner's earlier wiki graph (docs/reference/old-graph-code.txt, renderGraph and filterGraph), with its constants:

- link distance 100, charge -300, collide 30;
- node radius count * 1.2 + 4, clamped 5 to 14; label offset as before;
- labels always shown;
- hover lights the node and its neighbours and fades the rest to 0.1, links 0.8 and 0.05;
- drag pins the node while it is dragged;
- zoom from 0.2 to 5;
- the legend appended to the svg, outside the zoom group.

Changes:

- **d3 bundled.** d3 7.9.0 comes from the app's own files: askfiles://app/vendor/d3.min.js maps to node_modules/d3/dist/d3.min.js (src/main/app-protocol.ts VENDOR_FILES). It is never loaded from a CDN. Every d3 module is pinned to a release from before 2026-10-21 by overrides in package.json. All 30 d3 modules got new releases on 2026-11-03, after more than two years without one, so the pinned versions are the ones before that.
- **Layered layout.** It replaces the people ring: bands by type in the profile's band order, through forceY to evenly spaced band heights computed from the current height, plus a weak forceX (0.03) to the middle. Organic keeps the original's forceCenter.
- **Resize.** A ResizeObserver draws again at the new size. The previous simulation is always stopped before a new one starts.
- **Search** selects only the node, label and link groups by class, so the legend's circles are never touched. The old code threw on them. The active search is applied again after a redraw and after a hover, instead of being cleared.
- **Colours and styles.** Colours come from the profile. The page uses the app's light and dark tokens (ask.css). Edge style by kind: solid for shared headings, dashed for references, dotted for versions.
- **Clicks.** Since 2026-11-09 a click selects and a double click opens (Selection, below); before, a click on a node opened its Document page. A shared-headings edge opens that heading on the Compare page; with several shared headings, a small list asks which. A reference edge opens the Document page at the referencing passage. Wide invisible lines over the edges make thin edges clickable.
- **Centering pull.** Every node is pulled weakly toward the middle (forceX and forceY, strength 0.04, CENTERING in graph.js; in the layered layout the x pull only, the bands keep y). forceCenter alone moves only the centre of mass, so with the original charge a document without links was pushed off screen; with the pull it rests at the outer edge of the cluster. Linked documents keep the original shape.
- **Fit to view**, the fallback. When the layout comes to rest and a node or label still lies outside the view (a small window, long labels), the view zooms out just enough to show them all. It never zooms in and never overrides a zoom the user made.
- **Leaving the page.** Every way off the Graph page (a tab, a node, an edge, Back) stops the simulation, removes the drawing and the zoom's wheel, touch and pointer listeners, and takes the graph-on class off the content area, so the page that follows scrolls again (it did not when a document was opened from the Graph page).
- **Tooltip.** Hovering a node shows a tooltip with the title, type, section count, date and the document summary, or Summary pending (docs/summaries.md). A node whose summary is pending has a dashed outline.

## Large libraries

src/main/graph/scale.ts and src/renderer/browse/graph-model.js. A tester's library of about 900 documents in nested folders gave a graph that was quick to build but could not be read: long labels on top of each other and nothing to find or click. Since 2026-11-09 a library of **more than 50 documents** (LARGE_LIBRARY) is a large library. A library of 50 or fewer keeps the graph described above: every node, labels always shown, the edge rules above.

### Stricter edges

Only in a large library, after all the edge rules have run (buildEdges with large set):

- a shared-headings edge needs at least **3** shared headings (LARGE_MIN_SHARED_HEADINGS) instead of 2;
- each document keeps at most its **5** strongest edges (MAX_EDGES_PER_DOCUMENT), counted over every kind. capEdges takes the edges heaviest first by their weight (the weights in the Edges table), ties by edge id (kind:a:b, a before b), and keeps an edge when both its documents have fewer than 5 kept so far. The result never depends on the order of the input, and no edge is dropped while both its ends still have room.

The graph data says which rules ran: `large` and `rules: { minSharedHeadings, maxEdgesPerDocument }` (null without a cap). Every node also carries `displayName`, the name the source cards use (browse/identifiers.ts libraryDisplayNames).

### Views

A small segmented control above the graph: Local, Folders, All. A large library opens on Folders (Local until 2026-11-09), a small one on All; both can switch to any view. The page history keeps the view and Local's centre, so Back returns to them.

- **Local.** One document in the middle (thick outline) and the documents linked to it; "Also show what those link to" adds a second step. Past 30 neighbours (LOCAL_LIMIT) the 30 strongest are drawn, direct ones by the weight of their link to the centre, then the second step by their strongest link into the first, and a "+N more" node lists the rest; choosing one recentres on it. A click selects a node; Show in Local on its card, or a double click on a node other than the centre, recentres; a double click on the centre opens its Document page, as does Open document in the bar. Labels always shown. Without a centre yet, the page shows the search box and a line asking to pick a document. With the cap of 5, a large library reaches "+N more" only through a small library's hub or a very connected second step.
- **Folders.** One node per first-level subfolder of the library's linked folders (the folder right below the linked folder); the files at the top of a linked folder form a node named after it, the files added to the library directly one called Added files. Two linked folders with a subfolder of the same name keep two nodes, labelled Parent › Name. Node size grows with the document count (8 + 2.2 sqrt(count), at most 36). A link between two folders stands for every edge between their documents; its thickness grows with that count (1 + 1.5 log2(count)). Clicking a folder opens it in place (with a document selected, see Selection): its documents start where it was, the other folders stay where they rested. An edge from an open folder's document to a document in a closed folder goes to the closed folder's node, and becomes a document-to-document edge (clickable as on All) once that folder is open too. Edges inside one closed folder are not drawn. The open folders are listed as chips under the tools; a chip closes its folder. If no document lies in a subfolder, the nodes are document types instead.
- **All.** Every document. With more than 50 drawn, labels are hidden except for the 10 documents with the most links (ties by display name, then id); a label also shows on hover (the node and its neighbours), for search matches and their neighbours, and for every node once zoomed in past 1.6 (LABEL_ZOOM).

In Folders, a document's label follows the same rule over the documents drawn: all shown up to 50, else the top 10 and the rest on hover, search or zoom.

**Search** works on every view. Typing lights the matching documents (display name, file name or path) and their neighbours and shows their labels; in Folders a closed folder holding a match lights instead. A list of up to 8 results opens under the box; Enter takes the first. Choosing one in Local recentres on it; in Folders it opens its folder; in All it lights that document.

**Show in graph** on the Document page (beside Open original) and on each Library row opens Local centred on that document.

**Labels** show the display name, cut with an ellipsis past 150 px (estimated per character, CJK characters counting as wide), and the tooltip shows the full name with the file name below it. In a large drawing a label keeps 11 px on screen when the view is zoomed out to fit.

**Label placement** (every view, small libraries too). Labels never run into each other or into a folder's circle. The labels shown are placed in order of importance: the selected document, the documents it links to, folders, search matches, the ten most linked, then the rest in drawing order. Each takes the first free spot beside its node: right (the original offset), left, below, above, then right and left one line higher or lower; a folder's label tries below first. Widths are measured once per label (getComputedTextLength). A label with no free spot is held back (class crowded) until there is room after a zoom, a move or a new selection. Placement runs every 4 ticks while the layout moves (when at most 150 labels show), when it rests, a frame after a zoom, and whenever the labels shown change. Labels can still pass over other documents' dots.

### Selection

In every view, the small library's graph included:

- **One click** on a document selects it: it gets an accent outline, its links are drawn in the accent colour, it and the documents it links to stay at full strength and everything else is dimmed to 0.1. The labels of the selected document and what it links to show; other labels follow the rules above, dimmed. Hovering another node shows its tooltip but does not change the lighting.
- Its **card** is pinned at the top right under the tools (it does not follow the mouse): name, file name, type, sections, date, summary, and two actions, Open document and Show in Local.
- **Double click** on a document opens its Document page (in Local: see Local above). A double click on a folder or on "+N more" does nothing more than the click.
- A click on **empty space** or **Esc** clears the selection. Show in Local and every recentring clear it too.
- The selection stays across a redraw while the document is drawn: in Folders its folder is opened for it; closing that folder from its chip clears it.
- **Folders with a selection.** Clicking a closed folder opens it. The selected document's links to that folder become links to its documents, and only the documents in it that are linked to the selected one are lit; the others are dimmed. Without a selection a folder opens as before.

**Forces.** A small All keeps the original's forces. Local keeps them too but cools like the large views (alphaDecay 0.06, about 110 ticks instead of 300), so it rests in about 2 s. A large drawing uses link distance 40, charge -45, collision radius + 4 and a faster cooling (alphaDecay 0.06). Folders push harder (charge -600 per folder), keep room for the label under each folder (collision radius + 34) and pull only weakly along the folder links (strength 0.08). The fit after the layout rests also keeps a large drawing clear of the tools at the top. Rendering stays SVG.

### Measured

An invented library of 900 documents (test/fixtures/make-graph-library.mjs: a made-up water cooperative, two linked folders, 14 first-level subfolders nested up to two levels deeper, 7 files at the top of a linked folder, 23 added files; 6 to 13 headings per document from shared, department and folder pools). Measured on the owner's Mac (Apple Silicon, Node 22, Chromium from Playwright 1.63 at 1200 x 860), by test/e2e/graph-scale.spec.mjs:

| Step | Time |
| --- | --- |
| Build the graph data (buildGraph, 900 nodes, 2175 edges after the cap), three runs | 1346, 1314, 1271 ms |
| of which the reference search | about 840 ms |
| Local settles (centre with 5 neighbours; original forces, alphaDecay 0.06 since 2026-11-09; 5.0 s before) | 1.9 s |
| Folders settles (16 folders) | 1.9 to 2.2 s |
| All settles (900 nodes) | 4.0 s |

Settle time runs from the start of the drawing to the end of the force layout (data-settle-ms on the graph root); the nodes move on screen during it and can be clicked.

Screenshots: docs/screenshots/graph (local, folders, folders-expanded, folders-selected, all, all-search, all-selected; light and dark).

