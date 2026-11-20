# Ticket: backend logs do not follow ASKFILES_LOG_DIR

Status: open. Found on branch local/v1.0.0 (2026-11-20) while taking the README screenshots. Not fixed there.

## What happens

ASKFILES_LOG_DIR (src/main/config.ts, `LOG_DIR_ENV` and `resolveLogDir`) moves only the main process log: src/main/index.ts creates the main logger with `resolveLogDir(process.env, app.getPath('logs'))`. The process manager gets its log folder separately, `logDir: app.getPath('logs')` in src/main/app.ts (bundledBackendConfig), so the logs of the child processes and of the manager (manager.log, migrate.log, server.log, collector.log, ollama.log and its rotations) always go to the default folder: ~/Library/Logs/AskFiles on macOS, %LOCALAPPDATA%\AskFiles\logs on Windows.

`--user-data-dir` does not change this either, since app.getPath('logs') does not derive from userData on macOS.

## Why it matters

A run of the packaged app on a scratch data folder, for screenshots, a demo or a manual test, is expected to leave the installed app's files alone. With ASKFILES_LOG_DIR set, main.log goes to the scratch folder but every backend log line is appended to the user's real log folder. A log rotation there can drop the user's oldest rotated log; in the screenshot runs, one Ollama rotation replaced the older ollama.log.1.

## Proposed fix

Resolve the log folder once in src/main/index.ts with `resolveLogDir` and pass that one value to both the main logger and the process manager (through App's dependencies to bundledBackendConfig), so that ASKFILES_LOG_DIR moves every log the app writes. Unit test: with ASKFILES_LOG_DIR set, the backend configuration's logDir is that folder; without it, app.getPath('logs').

Until it is fixed: before a packaged run on a scratch data folder, expect the backend logs in the default folder, and back that folder up if its contents matter.
