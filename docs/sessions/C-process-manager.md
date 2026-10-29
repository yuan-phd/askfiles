# Session C: process manager (plan task 1.3)

Executor: CLOUD
Dependencies: none for the code; the integration test needs the upstream packages installed (scripts/install_pkgs.sh does this) and Ollama reachable (environment setup script)
Branch: session/c-process-manager
PR title: [Session C] Process manager with health checks and integration test

## Goal

Implement src/main/process-manager, the component that starts, watches and stops Ollama, the collector and the server, platform-agnostic so it runs with Linux binaries here and macOS binaries in the packaged app.

## Design constraints

- Everything that differs by platform is injected: binary paths, working directories, data directory, log directory, signal names. No process.platform branches inside the manager; the caller builds a config object.
- The manager exposes: start(), stop(), status(), and an event emitter for state changes (starting, healthy, crashed, restarting, stopped) with timestamps.
- Bind address: upstream server (upstream/server/utils/boot/index.js, both the HTTP and HTTPS paths) and collector (upstream/collector/index.js) call listen(port) without a host and read no environment variable for the bind address, so they listen on all interfaces. The 127.0.0.1 patch is expected work in this session, not a fallback: one patch file in patches/ that adds a host argument to every one of those listen calls, read from an environment variable with default 127.0.0.1. The patch starts with a comment explaining why. The manager sets that variable for both processes.
- Further upstream patches, also owned by this session (found by Session A; evidence and line references in docs/upstream-analysis.md, Q2, Q4b, Collector and Risks found). In production upstream writes into its own code directories, which are read-only inside the signed app, and it accepts requests from any web origin. One patch file each in patches/, each starting with a comment explaining why; Session B only applies them in scripts/build.sh:
  1. Bind host: described above.
  2. Database path: upstream/server/prisma/schema.prisma line 15 hard-codes file:../storage/anythingllm.db. Change it to env("DATABASE_URL") (tested by Session A). The manager passes DATABASE_URL=file:<dataDir>/storage/anythingllm.db to both prisma migrate deploy and the server.
  3. Upload folder: the server writes uploads to path.resolve(STORAGE_DIR, "../../collector/hotdir") (upstream/server/utils/files/index.js and upstream/server/utils/files/multer.js, two sites), and the collector reads and wipes its own upstream/collector/hotdir and upstream/collector/storage/tmp (upstream/collector/utils/constants.js, upstream/collector/utils/files/index.js). Read both locations from environment variables set by the manager, under the data directory; keep the upstream paths as defaults.
  4. Server .env path: dumpENV rewrites upstream/server/.env next to the code (upstream/server/utils/helpers/updateENV.js, envPath). Read the path from an environment variable pointing at <dataDir>/server/.env; the server must load the same file at start.
  5. Cross-origin requests: cors({ origin: true }) in upstream/server/index.js and upstream/collector/index.js reflects any origin, and with no AUTH_TOKEN every /api/system route is open, so any web page can read API keys from the local server (verified by Session A). Allow only the shell's own origin, from an environment variable; requests without an Origin header (the shell's main process, curl) keep working.
  6. Outbound requests at server start: models.dev (upstream/server/utils/helpers/modelPricing/index.js) and raw.githubusercontent.com (upstream/server/utils/AiProviders/modelMap/index.js) are fetched on every boot when their cache is older than 3 days, with no setting to turn them off. Disable both by patch, because the plan promises that no request leaves the machine.
- Ports: allocate three free ports on 127.0.0.1 at start; never hardcode 3001, 8888 or 11434. Pass them to the processes through environment variables.
- First run: if <dataDir>/server/.env is missing, write it from a template with fresh random JWT_SECRET, SIG_KEY and SIG_SALT (32 bytes, base64) plus the port values. Existing files are never overwritten.
- Startup order with health checks and per-step timeouts: Ollama (GET /api/tags), collector (its health or root route; find it in upstream/collector), prisma migrate deploy, server (GET /api/ping). A step that fails its timeout aborts start() with the step name and the last 50 log lines.
- Shutdown: SIGTERM to each child, wait up to 5 seconds, then SIGKILL. Children must not outlive the parent: handle parent exit, SIGINT and SIGTERM.
- Crash handling: restart a crashed child with exponential backoff (1, 2, 4, 8, 16 seconds), capped at 5 attempts in 10 minutes, then emit a terminal failure.
- Logs: one file per process in the log directory, rotated at 5 MB, plus a manager log. Lines carry an ISO timestamp.

## Deliverables

1. src/main/process-manager/ with the manager, the port allocator, the env writer, the health checker, and a small typed config.
2. Unit tests with fake child processes (a tiny Node script that behaves as instructed through arguments: healthy after N ms, crash after N ms, ignore SIGTERM). Cover: ordering, health timeout, backoff cap, SIGKILL after SIGTERM is ignored, .env written once, ports differ and are free.
3. test/integration/process-manager.test.ts: builds a config with the Linux Ollama binary from PATH, upstream/collector and upstream/server from this repo, starts the manager, asserts 200 from /api/ping, asserts the server bound only to 127.0.0.1 (check with ss -ltnp), stops, and asserts no child is left. Skipped with a printed reason when Ollama is missing or RUN_INTEGRATION is not 1.
4. A short docs/process-manager.md: state diagram in text, config fields, how the packaged app will build the config on macOS.

## Do not

- Do not implement the wizard, model download or the window logic.
- Do not edit upstream/. Every upstream change goes into patches/ as described under Design constraints.

## Acceptance

- npm test green. RUN_INTEGRATION=1 npm run test:integration green in this container, or skipped with the exact reason printed.
- The manager has no reference to process.platform.
- Every patch applies cleanly with git apply --check against the vendored tag, and the integration test shows both server and collector listening on 127.0.0.1 only, the database and uploads under the data directory, a foreign Origin refused, and no request to models.dev or raw.githubusercontent.com in the server log.
- PR opened with the integration test output pasted in the body.
