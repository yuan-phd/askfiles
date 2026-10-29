# Session H: wire the product flow into the app (plan tasks 3.4 and 3.5, plus watcher OCR)

Executor: CLOUD for all code and tests; the visual run and the second-Mac copy are LOCAL
Dependencies: Sessions A to G merged on main. The packaged app from the green mac workflow starts its backend and shows the upstream interface; nothing of our own is wired yet.
Branch: whatever the session assigns
PR title: [Session H] First run, search page and watcher wired into the app

## Goal

After this session the packaged app behaves like the product: first launch shows our onboarding page, downloads the models, asks for a folder, indexes it, and then shows our search page with cited answers. The upstream interface is reachable only through a hidden developer switch.

## What exists on main

- src/main/app.ts starts the process manager, writes ports.json and passes preset values in the server spawn environment (Session F).
- src/main/wizard, src/main/presets, src/main/models and the onboarding and models pages, all driven through a bridge object that is stubbed in tests (Session E).
- src/main/watcher with a Splitter interface wired to src/main/sections, index.json, and resolveSources for section titles (Sessions F and G).
- src/renderer/search with src/renderer/api/client.js, reading window.shellConfig (Session D).
- scripts/smoke-mac.sh and .github/workflows/mac.yml, green on main (Session F).

## Deliverables

1. Preload bridge: one preload script exposing a small, typed contextBridge API for the pages: wizard events and actions, model manager actions, folder picking through the native dialog, watcher status events, resolveSources, openOriginal (reveal the user's original file in Finder, mapped from the upstream upload path through index.json), and the shellConfig the search page expects (base URL, API key, workspace slug). Node integration stays off in the renderer.
2. First-run flow in app.ts: if the data directory has no completed-setup marker, open the onboarding page, run the wizard, ask for the folder, create the library workspace with the preset settings through the API, create an API key stored in the data directory, start the watcher, and show indexing progress; when the first reconcile finishes, switch to the search page. Later launches skip straight to the search page and start the watcher.
3. Search page as the window content: the window loads src/renderer/search from the app bundle (file protocol or a custom scheme, your choice, documented), not from the server. The upstream interface opens only when ASKFILES_UPSTREAM_UI=1 is set or through a hidden keyboard shortcut; document which.
4. Watcher OCR: a PDF with no text layer goes through the collector once, upload without embedding, to obtain text, then through the splitter with pages recorded as 0, the same path the eval harness uses. Pre-seed the eng and chi_sim tesseract data at first run from the shipped files (Session B ships them; confirm the location) so OCR never downloads. TARGET_OCR_LANG=eng,chi_sim comes from the preset.
5. Status surface: the search page status bar shows library folder, indexed count, indexing state and dead-letter count, from the watcher events through the bridge.
6. Smoke test update: the CI smoke job must exercise the new flow with the small test models. Add an environment variable or a test preset file that the smoke script passes so the wizard picks qwen3:0.6b and all-minilm and the folder is a temp directory containing test/fixtures/handbook.pdf. The smoke assertions then run against our search page through the bridge-free HTTP path, or against the server API as today, plus one check that the search page loaded (window title or a marker file). Keep the workflow green.
7. Tests: unit tests for the bridge surface (contract test that every function the pages call exists), the first-run state machine, the upload path mapping, and the OCR path with a fixture scanned PDF (create one from an image in the container). Playwright tests for the search page keep passing with the bridge stub.

## Rules for this session

- Do not edit upstream/. New upstream behaviour goes through patches/ with a reason.
- No new runtime dependencies without a one-line reason in the PR.
- Everything that needs a real Mac (native dialog, Finder reveal, the window itself) is written and unit tested with stubs here and listed under Not verified in the PR for the owner to run.
- Watch the PR after opening it: read each failed mac run, fix, push, until it is green or something needs the Mac.

## Acceptance

- npm test, npm run lint and the Playwright tests green in this container.
- The mac workflow on the PR is green with the smoke job going through the wizard and the search page.
- PR body lists: the bridge API, how the first run is marked complete, where the API key lives, how to reach the upstream interface, and everything not verified.

## Added: no upstream branding anywhere the user can see

That covers the window title, dock and app name, menus, the About dialog, onboarding, the search page, error pages, notifications, log file names shown to users, and the DMG volume name. Our own code and comments under src/, scripts/ and config/ refer to the backend as upstream, never by its product name. upstream/ itself and docs/ stay as they are, and the MIT copyright and license notices in upstream/ are never removed. Add an About page and a THIRD-PARTY-NOTICES file in the app listing the upstream project, Ollama and every bundled dependency with its license. The hidden developer switch to the upstream interface stays environment-variable only, no keyboard shortcut.

Acceptance: a test greps the packaged renderer files, src/ and the window title for the upstream product name and fails on any match outside upstream/, THIRD-PARTY-NOTICES and the About page.
