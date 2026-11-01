import path from 'node:path';
import type { Env } from './config.js';
import { isSetupComplete, type ShellState } from './shell-state.js';

/** Every window keeps this title whatever its page says (index.ts, page-title-updated). */
export const WINDOW_TITLE = 'AskFiles';

/**
 * Hidden developer switch: ASKFILES_UPSTREAM_UI=1 opens the upstream web interface the server
 * serves instead of the AskFiles pages, for debugging. Environment variable only, no shortcut.
 */
export const UPSTREAM_UI_ENV = 'ASKFILES_UPSTREAM_UI';

/** A presets file to use instead of the bundled config/presets.json (smoke test, developers). */
export const PRESETS_FILE_ENV = 'ASKFILES_PRESETS_FILE';

/**
 * A folder linked into All files once setup is done, when All files holds no folder yet: the
 * bridge-free way the smoke test fills the library (there is no folder step any more).
 */
export const LIBRARY_FOLDER_ENV = 'ASKFILES_LIBRARY_FOLDER';

/** Shows the Developer page in the menu: raw preset values and the data directory. */
export const DEVELOPER_ENV = 'ASKFILES_DEVELOPER';

/** npm run dev: the app from source, with the backend from the repository (devBackend). */
export const DEV_ENV = 'ASKFILES_DEV';
/** Port of the Ollama a dev run uses; default the Mac's own, 11434. */
export const OLLAMA_PORT_ENV = 'ASKFILES_OLLAMA_PORT';

/** Where a dev run takes its backend from, in place of the app bundle. */
export interface DevBackend {
  /** Stands in for process.resourcesPath: upstream/ holds server/ and collector/ like Resources. */
  resourcesPath: string;
  /** Plain Node for server and collector: their native modules were built by yarn for it, not for Electron. */
  nodePath: string;
  externalOllamaPort: number;
}

export function devBackend(env: Env, appPath: string): DevBackend | null {
  if (env[DEV_ENV] !== '1') return null;
  const raw = env[OLLAMA_PORT_ENV];
  const port = raw ? Number(raw) : 11434;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${OLLAMA_PORT_ENV} must be a port number`);
  return {
    resourcesPath: path.join(appPath, 'upstream'),
    nodePath: env.npm_node_execpath || 'node',
    externalOllamaPort: port,
  };
}

export type StartPage = 'upstream' | 'ask' | 'onboarding';

export function upstreamUiEnabled(env: Env): boolean {
  return env[UPSTREAM_UI_ENV] === '1';
}

/** First launch, or a first run cut off before done: onboarding. Otherwise the Ask page. */
export function chooseStartPage(env: Env, state: ShellState): StartPage {
  if (upstreamUiEnabled(env)) return 'upstream';
  return isSetupComplete(state) ? 'ask' : 'onboarding';
}

/** config/presets.json ships inside app.asar (electron-builder.yml, files). */
export function presetsFilePath(env: Env, appPath: string): string {
  return env[PRESETS_FILE_ENV] || path.join(appPath, 'config', 'presets.json');
}

export function developerEnabled(env: Env): boolean {
  return env[DEVELOPER_ENV] === '1';
}

export function presetFolder(env: Env): string | null {
  return env[LIBRARY_FOLDER_ENV] || null;
}
