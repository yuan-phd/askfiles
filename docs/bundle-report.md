# Bundle report

Session I, 2026-10-29. What the packaged server and collector dependencies weigh, what scripts/prune.mjs removes and why each removal is safe. Regenerate the tables with `bash scripts/measure-bundle.sh [resources-dir]`.

## Summary

| | Before | After |
| --- | --- | --- |
| DMG, mac CI (macos-14) | 695 967 267 bytes (663.7 MiB), run 8 | 578 415 079 bytes (551.6 MiB), run 15: 117.6 MB (16.9 percent) smaller, although Session H added the tesseract data and pages to app.asar since run 8 |
| AskFiles.app unpacked, mac CI | 2 458 796 KB (2.34 GiB) | 1 900 344 KB (1.81 GiB) |
| server and collector node_modules, mac CI | 1.15 GB in 93 884 files | 740.6 MB in 53 354 files |
| server and collector node_modules, Linux packaging | 1.33 GB in 92 594 files | 842.2 MB in 52 063 files |
| package job, mac CI | 26 min 45 s on main (run 6), of which 22 min 52 s in Build, package and sign; 19 min 20 s in run 8 | 4 min 15 s with warm caches (run 12), 9 min 27 s with the new caches empty (run 11) |

Before on the mac is CI run 8 (this PR's first push, which only added the measurement step) against main's build. The brief expected about 1.6 GB; that is the size of the unpacked dependency folders, the DMG was already compressed to 664 MiB. Ollama (523 MiB unpacked, kept whole) is the largest part that pruning does not touch.

## Pruning steps

scripts/build.sh runs scripts/prune.mjs as step 7 for `PACKAGE_TARGET=mac-arm64` (target darwin-arm64) and `PACKAGE_TARGET=linux-x64` (the cloud check). It works on upstream/server/node_modules and upstream/collector/node_modules after the production install, which is the copy electron-builder packages; tracked files under upstream/ are never touched. Savings below were measured on the Linux install in this container, one step after the other.

| Step | server | collector | Linux packaging after the step |
| --- | --- | --- | --- |
| Before (main, with the old onnxruntime filter in electron-builder.yml) | | | 1.33 GB, 92 594 files |
| 1. platform: binaries the target cannot load | 76.6 MB, 20 files | 78.7 MB, 45 files | 1.32 GB, 92 553 files (the filter is gone, so Linux keeps its own onnxruntime) |
| 2. dedupe | 0 | 0 | nothing removed, see below |
| 3. dev: source maps, typings, @types, readme and changelog, test, example, doc and benchmark folders | 186.4 MB, 18 994 paths | 105.8 MB, 12 964 paths | 1.03 GB, 56 793 files (measured before benchmark folders were added: 0.6 MB, 2 paths) |
| 4. unused: canvas, chartjs-node-canvas, @mintplex-labs/mdpdf, puppeteer | 136.8 MB, 9 packages | 8.8 MB, 64 packages | 910.0 MB, 55 659 files |
| 5. providers: vector database clients 74.8 MB, model provider SDKs 2.1 MB | 76.9 MB, 73 packages | 0 | 842.2 MB, 52 063 files |

On the mac runner (run 15, rebased onto Session H) the same steps removed: platform 72.1 MB server and 73.7 MB collector, dev 186.4 MB and 105.8 MB, unused 71.1 MB server (mdpdf for one platform only, canvas) and 8.8 MB collector, providers 76.9 MB server (vector database clients 74.8 MB, model provider SDKs 2.1 MB). The smoke test of that DMG passed (first run, search page, quit).

After every step: scripts/check-server-boot.sh passed, and scripts/check-packaged-backend.mjs passed against the packaged copy (release/linux-unpacked/resources): prisma migrate deploy, collector and server healthy, upload and parse of a PDF, a DOCX, an XLSX and a Markdown file, OCR of a PNG, embedding of the five documents into a workspace with all-minilm, one chat answer with sources from qwen3:0.6b. After step 4, `npm run test:integration` passed (5 tests) on the same pruned tree; after step 5, on the tree rebased onto Session H, it passed again (7 tests in 5 files).

### 1. Other platforms

prune.mjs reads the first 20 bytes of every file. For darwin-arm64 it removes ELF and PE files and thin Mach-O libraries and bundles that are not arm64; an x86_64 Mach-O executable stays, since Rosetta can run it. Fat Mach-O files stay. For linux-x64 it removes Mach-O, PE and non x86-64 ELF. On the mac this covers onnxruntime-node for five platforms (until now an electron-builder filter, removed), the bare-fs, bare-os and bare-url prebuilds and the Prisma engines that step 5 already removes. iOS arm64 prebuilds of bare-* (about 0.1 MB each) cannot be told from macOS arm64 by the header and stay.

### 2. Duplicates

Yarn classic has no dedupe command, and the upstream lock files may not change. The only removal that keeps every require resolving to the same code is a nested copy whose nearest ancestor copy has the same name and version; there are none, yarn already hoists those. The remaining identical copies sit under different parents (server: 78 name and version pairs, 19.5 MB; collector: 18 pairs, 11.5 MB), mostly @types/node, which step 3 removes. Merging the rest would change which copy other packages resolve. Not done.

### 3. Development files

Removed: `*.js.map` and other source maps, `*.d.ts` typings, every @types package without JavaScript, README, CHANGELOG and HISTORY files, and the folders test, tests, `__tests__`, example, examples, docs, doc, .github, coverage, benchmark and benchmarks directly under a package root unless main, module, browser, bin or exports point into them. Folders of the same name deeper down stay (yaml/dist/doc is code). LICENSE and NOTICE files stay, and so does the readme of a package without a license file, because it may be the only license notice (docs/licenses.md). Source maps only change stack traces in logs, which then point at the shipped JavaScript.

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

### 5. Vector database clients and model provider SDKs AskFiles never selects

The presets set VECTOR_DB=lancedb, LLM_PROVIDER=ollama and EMBEDDING_ENGINE=ollama. On top of the step 4 guards, prune.mjs parses every upstream source file (acorn, a new dev dependency), follows the requires that run at module scope from server/index.js and collector/index.js, and refuses to remove any package that one of those files loads at module scope. The document, embedding and chat routes are all registered at start, so their module-scope requires are inside that set; what their handlers load later is covered by check-packaged-backend.mjs and the integration tests, which exercise those paths on the pruned tree.

Removed (server only; the collector requires none of them):

| Group | Packages | Linux install |
| --- | --- | --- |
| Vector database clients and what only they pull in | chromadb (with chromadb-default-embed), @pinecone-database/pinecone, pinecone-client, @qdrant/js-client-rest, @zilliz/milvus2-sdk-node (Milvus and Zilliz), weaviate-client, @datastax/astra-db-ts; with them @grpc/grpc-js, protobufjs, nice-grpc and others | 74.8 MB |
| Model provider SDKs that only chromadb pulls in | voyageai, @google/generative-ai, chromadb's own copies of openai and ollama | 2.1 MB |

Each client is required at module scope only in its file under server/utils/vectorDbProviders/, and upstream loads that file only inside the VECTOR_DB switch (utils/helpers/index.js, getVectorDbClass). @langchain/community's own chroma, astradb, milvus and qdrant integrations are separate entry points that nothing imports; they are the one exception the step accepts, read by hand.

Checked and kept, because the step refuses them:

| Package | Why it stays |
| --- | --- |
| pg | utils/vectorDbProviders/pgvector/index.js requires it at module scope and is loaded at server start |
| openai, @anthropic-ai/sdk, @langchain/openai, @langchain/anthropic | the agent provider modules under utils/agents/aibitat/providers require them at module scope at server start; several chat providers too |
| elevenlabs | utils/TextToSpeech/elevenLabs/index.js, loaded at start |
| ollama | the provider AskFiles uses |
| cohere-ai | still a dependency of a package that stays |

## Not pruned

- onnxruntime-web (50 MB in each tree after step 3): @xenova/transformers imports it at load, also in Node.
- @lancedb/lancedb-darwin-arm64 (69.6 MB): the vector database.
- prisma and @prisma/engines (66 MB): `prisma migrate deploy` runs at every start.
- tesseract.js-core (29 MB): OCR.
- web-push (MPL-2.0): utils/PushNotifications/index.js requires it at module scope and loads at server start, so step 5's guard keeps it; its files are not modified.
- pdf-parse's three unused pdf.js builds (collector uses v1.10.100): files inside a package, not a package; left for now.

## CI time

Timestamps from the package job logs. Run 6 is main after Session F, run 8 this PR's measurement-only push, run 11 the push with pruning, the faster signing and the caches (the new caches still empty), run 12 the next push with both new caches hit.

| Package job part | main, run 6 | run 8 | run 11 | run 12 |
| --- | --- | --- | --- | --- |
| build.sh | 3 min 18 s | 1 min 10 s (yarn cache warm) | 2 min 5 s, of which 30 s pruning | 8 s (frontend and node_modules reused, pruning finds nothing) |
| electron-builder dir | 55 s | 34 s | 28 s | 29 s |
| sign-adhoc.sh | 15 min 34 s, of which 14 min 6 s running file(1) once per file | 12 min 14 s | 44 s (60 Mach-O files instead of 100) | 52 s |
| DMG | 3 min 0 s | 2 min 52 s | 2 min 40 s | 1 min 51 s |
| Build, package and sign step | 22 min 52 s | 16 min 54 s | 6 min 3 s | 2 min 40 s |
| whole job | 26 min 45 s | 19 min 20 s | 9 min 27 s | 4 min 15 s |

Run 15 (after the rebase and the provider step) took 7 min 22 s: prune.mjs and build.sh changed, so the node_modules cache missed by design and the installs ran (build.sh 58 s).

The yarn download cache (2 GB, about 1 min to restore) is now restored only when one of the two new caches misses; run 12 skipped it.

## Measurements

### Linux packaging before pruning

Packaged from the same commit with `bash scripts/build.sh` (no target, nothing pruned). The electron-builder onnxruntime filter is gone, which is why this is larger than main's 1.33 GB.

Measured 2026-10-29 at commit f0dee32 on Linux x86_64.
Packaged copy: release/linux-unpacked/resources

| Tree | Size | Files | Package directories |
| --- | --- | --- | --- |
| server/node_modules | 994.7 MB | 57617 | 1121 |
| collector/node_modules | 507.4 MB | 35001 | 611 |
| both | 1.47 GB | 92618 | 1732 |

#### 40 largest package directories

Own size: files of the package without its nested node_modules, which are listed separately.

| Size | Path |
| --- | --- |
| 91.9 MB | server/node_modules/onnxruntime-node |
| 91.9 MB | collector/node_modules/onnxruntime-node |
| 90.1 MB | server/node_modules/@lancedb/lancedb-linux-x64-musl |
| 86.8 MB | server/node_modules/@lancedb/lancedb-linux-x64-gnu |
| 65.0 MB | server/node_modules/onnxruntime-web |
| 65.0 MB | collector/node_modules/onnxruntime-web |
| 56.2 MB | server/node_modules/@mintplex-labs/mdpdf-linux-x64-musl |
| 56.2 MB | server/node_modules/@mintplex-labs/mdpdf-linux-x64-gnu |
| 44.5 MB | server/node_modules/@xenova/transformers |
| 44.5 MB | collector/node_modules/@xenova/transformers |
| 44.0 MB | server/node_modules/chromadb-default-embed |
| 37.4 MB | server/node_modules/@prisma/engines |
| 29.2 MB | collector/node_modules/tesseract.js-core |
| 28.0 MB | server/node_modules/prisma |
| 27.0 MB | collector/node_modules/pdf-parse |
| 23.4 MB | server/node_modules/canvas |
| 21.4 MB | collector/node_modules/js-tiktoken |
| 20.8 MB | server/node_modules/exceljs |
| 19.0 MB | server/node_modules/chromadb |
| 18.6 MB | server/node_modules/pdf-lib |
| 17.0 MB | server/node_modules/.prisma |
| 16.5 MB | server/node_modules/sharp |
| 16.5 MB | collector/node_modules/@xenova/transformers/node_modules/sharp |
| 15.8 MB | collector/node_modules/@img/sharp-libvips-linuxmusl-x64 |
| 15.5 MB | collector/node_modules/@img/sharp-libvips-linux-x64 |
| 10.0 MB | server/node_modules/swagger-ui-dist |
| 8.7 MB | collector/node_modules/youtubei.js |
| 8.6 MB | server/node_modules/web-streams-polyfill |
| 8.6 MB | collector/node_modules/@anthropic-ai/sdk/node_modules/web-streams-polyfill |
| 7.6 MB | collector/node_modules/xlsx |
| 7.4 MB | collector/node_modules/@mixmark-io/domino |
| 7.4 MB | server/node_modules/@js-joda/core |
| 6.3 MB | server/node_modules/js-tiktoken |
| 6.0 MB | collector/node_modules/officeparser |
| 5.9 MB | server/node_modules/chart.js |
| 5.7 MB | collector/node_modules/puppeteer-core |
| 5.5 MB | server/node_modules/@vscode/ripgrep |
| 5.2 MB | server/node_modules/@azure/msal-browser |
| 5.2 MB | server/node_modules/weaviate-client |
| 5.1 MB | server/node_modules/apache-arrow |

#### Packages installed at more than one path in the same tree

server/node_modules: 159 names; 82.7 MB beyond the largest copy of each. Largest 10:

| Package | Copies | Size of all copies |
| --- | --- | --- |
| @types/node | 13 | 25.3 MB |
| zod | 8 | 15.8 MB |
| protobufjs | 4 | 11.1 MB |
| web-streams-polyfill | 2 | 9.0 MB |
| openai | 3 | 8.2 MB |
| es-abstract | 3 | 7.6 MB |
| @grpc/grpc-js | 2 | 4.1 MB |
| lodash | 3 | 4.0 MB |
| graphql | 2 | 3.3 MB |
| acorn | 3 | 2.8 MB |

collector/node_modules: 69 names; 46.6 MB beyond the largest copy of each. Largest 10:

| Package | Copies | Size of all copies |
| --- | --- | --- |
| sharp | 2 | 16.9 MB |
| zod | 7 | 14.7 MB |
| openai | 3 | 11.7 MB |
| @types/node | 5 | 10.3 MB |
| web-streams-polyfill | 2 | 9.0 MB |
| @langchain/community | 2 | 8.8 MB |
| langchain | 2 | 7.2 MB |
| @langchain/core | 2 | 3.8 MB |
| lodash | 2 | 2.7 MB |
| acorn | 3 | 2.1 MB |

#### Development-only files still shipped

| Kind | Size |
| --- | --- |
| source maps | 183.6 MB |
| typings | 82.1 MB |
| test, example and doc folders | 16.6 MB |
| readme and changelog | 15.4 MB |

### Linux packaging after pruning

Measured 2026-10-29 at commit e21fce6 (uncommitted changes) on Linux x86_64.
Packaged copy: release/linux-unpacked/resources

| Tree | Size | Files | Package directories |
| --- | --- | --- | --- |
| server/node_modules | 528.1 MB | 32717 | 1016 |
| collector/node_modules | 314.1 MB | 19346 | 536 |
| both | 842.2 MB | 52063 | 1552 |

#### 40 largest package directories

Own size: files of the package without its nested node_modules, which are listed separately.

| Size | Path |
| --- | --- |
| 90.1 MB | server/node_modules/@lancedb/lancedb-linux-x64-musl |
| 86.8 MB | server/node_modules/@lancedb/lancedb-linux-x64-gnu |
| 50.1 MB | server/node_modules/onnxruntime-web |
| 50.1 MB | collector/node_modules/onnxruntime-web |
| 39.9 MB | server/node_modules/@xenova/transformers |
| 39.9 MB | collector/node_modules/@xenova/transformers |
| 37.4 MB | server/node_modules/@prisma/engines |
| 29.2 MB | collector/node_modules/tesseract.js-core |
| 27.8 MB | server/node_modules/prisma |
| 21.4 MB | collector/node_modules/js-tiktoken |
| 16.4 MB | server/node_modules/sharp |
| 16.4 MB | collector/node_modules/@xenova/transformers/node_modules/sharp |
| 15.8 MB | server/node_modules/onnxruntime-node |
| 15.8 MB | collector/node_modules/onnxruntime-node |
| 15.8 MB | collector/node_modules/@img/sharp-libvips-linuxmusl-x64 |
| 15.5 MB | collector/node_modules/@img/sharp-libvips-linux-x64 |
| 15.1 MB | server/node_modules/.prisma |
| 12.0 MB | collector/node_modules/pdf-parse |
| 7.6 MB | collector/node_modules/xlsx |
| 6.6 MB | server/node_modules/pdf-lib |
| 6.4 MB | server/node_modules/exceljs |
| 6.3 MB | server/node_modules/js-tiktoken |
| 5.5 MB | server/node_modules/@vscode/ripgrep |
| 4.4 MB | collector/node_modules/youtubei.js |
| 4.1 MB | collector/node_modules/@langchain/community |
| 3.9 MB | server/node_modules/swagger-ui-dist |
| 3.6 MB | server/node_modules/moment |
| 3.6 MB | collector/node_modules/moment |
| 3.5 MB | collector/node_modules/zlibjs |
| 3.3 MB | server/node_modules/@modelcontextprotocol/sdk/node_modules/zod |
| 3.3 MB | collector/node_modules/xml2js |
| 3.2 MB | server/node_modules/docx |
| 3.1 MB | server/node_modules/langchain |
| 3.1 MB | collector/node_modules/langchain |
| 3.0 MB | collector/node_modules/langchain/node_modules/@langchain/community |
| 3.0 MB | server/node_modules/jsdom |
| 3.0 MB | server/node_modules/@langchain/community |
| 2.9 MB | server/node_modules/@azure/msal-browser |
| 2.9 MB | collector/node_modules/zod |
| 2.7 MB | collector/node_modules/@langchain/community/node_modules/langchain |

#### Packages installed at more than one path in the same tree

server/node_modules: 138 names; 28.5 MB beyond the largest copy of each. Largest 10:

| Package | Copies | Size of all copies |
| --- | --- | --- |
| zod | 8 | 11.7 MB |
| es-abstract | 3 | 7.4 MB |
| lodash | 3 | 4.0 MB |
| openai | 2 | 3.0 MB |
| web-streams-polyfill | 2 | 3.0 MB |
| bluebird | 3 | 1.8 MB |
| async | 2 | 1.5 MB |
| iconv-lite | 4 | 1.2 MB |
| @anthropic-ai/sdk | 3 | 1.2 MB |
| acorn | 3 | 1.2 MB |

collector/node_modules: 61 names; 26.5 MB beyond the largest copy of each. Largest 10:

| Package | Copies | Size of all copies |
| --- | --- | --- |
| sharp | 2 | 16.8 MB |
| zod | 7 | 10.8 MB |
| @langchain/community | 2 | 7.1 MB |
| openai | 3 | 5.8 MB |
| langchain | 2 | 5.8 MB |
| @langchain/core | 2 | 3.1 MB |
| web-streams-polyfill | 2 | 3.0 MB |
| lodash | 2 | 2.7 MB |
| bluebird | 3 | 1.8 MB |
| iconv-lite | 4 | 1.3 MB |

#### Development-only files still shipped

| Kind | Size |
| --- | --- |
| test, example and doc folders | 3.7 MB |
| source maps | 2.0 MB |
| readme and changelog | 314 KB |

### mac CI, before (run 8)

Measured 2026-10-29 at commit 702fc4d on Darwin arm64.
Packaged copy: release/mac-arm64/AskFiles.app/Contents/Resources

| Tree | Size | Files | Package directories |
| --- | --- | --- | --- |
| server/node_modules | 756.6 MB | 58255 | 1119 |
| collector/node_modules | 425.7 MB | 35629 | 609 |
| both | 1.15 GB | 93884 | 1728 |

#### 40 largest package directories

Own size: files of the package without its nested node_modules, which are listed separately.

| Size | Path |
| --- | --- |
| 69.6 MB | server/node_modules/@lancedb/lancedb-darwin-arm64 |
| 65.0 MB | server/node_modules/onnxruntime-web |
| 65.0 MB | collector/node_modules/onnxruntime-web |
| 51.5 MB | server/node_modules/@mintplex-labs/mdpdf-darwin-arm64 |
| 44.5 MB | server/node_modules/@xenova/transformers |
| 44.5 MB | collector/node_modules/@xenova/transformers |
| 44.0 MB | server/node_modules/chromadb-default-embed |
| 38.3 MB | server/node_modules/@prisma/engines |
| 29.2 MB | collector/node_modules/tesseract.js-core |
| 28.1 MB | server/node_modules/prisma |
| 27.0 MB | collector/node_modules/pdf-parse |
| 22.7 MB | server/node_modules/sharp |
| 22.7 MB | collector/node_modules/@xenova/transformers/node_modules/sharp |
| 21.4 MB | collector/node_modules/js-tiktoken |
| 20.8 MB | server/node_modules/exceljs |
| 20.4 MB | server/node_modules/onnxruntime-node |
| 20.4 MB | collector/node_modules/onnxruntime-node |
| 19.0 MB | server/node_modules/chromadb |
| 18.7 MB | server/node_modules/canvas |
| 18.6 MB | server/node_modules/pdf-lib |
| 17.2 MB | server/node_modules/.prisma |
| 14.9 MB | collector/node_modules/@img/sharp-libvips-darwin-arm64 |
| 10.0 MB | server/node_modules/swagger-ui-dist |
| 8.7 MB | collector/node_modules/youtubei.js |
| 8.6 MB | server/node_modules/web-streams-polyfill |
| 8.6 MB | collector/node_modules/@anthropic-ai/sdk/node_modules/web-streams-polyfill |
| 7.6 MB | collector/node_modules/xlsx |
| 7.4 MB | collector/node_modules/@mixmark-io/domino |
| 7.4 MB | server/node_modules/@js-joda/core |
| 6.3 MB | server/node_modules/js-tiktoken |
| 6.0 MB | collector/node_modules/officeparser |
| 5.9 MB | server/node_modules/chart.js |
| 5.7 MB | collector/node_modules/puppeteer-core |
| 5.2 MB | server/node_modules/@azure/msal-browser |
| 5.2 MB | server/node_modules/weaviate-client |
| 5.1 MB | server/node_modules/apache-arrow |
| 5.0 MB | collector/node_modules/@langchain/community |
| 4.4 MB | server/node_modules/@vscode/ripgrep |
| 4.1 MB | server/node_modules/moment |
| 4.1 MB | collector/node_modules/moment |

#### Packages installed at more than one path in the same tree

server/node_modules: 159 names; 82.7 MB beyond the largest copy of each. Largest 10:

| Package | Copies | Size of all copies |
| --- | --- | --- |
| @types/node | 13 | 25.3 MB |
| zod | 8 | 15.8 MB |
| protobufjs | 4 | 11.1 MB |
| web-streams-polyfill | 2 | 9.0 MB |
| openai | 3 | 8.2 MB |
| es-abstract | 3 | 7.6 MB |
| @grpc/grpc-js | 2 | 4.1 MB |
| lodash | 3 | 4.0 MB |
| graphql | 2 | 3.3 MB |
| acorn | 3 | 2.8 MB |

collector/node_modules: 69 names; 46.6 MB beyond the largest copy of each. Largest 10:

| Package | Copies | Size of all copies |
| --- | --- | --- |
| sharp | 2 | 23.2 MB |
| zod | 7 | 14.7 MB |
| openai | 3 | 11.7 MB |
| @types/node | 5 | 10.3 MB |
| web-streams-polyfill | 2 | 9.0 MB |
| @langchain/community | 2 | 8.8 MB |
| langchain | 2 | 7.2 MB |
| @langchain/core | 2 | 3.8 MB |
| lodash | 2 | 2.7 MB |
| acorn | 3 | 2.1 MB |

#### Development-only files still shipped

| Kind | Size |
| --- | --- |
| source maps | 183.6 MB |
| typings | 82.1 MB |
| test, example and doc folders | 16.6 MB |
| readme and changelog | 15.4 MB |

### mac CI, after (run 15)

Measured 2026-10-29 at commit 7c17e28 on Darwin arm64.
Packaged copy: release/mac-arm64/AskFiles.app/Contents/Resources

| Tree | Size | Files | Package directories |
| --- | --- | --- | --- |
| server/node_modules | 431.8 MB | 33364 | 1015 |
| collector/node_modules | 308.9 MB | 19990 | 534 |
| both | 740.6 MB | 53354 | 1549 |

#### 40 largest package directories

Own size: files of the package without its nested node_modules, which are listed separately.

| Size | Path |
| --- | --- |
| 69.6 MB | server/node_modules/@lancedb/lancedb-darwin-arm64 |
| 50.1 MB | server/node_modules/onnxruntime-web |
| 50.1 MB | collector/node_modules/onnxruntime-web |
| 39.9 MB | server/node_modules/@xenova/transformers |
| 39.9 MB | collector/node_modules/@xenova/transformers |
| 38.3 MB | server/node_modules/@prisma/engines |
| 29.2 MB | collector/node_modules/tesseract.js-core |
| 28.0 MB | server/node_modules/prisma |
| 22.6 MB | server/node_modules/sharp |
| 22.6 MB | collector/node_modules/@xenova/transformers/node_modules/sharp |
| 21.4 MB | collector/node_modules/js-tiktoken |
| 20.4 MB | server/node_modules/onnxruntime-node |
| 20.4 MB | collector/node_modules/onnxruntime-node |
| 15.2 MB | server/node_modules/.prisma |
| 14.9 MB | collector/node_modules/@img/sharp-libvips-darwin-arm64 |
| 12.0 MB | collector/node_modules/pdf-parse |
| 7.6 MB | collector/node_modules/xlsx |
| 6.6 MB | server/node_modules/pdf-lib |
| 6.4 MB | server/node_modules/exceljs |
| 6.3 MB | server/node_modules/js-tiktoken |
| 4.4 MB | collector/node_modules/youtubei.js |
| 4.4 MB | server/node_modules/@vscode/ripgrep |
| 4.1 MB | collector/node_modules/@langchain/community |
| 3.9 MB | server/node_modules/swagger-ui-dist |
| 3.6 MB | server/node_modules/moment |
| 3.6 MB | collector/node_modules/moment |
| 3.5 MB | collector/node_modules/zlibjs |
| 3.3 MB | server/node_modules/@modelcontextprotocol/sdk/node_modules/zod |
| 3.3 MB | collector/node_modules/xml2js |
| 3.2 MB | server/node_modules/docx |
| 3.1 MB | server/node_modules/langchain |
| 3.1 MB | collector/node_modules/langchain |
| 3.0 MB | collector/node_modules/langchain/node_modules/@langchain/community |
| 3.0 MB | server/node_modules/jsdom |
| 3.0 MB | server/node_modules/@langchain/community |
| 2.9 MB | server/node_modules/@azure/msal-browser |
| 2.9 MB | collector/node_modules/zod |
| 2.7 MB | collector/node_modules/@langchain/community/node_modules/langchain |
| 2.6 MB | server/node_modules/array.prototype.findindex/node_modules/es-abstract |
| 2.6 MB | server/node_modules/reflect.getprototypeof/node_modules/es-abstract |

#### Packages installed at more than one path in the same tree

server/node_modules: 138 names; 28.5 MB beyond the largest copy of each. Largest 10:

| Package | Copies | Size of all copies |
| --- | --- | --- |
| zod | 8 | 11.7 MB |
| es-abstract | 3 | 7.4 MB |
| lodash | 3 | 4.0 MB |
| openai | 2 | 3.0 MB |
| web-streams-polyfill | 2 | 3.0 MB |
| bluebird | 3 | 1.8 MB |
| async | 2 | 1.5 MB |
| iconv-lite | 4 | 1.2 MB |
| @anthropic-ai/sdk | 3 | 1.2 MB |
| acorn | 3 | 1.2 MB |

collector/node_modules: 61 names; 26.5 MB beyond the largest copy of each. Largest 10:

| Package | Copies | Size of all copies |
| --- | --- | --- |
| sharp | 2 | 23.0 MB |
| zod | 7 | 10.8 MB |
| @langchain/community | 2 | 7.1 MB |
| openai | 3 | 5.8 MB |
| langchain | 2 | 5.8 MB |
| @langchain/core | 2 | 3.1 MB |
| web-streams-polyfill | 2 | 3.0 MB |
| lodash | 2 | 2.7 MB |
| bluebird | 3 | 1.8 MB |
| iconv-lite | 4 | 1.3 MB |

#### Development-only files still shipped

| Kind | Size |
| --- | --- |
| test, example and doc folders | 3.7 MB |
| source maps | 2.0 MB |
| readme and changelog | 309 KB |
