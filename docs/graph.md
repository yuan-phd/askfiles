# The overview graph

Session N. Code in src/main/graph (no model anywhere) and src/renderer/browse/overview.js. The Overview page is an entry of the Browse sidebar, after Find. It shows a library's documents as a graph: one node per document, coloured by type, linked by what the documents share. Types, colours and the links drawn depend on the library's profile (docs/profiles.md).

## Where it comes from

src/main/graph/service.ts (GraphService) builds the graph from the current library's browse index (src/main/browse) when a page asks for it. The browse index reports every change through BrowseIndex.onChange: a document built again, a document dropped, and the end of a load or sync. Those changes come from the watcher's file events. After one, the graph is marked stale. 400 ms later it is rebuilt and the pages are told on the graphEvent channel. Changing the profile, a document's type or a family answer rebuilds it too. Nothing is indexed again.

The graph is stored as `<dataDir>/libraries/<id>/graph.json`, beside browse/. The smoke tests read it to check that the overview lists the test documents (scripts/smoke-mac.sh, scripts/smoke-windows.mjs).

Build time, measured on the owner's corpora on an M1 Max: 270 ms for the 12 English documents, 50 ms for the 15 Chinese ones. Most of the time goes to the reference search.

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

Calibration: corpus S and L in test/fixtures, and the owner's two corpora, English T1 (12 files) and Chinese ZH (15 files), read from the browse files the eval runs keep in ~/AskFiles-eval/runs. The owner corpora results:

- the Procurement Regulations, Procedure and the Chinese 规定 and 办法 come out normative;
- the four guidances, the Policy and the Directive come out explanatory;
- the plan template, the Request for Bids and the three 招标文件 come out template;
- the spreadsheets and the table-heavy 台式计算机需求标准 come out data.

src/main/graph/kinds.test.ts checks these where the files exist and skips otherwise.

## Families

src/main/graph/families.ts. Two documents are one family when their family keys are equal. The key is the file name with these taken off:

- the extension;
- a leading file number (04_, 13_);
- dates and years (2024, 2017年版);
- version tokens (v2, version 3, rev 1, draft, final, 第二版, 修订版, 试行);
- a copy marker ((2), 副本);
- every character that is not a letter or digit.

Examples: the PDF and Word copy of 必须招标的工程项目规定, and Procurement Regulations 2024 and 2025. A key needs at least 4 letters, or 3 CJK characters.

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
| reference | One document's text names another. Names are the browse identifiers of several words or of 4 or more CJK characters: Procurement Regulations, 必须招标的工程项目规定. A 《title》 mark counts when it holds the name. With clauseReferences (legal-finance), a single type word counts after a clause reference: paragraph 5.9 of the Regulations. Documents of one family are not linked this way | Sections that mention it; up to 5 passages kept |
| version | Consecutive members of a family. sameIssue marks two formats of one issue | 1 |
| related | General profile only. Rare terms are content words of 4 or more letters and CJK character pairs found in at least 2 documents and at most 10 percent of them (2 in a small library). A pair needs 5 shared rare terms (RELATED_MIN_SHARED) and a set cosine of 0.08 (RELATED_MIN_SCORE: shared terms over the geometric mean of both sets), and must be among the 3 best pairs of both documents | Shared rare terms |
| project | Team work. A title word of 3 or more letters, not a cue word, month or number, in at least 2 titles and at most 30 percent of them; Chinese titles by character pairs, two pairs making one name | Shared names |
| ticket | Team work. The same ticket id (ABC-123) in two documents | Shared ids |
| date | Team work. Two documents of one type, dated in the title or front matter, at most 31 days apart, next to each other in date order | 1 |

On the owner's English corpus (legal-finance) this gives 7 shared-heading edges and 20 reference edges. The Chinese corpus gives:

- 3 shared-heading edges between the three 招标文件;
- 6 reference edges, from texts that cite 《必须招标的工程项目规定》 and 《商品包装政府采购需求标准（试行）》;
- 1 version edge between the PDF and the Word copy.

Chinese relatedness works on character pairs and is rougher than English.

## Layout

src/main/graph/layout.ts gives every node two seeded positions in -1 to 1:

- organic: a sunflower spiral, grouped by band, nudged by a generator seeded from the document id;
- layered: one row per band, in id order.

The page scales them to its size and runs d3-force from there. d3-force is deterministic from given positions, so the graph opens the same way every time.

## The page

src/renderer/browse/overview.js is a port of the owner's earlier wiki graph (docs/reference/old-graph-code.txt, renderGraph and filterGraph), with its constants:

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
- **Clicks.** A node opens its Document page. A shared-headings edge opens the Headings comparison for that heading; with several shared headings, a small list asks which. A reference edge opens the Document page at the referencing passage. Wide invisible lines over the edges make thin edges clickable.
- **Centering pull.** Every node is pulled weakly toward the middle (forceX and forceY, strength 0.04, CENTERING in overview.js; in the layered layout the x pull only, the bands keep y). forceCenter alone moves only the centre of mass, so with the original charge a document without links was pushed off screen; with the pull it rests at the outer edge of the cluster. Linked documents keep the original shape.
- **Fit to view**, the fallback. When the layout comes to rest and a node or label still lies outside the view (a small window, long labels), the view zooms out just enough to show them all. It never zooms in and never overrides a zoom the user made.
- **Leaving the page.** Every way off the Overview (a tab, a node, an edge, Back) stops the simulation, removes the drawing and the zoom's wheel, touch and pointer listeners, and takes the overview-on class off the content area, so the page that follows scrolls again (it did not when a document was opened from the Overview).
- **Tooltip.** Hovering a node shows a tooltip with the title, type, section count, date and the document summary, or Summary pending (docs/summaries.md). A node whose summary is pending has a dashed outline.
