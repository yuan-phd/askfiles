import { app } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { bundledBackendConfig, presetServerEnv } from './backend-config.js';
import type { Logger } from './config.js';
import { ProcessManager } from './process-manager/index.js';

/** Shown while the backend starts; the first launch can take a minute. */
export const STARTING_PAGE =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>AskFiles</title>
<body style="font-family:-apple-system,system-ui,sans-serif;padding:2em;line-height:1.5">
<h1>AskFiles</h1><p>Starting. This can take a minute the first time.</p></body>`);

export interface BackendHandlers {
  onReady: (origin: string) => void;
  onError: (message: string) => void;
}

/**
 * Starts Ollama, collector and server from the app bundle and stops them when the app quits.
 * The ports are published in <userData>/ports.json by the process manager.
 */
export function startBundledBackend(log: Logger, handlers: BackendHandlers): ProcessManager | null {
  let serverEnv: Record<string, string>;
  try {
    // config/presets.json ships inside app.asar (electron-builder.yml, files).
    serverEnv = presetServerEnv(path.join(app.getAppPath(), 'config', 'presets.json'), os.totalmem());
  } catch (e) {
    // Without the preset the server would run with thinking on; a broken bundle must show, not limp.
    log(`backend not started: ${(e as Error).message}`);
    handlers.onError((e as Error).message);
    return null;
  }
  log(`server preset env ${JSON.stringify(serverEnv)}`);
  const manager = new ProcessManager(
    bundledBackendConfig({
      resourcesPath: process.resourcesPath,
      dataDir: app.getPath('userData'),
      logDir: app.getPath('logs'),
      nodePath: process.execPath,
      serverEnv,
    }),
  );
  manager.on('state', (e) => {
    if (e.state !== 'healthy' && e.state !== 'starting')
      log(`backend ${e.process} ${e.state}${e.detail ? ` (${e.detail})` : ''}`);
  });

  // Hold the quit until the children are down, then quit for real.
  let stopped = false;
  app.on('will-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    log('stopping backend before quit');
    void manager.stop().finally(() => {
      stopped = true;
      app.quit();
    });
  });

  log('starting backend');
  manager.start().then(
    (s) => {
      log(`backend running, server on ${s.ports!.server}`);
      handlers.onReady(`http://127.0.0.1:${s.ports!.server}`);
    },
    (e: Error) => {
      log(`backend failed: ${e.message.split('\n')[0]}`);
      handlers.onError(e.message.split('\n')[0]!);
    },
  );
  return manager;
}
