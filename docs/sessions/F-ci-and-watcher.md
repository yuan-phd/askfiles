# Session F: CI workflow and folder watcher (plan tasks 1.8 and 3.2)

Executor: CLOUD writes both; CI runs the workflow
Dependencies: Sessions B and C merged
Branch: session/f-ci-watcher
PR title: [Session F] macOS CI workflow and folder watcher

## Part 1: GitHub Actions workflow

Deliverable: .github/workflows/mac.yml on macos-14 (Apple Silicon runner).

Jobs and steps:
1. test: ubuntu-latest, npm ci, npm test, npm run lint. Fast gate before the Mac job.
2. package: macos-14, needs test. Checkout, Node 22, npm ci, make build with PACKAGE_TARGET=mac-arm64, download the Ollama macOS binary into resources/ (pin the version in a workflow variable and verify its SHA256), npm run package:mac, scripts/sign-adhoc.sh, upload the DMG as an artifact named by commit SHA.
3. smoke: macos-14, needs package. Download the artifact, mount the DMG with hdiutil, copy the app to a temp dir, launch it with open, poll the shell's health file or log for the server port (define how the shell publishes its port: write <dataDir>/ports.json; add that to the process manager if missing), curl /api/ping, upload test/fixtures/sample.pdf through the API, make one chat call with the test model, assert a non-empty answer, take a screenshot with screencapture, upload it, and kill the app. Fail the job on any step.

Constraints: no secrets required; the workflow must be green on a fork with no certificates. Keep total runtime under 30 minutes; cache node_modules and the Ollama download. Use the GitHub Actions concurrency key so a new push cancels the previous run.

The model used in smoke must be small (the same test models as the cloud environment). Pulling it on the runner is part of the smoke job and counts toward the time budget.

## Part 2: folder watcher

Deliverable: src/main/watcher/ with tests.

Behaviour:
- One watched root folder, recursive, configured by the shell. File types limited to what the collector supports (list from docs/upstream-analysis.md).
- Debounce 2 seconds per path. Ignore partial writes: a file whose size changed in the last 2 seconds is not uploaded yet.
- On add or change: split by section if the override chosen in docs/upstream-analysis.md Q13 is pre-splitting in the shell (see docs/plan.md, Chunking), then upload through the API client (src/renderer/api/client.js logic ported or shared into a Node module), embed into the library workspace, record file path, hash, document id and timestamp in <dataDir>/index.json.
- On delete: remove the document from the workspace and from index.json.
- On start: reconcile the folder against index.json (new, changed by hash, missing) and queue the work; emit progress events the status bar can show.
- Concurrency: one upload at a time, a queue with retries (3, with backoff) and a dead-letter list surfaced in events.
- Everything injected: API base URL, API key, workspace slug, data directory, file system watcher implementation (chokidar if its size is acceptable, otherwise fs.watch with polling fallback; justify in the PR).

Requirements from Session D (search page, PR #4), decided by the owner:

- Section titles in the nothing-found list. The search page lists the closest sections from POST /api/v1/workspace/{slug}/vector-search, which drops custom metadata keys (docs/upstream-analysis.md Q15). The shell fills them in from the section records this session keeps; no upstream patch. Expose a lookup that, given vector-search results normalized by src/renderer/api/client.js (id, title, url, text), returns them with sectionTitle, sectionIndex, page and pageEnd added. Match on the document the shell wrote (url or file name) plus the chunk text. The page calls it as window.shellConfig.resolveSources(sources) and shows file names until it exists; the Electron wiring (task 3.5) connects the two. Unit test the lookup with sub-chunks of a long section.
- No heading-only documents. The section splitter folds each heading into the body of its section and never emits a document whose content is only a heading. A heading with an empty body joins the next section, or the previous one at the end of a file. The section title is already carried as sectionTitle, so the body does not need to start with a heading line followed by a blank line; that pattern made upstream produce a heading-only sub-chunk in Session D's real-server test. Unit test both cases.

Tests: unit tests with a temp directory and a fake API (add, change, delete, partial write, reconcile after restart, retry then dead-letter). Integration test against the real upstream server when RUN_INTEGRATION=1: drop a PDF into a temp folder and assert it becomes queryable within 60 seconds.

## Do not

- Do not add certificate or notarization steps.
- Do not edit upstream/.

## Acceptance

- Workflow file passes actionlint; a dry explanation in the PR of each step's expected duration.
- Watcher unit tests green; integration green or skipped with reason.
- PR opened. Note in the body that the first real workflow run happens after merge and may need one fix-up PR.
