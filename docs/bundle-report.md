# Bundle report

Session I, 2026-10-29. What the packaged server and collector dependencies weigh, what scripts/prune.mjs removes and why each removal is safe. Regenerate the tables with `bash scripts/measure-bundle.sh [resources-dir]`.

## Summary

| | Before | After |
| --- | --- | --- |
| DMG, mac CI (macos-14) | 695 967 267 bytes (663.7 MiB), run 8 | MAC_DMG_AFTER |
| AskFiles.app unpacked, mac CI | 2 458 796 KB (2.34 GiB) | MAC_APP_AFTER |
| server and collector node_modules, mac CI | 1.15 GB in 93 884 files | MAC_NM_AFTER |
| server and collector node_modules, Linux packaging | 1.33 GB in 92 594 files | 910.0 MB in 55 659 files |
| package job, mac CI | 22 min 44 s on main (run 6), 19 min 20 s with warm caches (run 8) | PKG_AFTER |

Before on the mac is CI run 8 (this PR's first push, which only added the measurement step) against main's build. The brief expected about 1.6 GB; that is the size of the unpacked dependency folders, the DMG was already compressed to 664 MiB. Ollama (523 MiB unpacked, kept whole) is the largest part that pruning does not touch.

## Pruning steps

scripts/build.sh runs scripts/prune.mjs as step 7 for `PACKAGE_TARGET=mac-arm64` (target darwin-arm64) and `PACKAGE_TARGET=linux-x64` (the cloud check). It works on upstream/server/node_modules and upstream/collector/node_modules after the production install, which is the copy electron-builder packages; tracked files under upstream/ are never touched. Savings below were measured on the Linux install in this container, one step after the other.

| Step | server | collector | Linux packaging after the step |
| --- | --- | --- | --- |
| Before (main, with the old onnxruntime filter in electron-builder.yml) | | | 1.33 GB, 92 594 files |
| 1. platform: binaries the target cannot load | 76.6 MB, 20 files | 78.7 MB, 45 files | 1.32 GB, 92 553 files (the filter is gone, so Linux keeps its own onnxruntime) |
| 2. dedupe | 0 | 0 | nothing removed, see below |
| 3. dev: source maps, typings, @types, readme and changelog, test, example and doc folders | 185.8 MB, 18 992 paths | 105.8 MB, 12 964 paths | 1.03 GB, 56 793 files |
| 4. unused: canvas, chartjs-node-canvas, @mintplex-labs/mdpdf, puppeteer | 136.8 MB, 9 packages | 8.8 MB, 64 packages | 910.0 MB, 55 659 files |

After every step: scripts/check-server-boot.sh passed, and scripts/check-packaged-backend.mjs passed against the packaged copy (release/linux-unpacked/resources): prisma migrate deploy, collector and server healthy, upload and parse of a PDF, a DOCX, an XLSX and a Markdown file, OCR of a PNG, embedding of the five documents into a workspace with all-minilm, one chat answer with sources from qwen3:0.6b. After step 4, `npm run test:integration` passed (5 tests) on the same pruned tree.

### 1. Other platforms

prune.mjs reads the first 20 bytes of every file. For darwin-arm64 it removes ELF and PE files and thin Mach-O libraries and bundles that are not arm64; an x86_64 Mach-O executable stays, since Rosetta can run it. Fat Mach-O files stay. For linux-x64 it removes Mach-O, PE and non x86-64 ELF. On the mac this covers onnxruntime-node for five platforms (until now an electron-builder filter, removed), the bare-fs, bare-os and bare-url prebuilds and the Prisma engines that step 5 already removes. iOS arm64 prebuilds of bare-* (about 0.1 MB each) cannot be told from macOS arm64 by the header and stay.

### 2. Duplicates

Yarn classic has no dedupe command, and the upstream lock files may not change. The only removal that keeps every require resolving to the same code is a nested copy whose nearest ancestor copy has the same name and version; there are none, yarn already hoists those. The remaining identical copies sit under different parents (server: 78 name and version pairs, 19.5 MB; collector: 18 pairs, 11.5 MB), mostly @types/node, which step 3 removes. Merging the rest would change which copy other packages resolve. Not done.

### 3. Development files

Removed: `*.js.map` and other source maps, `*.d.ts` typings, every @types package without JavaScript, README, CHANGELOG and HISTORY files, and the folders test, tests, `__tests__`, example, examples, docs, doc, .github and coverage directly under a package root unless main, module, browser, bin or exports point into them. Folders of the same name deeper down stay (yaml/dist/doc is code). LICENSE and NOTICE files stay, and so does the readme of a package without a license file, because it may be the only license notice (docs/licenses.md). Source maps only change stack traces in logs, which then point at the shipped JavaScript.

### 4. Packages AskFiles never reaches

Upstream requires them only here (grep of upstream/server and upstream/collector outside node_modules and tests):

| Package | Required in | Feature | Used by AskFiles |
| --- | --- | --- | --- |
| canvas | server/utils/chats/exportChatToFile.js:59, inside a function, try/catch | image thumbnails in chat export | no |
| chartjs-node-canvas (needs canvas) | server/utils/telegramBot/chat/agent.js:442 | charts in the Telegram bot | no |
| @mintplex-labs/mdpdf | server/utils/chats/exportChatToFile.js:285, server/utils/agents/aibitat/plugins/create-files/pdf/create-pdf-file.js:89, both dynamic imports | chat export to PDF, agent create-pdf skill | no |
| puppeteer | langchain's PuppeteerWebBaseLoader, dynamic import with try/catch; upstream only names it in JSDoc types (collector/processLink/convert/generic.js, utils/extensions/WebsiteDepth/index.js) | link scraping | no |

prune.mjs removes each one and the packages that only it pulled in, and refuses the whole step when any of these holds: an upstream file outside the table requires a removed package; a remaining package declares a dependency on one; a remaining package's code requires one, except two optional requires read by hand (jsdom wraps require("canvas") in try/catch; langchain's loader imports puppeteer only when scraping). Packages upstream source requires without declaring them stay with their dependencies: collector/utils/shell.js imports strip-ansi, which only puppeteer pulls in; the first dry run caught it.

scripts/check-server-boot.sh boots the server with canvas blocked; with canvas removed it passes the same way. The chat export, Telegram and agent paths now fail inside their own try/catch, as they already could on the Mac when the canvas prebuild download fails (docs/packaging.md). They are only reachable through the upstream interface behind the developer switch.

## Not pruned

- onnxruntime-web (50 MB in each tree after step 3): @xenova/transformers imports it at load, also in Node.
- @lancedb/lancedb-darwin-arm64 (69.6 MB): the vector database.
- prisma and @prisma/engines (66 MB): `prisma migrate deploy` runs at every start.
- tesseract.js-core (29 MB): OCR.
- Further candidates that need an owner decision first, because they are not in the brief's list: chromadb and chromadb-default-embed (47 MB, the Chroma vector database provider; AskFiles uses LanceDB), the other vector database clients (weaviate-client, @zilliz/milvus2-sdk-node, @qdrant, @pinecone-database), and pdf-parse's three unused pdf.js builds (collector uses v1.10.100).

## Open question found on the way

The tesseract language data is not shipped. docs/plan.md (Session B) says the app ships eng and chi_sim 4.0.0_best_int so OCR never downloads; neither scripts/build.sh nor electron-builder.yml includes them, and collector/utils/OCRLoader reads STORAGE_DIR/models/tesseract, else tesseract.js downloads from cdn.jsdelivr.net. scripts/check-packaged-backend.mjs seeds that folder from TESSDATA_DIR for the OCR check. Which session adds them?

## CI time

| Package job step | main, run 6 | this PR, before (run 8) | this PR, after (RUN_AFTER) |
| --- | --- | --- | --- |
| build.sh (patches, frontend, installs, prisma) | 3 min 20 s | 1 min 13 s (warm yarn cache) | STEP_BUILD |
| electron-builder dir | 57 s | 34 s | STEP_EB |
| sign-adhoc.sh | 15 min 34 s, of which 14 min 6 s running file(1) per file | 12 min 7 s | STEP_SIGN |
| DMG | 3 min 0 s | 2 min 52 s | STEP_DMG |
| whole package job | 22 min 44 s | 19 min 20 s | PKG_AFTER |

## Measurements

### Linux packaging before pruning

Packaged from the same commit with `bash scripts/build.sh` (no target, nothing pruned). The electron-builder onnxruntime filter is gone, which is why this is larger than main's 1.33 GB.

LINUX_BEFORE

### Linux packaging after pruning

LINUX_AFTER

### mac CI, before (run 8)

MAC_BEFORE

### mac CI, after (RUN_AFTER)

MAC_AFTER
