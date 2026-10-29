# askfiles

AskFiles is a macOS desktop app for people with no technical background: point it at a folder of documents, ask a question, get an answer with the source file, section and page. A browse view (a committed phase, phase 4 in docs/plan.md) lets the user read documents by outline and section without asking anything; it renders the documents and uses no model. Everything runs on the machine. AnythingLLM (the open-source core) is the headless backend. This repository holds the Electron shell, the preset configuration, our own search and browse interface, and the evaluation harness. Bundle id io.askfiles.desktop; data in ~/Library/Application Support/AskFiles.

Read docs/plan.md before starting any task. It records the decisions, the phases, the open questions and the acceptance criteria. Session briefs are in docs/sessions/. If a brief and the plan disagree, the plan wins; say so in the PR.

## Repository layout

- upstream/            AnythingLLM core, vendored with git subtree at the tag in UPSTREAM_VERSION. Read only.
  - upstream/server, upstream/collector, upstream/frontend: three separate yarn packages, each with its own yarn.lock. Prisma schema and migrations at upstream/server/prisma (schema.prisma).
  - upstream/browser-extension and upstream/embed are empty placeholders for upstream submodules (declared in upstream/.gitmodules) that we do not use. Never try to initialize them.
- patches/             Minimal unified diffs applied to upstream at build time. Each patch starts with a comment that says why it exists.
- src/main/            Electron main process in TypeScript: process manager, first-run wizard, folder watcher, model manager.
- src/renderer/        Our pages in plain HTML, CSS and JavaScript: onboarding, search, models, and browse in phase 4. No framework.
- config/presets.json  Preset configuration per RAM tier. Values come from measured results in phase 2, not guesses.
- scripts/             build.sh, vendor-upstream.sh, install_pkgs.sh, sign-adhoc.sh, eval harness.
- docs/                plan.md, upstream-analysis.md, packaging.md, session briefs.
- cloud-env/           Reference copy of the cloud environment setup script and settings. Not executed from the repo.
- test/                Unit tests beside the code under test; integration tests under test/integration.

## Rules

1. Never edit files under upstream/. A change to upstream goes into patches/ as a unified diff that scripts/build.sh applies. If a task seems to need an upstream change, write the patch, keep it minimal, and explain it in the PR.
2. Keep the product promise: documents and questions never leave the machine. Server and collector bind to 127.0.0.1. Telemetry off. No cloud provider calls from the shell.
3. Small, tested changes. Every session brief names its tests. A PR without green tests is not done.
4. Phase 1 targets macOS arm64. Still write Node code platform-agnostic where it is cheap: inject binary paths, signal names and data directories, because CI and cloud sessions run on Linux x86_64.
5. Do not attempt macOS packaging, code signing or any GUI run in a cloud session. Those steps are marked LOCAL in the plan. Stop, document what is ready, and say what has to happen on the Mac.
6. Do not commit secrets, model files or build outputs. .gitignore covers them; extend it rather than force-adding.
7. Do not add a dependency without a one-line reason in the PR. Prefer Node built-ins.
8. Ask before changing a decision listed in docs/plan.md. Anything else: decide, note the decision in the PR.
9. Retrieval splits documents by section, not by fixed length; see docs/plan.md.

## Working in a session

- Branch name: session/<letter>-<short-slug>, for example session/c-process-manager.
- Commit early with plain messages. Open a PR against main when the brief's acceptance criteria pass.
- PR title: [Session X] what was built. PR body: what was done, how it was tested, what is left, open questions for the owner.
- If a brief references docs/upstream-analysis.md and the file does not exist yet, say so and work from upstream/ directly; note any assumption you had to make.
- When something cannot be verified in this environment, write it down as unverified. Never report a step as working without having run it.

## Commands

Some of these are created by Session B. Until then, the upstream commands still apply.

- npm install                      shell dependencies (root package.json)
- npm test                         unit tests with vitest
- npm run test:integration         integration tests; needs RUN_INTEGRATION=1 and a reachable Ollama
- npm run lint                     eslint and prettier check
- npm run build:upstream           scripts/build.sh: apply patches, build upstream frontend into upstream/server/public, install server and collector, prisma generate
- npm run eval -- <corpus> <questions.csv>   evaluation harness from Session G
- Upstream only: cd upstream/server && yarn install && npx prisma generate. Same with yarn for upstream/collector and upstream/frontend.

Node 22. The shell uses npm. Upstream uses yarn classic and its own lock files.

Upstream targets Node 18 (upstream/.nvmrc, upstream/docker/Dockerfile); Node 22 is assumed to work until Session A says otherwise.

## Style

- TypeScript with strict mode in src/main. Plain JavaScript in src/renderer.
- Tests with vitest. Integration tests are skipped unless RUN_INTEGRATION=1, with a printed reason.
- Plain ASCII punctuation in docs, comments and commit messages.
- Comments explain why, not what.
- Logs are one line per event with a stable prefix, for example [process-manager] server healthy on 51342.

## Environment facts for cloud sessions

- Fresh Ubuntu 24.04 x86_64 VM, about 4 vCPU, 16 GB RAM, 30 GB disk. Node 22 on PATH. No GUI, no shell for the owner; you run every command.
- CLAUDE_CODE_REMOTE is true in cloud sessions. scripts/install_pkgs.sh installs dependencies only there and skips directories that have not changed.
- The environment setup script may have installed Ollama with two small test models: qwen3:0.6b for chat and all-minilm for embeddings. Check with ollama list. If Ollama is absent, skip integration tests with a clear message. Never fake a result.
- Outbound network is allowlisted. If a download is refused, report the exact host in the PR so it can be added to the environment, and continue with what you can.
- Foreground commands time out after 10 minutes at most. Run long installs or test suites in the background and poll.
