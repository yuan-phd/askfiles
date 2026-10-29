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
- Do not edit upstream/. The bind address change goes into patches/ as described under Design constraints.

## Acceptance

- npm test green. RUN_INTEGRATION=1 npm run test:integration green in this container, or skipped with the exact reason printed.
- The manager has no reference to process.platform.
- The bind patch applies cleanly with git apply --check against the vendored tag, and the integration test shows both server and collector listening on 127.0.0.1 only.
- PR opened with the integration test output pasted in the body.
