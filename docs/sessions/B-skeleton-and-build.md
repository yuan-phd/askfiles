# Session B: repository skeleton and build script (plan task 1.2)

Executor: CLOUD, then LOCAL for the first real package
Dependencies: none (works from upstream/ directly; read docs/upstream-analysis.md if it exists)
Branch: session/b-skeleton-build
PR title: [Session B] Electron skeleton and upstream build script

## Goal

Create the shell project around the vendored upstream so that one command prepares everything up to the packaging step on Linux, and the packaging step itself is documented for the Mac.

## Deliverables

1. Root package.json with scripts: test, test:integration, lint, build:upstream, package:mac. Dev dependencies: typescript, vitest, eslint, prettier, electron, electron-builder. No runtime dependencies yet beyond what the main process needs.
2. tsconfig.json for src/main with strict mode, output to dist/main.
3. src/main/index.ts: minimal Electron entry that reads a port from an environment variable or a config file, opens one BrowserWindow at http://127.0.0.1:<port>, and logs to a configurable directory. No process management yet (Session C).
4. scripts/build.sh, idempotent, with these steps in order:
   - export PUPPETEER_SKIP_DOWNLOAD=1 before any yarn install, so puppeteer (a dependency of upstream/collector) does not download Chromium; the product does not use web scraping
   - apply every patch in patches/ to upstream/ with git apply --check first, then git apply; stop with a clear message on failure
   - build upstream/frontend with yarn and copy dist into upstream/server/public with the VITE_API_BASE value from docs/upstream-analysis.md Q11 (or the upstream Dockerfile if the report is absent)
   - yarn install for upstream/server and upstream/collector with production flags, then prisma generate for the server
   - remove Prisma engines for every platform except darwin-arm64 when PACKAGE_TARGET=mac-arm64 is set; keep all engines otherwise so the result still runs on Linux
   - prune dev dependencies
   - print a summary of what was produced and the size of upstream/server/node_modules and upstream/collector/node_modules
5. electron-builder.yml targeting mac arm64, dmg, with: productName AskFiles, appId io.askfiles.desktop (package.json name askfiles), asarUnpack entries for native modules and Prisma engines (take the list from Q1 and Q2, or leave a clearly marked placeholder list), extraResources for resources/ollama (not committed), identity: null so no certificate is required.
6. scripts/sign-adhoc.sh: runs codesign --force --deep --sign - on the built app and verifies with codesign --verify --deep --strict. Mac only; exits with a message elsewhere.
7. docs/packaging.md: the exact steps to run on the Mac after this PR: download the Ollama macOS binary into resources/, npm run package:mac, sign-adhoc, copy to a second Mac by USB, what to expect from Gatekeeper.
8. Makefile with targets build, test, lint, clean that call the npm scripts.

## Tests

- Unit tests for any helper in build logic that is more than a shell one-liner (patch listing, engine pruning). If build.sh stays pure shell, add a bats-style or shell test that runs it against a tiny fixture tree.
- npm test green.
- make build completes in this container and leaves upstream/server/public populated. Record the elapsed time and the node_modules sizes in the PR.

## Do not

- Do not run electron, electron-builder package, or codesign here. Stop at the packaging step and document it.
- Do not edit upstream/. Patches only.
- Do not commit upstream/server/public, dist/, or node_modules.

## Acceptance

- make build and npm test both green in this container.
- docs/packaging.md lets the owner produce a DMG on the Mac without asking questions.
- PR opened with elapsed time, sizes, and any asarUnpack placeholders called out.
