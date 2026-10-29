# The app: windows, first run, bridge and watcher

Written by Session H (plan tasks 3.4 and 3.5). Code in src/main; pages in src/renderer.

## Start sequence

1. src/main/index.ts registers the askfiles scheme, opens the window on a starting page and, in the packaged app, hands over to AppController (src/main/app.ts).
2. AppController loads the preset for this Mac's RAM from config/presets.json (or ASKFILES_PRESETS_FILE), seeds the OCR language data (below), then starts Ollama, collector and server through the process manager with `askfiles://app` as an allowed origin (patch 005).
3. It reads `<dataDir>/shell.json`. Without the completed-setup marker the window shows the onboarding page and the first run starts; with it the window shows the search page and the folder watcher starts.

`<dataDir>` is ~/Library/Application Support/AskFiles.

## Pages

The window loads our pages from the app bundle, never from the server: `askfiles://app/<page>/index.html` maps to src/renderer/<page>/index.html inside app.asar (src/main/app-protocol.ts). A custom scheme rather than file://, because Chromium refuses ES modules from file:// URLs, and a standard secure scheme gives every page the one origin `askfiles://app`, which the server allows and which keeps the recent questions in localStorage. Pages: onboarding, search, models (menu AskFiles > Models, once set up), about (menu AskFiles > About AskFiles). `askfiles://app/THIRD-PARTY-NOTICES` serves the notices file from the app root for the About page.

The window title stays AskFiles whatever a page sets. Navigation is limited to `askfiles://app`, and to the server's origin only behind the developer switch.

## Developer switch to the upstream interface

`ASKFILES_UPSTREAM_UI=1` opens the upstream web interface the server serves instead of our pages. Environment variable only; there is no keyboard shortcut. On the Mac:

```
ASKFILES_UPSTREAM_UI=1 /Applications/AskFiles.app/Contents/MacOS/AskFiles
```

With ASKFILES_PORT (or the config file) the app connects to a server started by hand instead of its own: the search page by default, the upstream interface with ASKFILES_UPSTREAM_UI=1. That server must allow the page origin: start it with ANYTHING_LLM_ALLOWED_ORIGINS=askfiles://app.

## First run

src/main/first-run.ts, a state machine around the Session E wizard:

```
idle -> models (the wizard: RAM, tier, pull, .env, server restart, onboarding flag)
     -> chooseFolder (native dialog, or ASKFILES_LIBRARY_FOLDER, or the folder already stored)
     -> createLibrary (API key, library workspace with the preset's settings)
     -> indexing (watcher started, waits until the folder is indexed; unreadable files end on the dead-letter list and do not block)
     -> done
any step --throws--> error --retry()--> the step that failed
```

Marked complete by `setupCompletedAt` in `<dataDir>/shell.json`, written only when the run reaches done. A first run cut off by a quit starts again at the next launch; every step is safe to repeat (installed models are skipped, the stored folder is reused if it still exists, the stored key is kept if the server accepts it, the library workspace is found by name and gets the preset settings again, the watcher reconciles against index.json).

## Where the API key lives

`<dataDir>/shell.json`, mode 0600, next to the folder and the workspace slug:

```json
{ "version": 1, "folder": "/Users/anna/Documents", "workspaceSlug": "askfiles-library", "apiKey": "...", "setupCompletedAt": "2026-10-29T10:00:00.000Z" }
```

The key is a developer API key of the local server, created with POST /api/system/generate-api-key during the first run. The main process uses it for the watcher, and the search page gets it through the bridge.

## Bridge

One preload script, src/main/preload.ts, for every window. Windows run with contextIsolation, sandbox and nodeIntegration off; the preload loads nothing but electron and compiles to a plain script (tsconfig moduleDetection legacy). Types and channel names: src/main/bridge/contract.ts; main side: src/main/bridge/register.ts and AppController. Every on* function returns an unsubscribe function; errors reach the page as their plain message.

| Page call | Main process |
| --- | --- |
| `askfiles.setup.onEvent(cb)` | First-run events: wizard `state`, `tier`, `progress`; `setup` (state, failedStep, error, folder); `indexing` (watcher status). A late subscriber gets a replay of the current state |
| `askfiles.setup.start()`, `.retry()` | FirstRun.start (joins a run in progress), FirstRun.retry |
| `askfiles.setup.chooseFolder()` | Native folder dialog; `{ folder }`, or null when cancelled |
| `askfiles.models.list()`, `.pull(tag)`, `.onProgress(cb)`, `.remove(tag)`, `.switchChat(tag)` | ModelManager (Session E); a switch restarts the backend and reloads the search page |
| `askfiles.watcher.status()`, `.onStatus(cb)` | Watcher status plus `folder`, and `error` when the folder cannot be watched |
| `askfiles.library.resolveSources(sources)` | FolderWatcher.resolveSources: section title and pages for vector-search results |
| `askfiles.library.openOriginal(source)` | Reveals the original file in Finder, mapped through index.json from the file URL, the stored document path or the upload file name (src/main/open-original.ts); false when no indexed file matches |
| `askfiles.app.info()` | `{ name, version }` for the About page |
| `askfiles.app.pageReady(info)` | Logs `[main] page ready search connected=true documents=N`; the smoke test waits for it |
| `window.shellConfig` | `{ baseUrl, apiKey, workspace, folder, resolveSources, openSource }`, read once per page load |

src/main/bridge/bridge.test.ts runs the preload in the same function wrapper the sandbox uses, wired to the real registerBridge, and fails when a page calls a function the bridge does not expose.

## Search page status bar

Folder, indexed file count, indexing state (Indexing, N left; Up to date; Folder not available) and the number of files on the dead-letter list, with their errors in the tooltip, all from watcher events through the bridge.

## OCR in the watcher

A PDF without a text layer is uploaded once to the collector without embedding, its text kept and the collector's copy deleted; the text is cached by file hash in `<dataDir>/ocr-cache`. The splitter then treats it as plain text, so its sections record page 0, stored as no page in index.json. The same path the eval harness takes (scripts/eval/library.ts). Languages: TARGET_OCR_LANG from the preset (eng,chi_sim), written into server/.env by the wizard.

The language data never downloads: @tesseract.js-data/eng and @tesseract.js-data/chi_sim (4.0.0_best_int) are runtime dependencies of the shell and ship in app.asar; at every launch src/main/tesseract.ts copies any missing language, unpacked, to `<dataDir>/storage/models/tesseract`, where the collector's tesseract.js looks first. Session B had not shipped these files, so Session H added the packages.

## Smoke test

scripts/smoke-mac.sh starts the packaged app on an emptied data directory (the model cache is kept) with ASKFILES_PRESETS_FILE=test/fixtures/presets-smoke.json (qwen3:0.6b, all-minilm, threshold 0) and ASKFILES_LIBRARY_FOLDER set to a temp folder holding test/fixtures/handbook.pdf and test/fixtures/scanned.pdf. It waits for the first run to finish, for the search page's ready line in main.log, then checks the library, the index and the OCR result and asks one question with the stored key.

## Third-party notices

THIRD-PARTY-NOTICES at the repository root lists every bundled package with its license and each license text once; the About page shows it. Regenerate after dependency changes, ideally on the Mac after scripts/build.sh so the darwin platform packages are listed:

```
node scripts/third-party-notices.mjs
```
