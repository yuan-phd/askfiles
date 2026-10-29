# Process manager

src/main/process-manager starts, watches and stops the three local processes: Ollama, the AnythingLLM collector and the AnythingLLM server. It contains no platform branches; the caller builds a config object with every path, signal and directory.

## Startup and shutdown

start() runs these steps in order and stops at the first failure:

1. Allocate three free ports on the host (default 127.0.0.1), one each for Ollama, collector and server. Ports are new at every start.
2. Write <dataDir>/server/.env if it does not exist: fresh JWT_SECRET, SIG_KEY and SIG_SALT (32 random bytes, base64), the ports of this first run, DISABLE_TELEMETRY. The manager never touches an existing file; the first-run wizard and the model manager (Session E) add the preset values to it, see docs/presets.md.
3. Ollama: spawn, poll GET /api/tags until 200.
4. Collector: spawn, poll GET /accepts until 200. The collector has no health route; /accepts is a plain GET route that answers once the app is mounted.
5. Migrate: run the migrate command (prisma migrate deploy) to completion; exit code 0 required.
6. Server: spawn, poll GET /api/ping until 200.

Each step has its own timeout. A timeout, a child exiting before it is healthy, or a failed migrate rejects start() with a StartError carrying the step name and the last 50 lines of that step's log, and everything already started is stopped.

stop() handles server, collector, Ollama in that order: term signal, wait up to stopTimeoutMs (5 s), then kill signal. With killProcessGroup the signals go to the whole process group, and after the leader exits the kill signal goes to the group once more, so helpers such as the ollama runner do not survive.

When the parent receives SIGINT or SIGTERM (configurable), the manager runs stop() and then re-raises the signal. When the parent exits, an exit handler sends the kill signal to every child; it cannot wait, so it does not try the term signal first. A SIGKILL of the parent cannot be handled; see Open points.

## States

Each process emits a state event { process, state, at (ISO time), pid, port, detail, attempt, delayMs } on the manager ("state" event).

```
             start()
  stopped ----------> starting --health 200--> healthy
     ^                   |                       |
     |            timeout or exit           unexpected exit
     |             (start() rejects)             v
     |                                        crashed <--------------------+
     |                                           |                         |
     |                       fewer than 5 restarts in 10 min?              |
     |                          yes |                  | no                |
     |                              v                  v                   |
     |                         restarting            failed (terminal)     |
     |                     wait 1, 2, 4, 8, 16 s                           |
     |                       respawn, health                               |
     |                        |            |                               |
     |                     200 -> healthy  timeout or exit ----------------+
     |
     +---- stop() from any state
```

Backoff: the delay is 1, 2, 4, 8 or 16 seconds for the first to fifth restart counted in the last 10 minutes. Restarts older than the window no longer count. The sixth crash inside the window emits failed and nothing more is scheduled for that process; the others keep running and the caller decides what to show. A restarted process keeps its port.

status() returns { phase: stopped | starting | running | stopping, ports, processes: { ollama, collector, server: { state, pid, port, since, restarts } } }.

## Environment passed to the children

Precedence, lowest first: baseEnv (default process.env), the values in <dataDir>/server/.env (collector, migrate and server only), the spec's own env, then the values the manager owns:

| Process | Variables set by the manager |
| --- | --- |
| Ollama | OLLAMA_HOST=<host>:<ollama port> |
| collector, migrate, server | NODE_ENV=production, STORAGE_DIR, SERVER_PORT, COLLECTOR_PORT, OLLAMA_BASE_PATH and EMBEDDING_BASE_PATH=http://<host>:<ollama port>, DISABLE_TELEMETRY=true, CHECKPOINT_DISABLE=1 (Prisma CLI telemetry), plus the patch variables below |
| all | NO_PROXY and no_proxy extended with 127.0.0.1, localhost and ::1, so loopback traffic never goes to a proxy |

Variables read by the patches in patches/ (all set for collector, migrate and server):

| Variable | Value set by the manager | Patch |
| --- | --- | --- |
| ANYTHING_LLM_BIND_HOST | host (127.0.0.1) | 001: host argument for the server (HTTP and HTTPS) and collector listen calls |
| DATABASE_URL | file:<storageDir>/anythingllm.db | 002: SQLite path in schema.prisma; prisma generate must run after the patch |
| ANYTHING_LLM_HOTDIR | <dataDir>/collector/hotdir | 003: upload folder, written by the server and read by the collector |
| ANYTHING_LLM_COLLECTOR_TMP_DIR | <dataDir>/collector/tmp | 003: collector scratch folder, wiped at collector boot |
| ANYTHING_LLM_ENV_PATH | <dataDir>/server/.env | 004: the server loads this file at start and dumpENV rewrites it on a settings change |
| ANYTHING_LLM_ALLOWED_ORIGINS | allowedOrigins joined with commas | 005: browser origins allowed besides the server's own; any other Origin header gets 403 |
| ANYTHING_LLM_ALLOW_REMOTE_MODEL_DATA | false, always | 006: the models.dev and raw.githubusercontent.com boot fetches run only when this is true |
| DEFAULT_REASONING_EFFORT | not set by the manager; the preset writes off into .env, and the caller must also pass it in the server spec env (presetSpawnEnv) because upstream dumpENV drops it (docs/presets.md) | 007: thinking switch for the /api/v1 chat routes when the request carries no reasoningEffort |

The manager creates storageDir, the hotdir and the collector tmp folder before the first spawn, because multer and the collector expect them to exist.

The ports written into .env on the first run go stale on the next start; the environment values win because dotenv never overrides a variable that is already set.

## Logs

One file per process in logDir: ollama.log, collector.log, migrate.log, server.log, plus manager.log with one line per event, prefixed [process-manager]. Every line starts with an ISO timestamp. A file that would grow past logMaxBytes (5 MB) is renamed to <name>.log.1, replacing the previous one, and a new file starts.

## Config fields

| Field | Default | Meaning |
| --- | --- | --- |
| dataDir | required | App data root; .env goes to <dataDir>/server/.env |
| storageDir | <dataDir>/storage | STORAGE_DIR for collector and server |
| logDir | required | Log directory |
| host | 127.0.0.1 | Bind and health check address for every child |
| allowedOrigins | [] | Extra browser origins for patch 005, for example the origin of the shell's own renderer pages. A page loaded from file:// sends Origin null; allowing null also allows sandboxed iframes, so prefer a custom protocol |
| baseEnv | process.env | Environment inherited by the children |
| ollama, collector, migrate, server | required | { command, args, cwd, env? } for each step |
| signals | { term: SIGTERM, kill: SIGKILL } | Signal names |
| killProcessGroup | false | Spawn each child as a process group leader and signal the group (POSIX only) |
| timeoutsMs | ollama 30 s, collector 60 s, migrate 120 s, server 120 s | Per step |
| stopTimeoutMs | 5000 | Wait between term and kill signal |
| restart | delays 1, 2, 4, 8, 16 s; maxAttempts 5; window 10 min | Crash restart policy |
| healthIntervalMs | 250 | Poll interval |
| logMaxBytes | 5 MB | Rotation size |
| handleParentSignals, parentSignals | true, [SIGINT, SIGTERM] | Stop the children on these parent signals and on parent exit |

## Building the config in the packaged macOS app

The Electron main process builds the config once at launch. LOCAL work, not verified yet:

```ts
const res = process.resourcesPath;                      // AskFiles.app/Contents/Resources
const appData = path.join(app.getPath("appData"), "AskFiles");  // ~/Library/Application Support/AskFiles
const node = process.execPath;                         // Electron binary, run as Node below
const asNode = { ELECTRON_RUN_AS_NODE: "1" };
const server = path.join(res, "app.asar.unpacked", "upstream", "server");      // final location set by electron-builder.yml
const collector = path.join(res, "app.asar.unpacked", "upstream", "collector");

new ProcessManager({
  dataDir: appData,                                     // server/.env, storage/ (DB, vectors, documents), collector/hotdir
  logDir: app.getPath("logs"),                          // ~/Library/Logs/AskFiles
  ollama: { command: path.join(res, "ollama", "ollama"), args: ["serve"], cwd: appData,
            env: { OLLAMA_MODELS: path.join(appData, "ollama") } },
  collector: { command: node, args: [path.join(collector, "index.js")], cwd: collector, env: asNode },
  migrate: { command: node, args: [path.join(server, "node_modules", "prisma", "build", "index.js"),
             "migrate", "deploy", "--schema=./prisma/schema.prisma"], cwd: server, env: asNode },
  server: { command: node, args: [path.join(server, "index.js")], cwd: server, env: asNode },
  signals: { term: "SIGTERM", kill: "SIGKILL" },
  killProcessGroup: true,
});
```

Call manager.stop() from the app's will-quit handler (with event.preventDefault() until it resolves) so a normal quit is graceful; the parent signal and exit handlers are the fallback. Windows (phase 5) will need a different kill strategy (taskkill /T /F) instead of signals and process groups; that is a change in the caller's config plus a kill function hook, not a platform branch inside the manager.

## Open points

- A SIGKILL of the Electron process (force quit, crash) leaves the children running, since no handler runs. A pid file in dataDir and a cleanup on next launch would cover it; not built.
- Port allocation has a short window between closing the probe socket and the child binding it. A lost race shows as a health timeout naming the step.
- The upstream frontend (phase 1 UI) is served by the server at its own origin, which patch 005 allows. Websocket upgrades (agent chat) were not checked against the origin rule.
- The packaged config above is not verified; it needs the first real package on the Mac (LOCAL).
