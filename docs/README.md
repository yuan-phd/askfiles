# AskFiles documentation

## Using AskFiles

- [user-guide.md](user-guide.md): the app in plain language: adding documents, libraries, asking, browsing, the Graph, summaries, accuracy and what it cannot do well.
- [windows.md](windows.md): installing on Windows, the SmartScreen warning, the first launch, where data is kept and the known limits; also how the Windows build is made and smoke tested.

## How it works

- [app.md](app.md): the app end to end: windows and pages, first run, libraries, the folder watcher, settings, the browse index, the answer pipeline with citation checking, OCR and network use.
- [process-manager.md](process-manager.md): how the three local processes (Ollama, collector, server) are started, health-checked and stopped.
- [presets.md](presets.md): the per-memory presets in config/presets.json, the first-run wizard and the model manager.
- [graph.md](graph.md): the library graph: document kinds, families, edges, layout and the Graph page.
- [profiles.md](profiles.md): library profiles: types, colours, cues, bands and edge rules per profile.
- [summaries.md](summaries.md): document and section summaries, how they are checked, their queue, storage and the Markdown export.
- [upstream-analysis.md](upstream-analysis.md): what the vendored AnythingLLM core does, its configuration, API and the risks that led to the patches.

## Evaluation

- [case-study-cross-document.md](case-study-cross-document.md): how cross-document answers were evaluated and improved: metrics, seeded runs, the keep rule, the rounds, the sealed holdout and its result.
- [eval.md](eval.md): the evaluation harness: running it, every configuration switch, the metrics and how answers are graded.
- [eval-smoke/](eval-smoke/): output of small smoke runs that only test the harness; they say nothing about quality.

## Building and packaging

- [packaging.md](packaging.md): building, ad-hoc signing and copying the macOS app, and what to expect from Gatekeeper.
- [windows.md](windows.md): the Windows build and its smoke test (see Using AskFiles).
- [bundle-report.md](bundle-report.md): what the packaged dependencies weigh and why each pruning step is safe.
- [licenses.md](licenses.md): the licenses of AskFiles, the vendored core and the bundled third-party components.

## Development records

- [plan.md](plan.md): the project plan, the source of truth for decisions, phases, measurement rounds and acceptance criteria; the original Claude Doc is a historical snapshot.
- [tickets/](tickets/): engineering tickets, one file each.
- [test-build.md](test-build.md): the test build with its local question record: flavours, building, export, record format, the summary script.
- [tester-sheet.md](tester-sheet.md): one page for testers of the test build, in English and Chinese.
- [reference/old-graph-code.txt](reference/old-graph-code.txt): earlier wiki graph code, the source the Graph page ports.
- [media/](media/): the README screenshots and GIF, taken from an invented demo library.
- [screenshots/](screenshots/): screenshots of adding files, the Compare and Graph pages and libraries.
