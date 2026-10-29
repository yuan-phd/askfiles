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

/** A library folder chosen ahead: the first run uses it instead of asking (smoke test). */
export const LIBRARY_FOLDER_ENV = 'ASKFILES_LIBRARY_FOLDER';

export type StartPage = 'upstream' | 'search' | 'onboarding';

export function upstreamUiEnabled(env: Env): boolean {
  return env[UPSTREAM_UI_ENV] === '1';
}

/** First launch, or a first run cut off before done: onboarding. Otherwise the search page. */
export function chooseStartPage(env: Env, state: ShellState): StartPage {
  if (upstreamUiEnabled(env)) return 'upstream';
  return isSetupComplete(state) ? 'search' : 'onboarding';
}

/** config/presets.json ships inside app.asar (electron-builder.yml, files). */
export function presetsFilePath(env: Env, appPath: string): string {
  return env[PRESETS_FILE_ENV] || path.join(appPath, 'config', 'presets.json');
}

export function presetFolder(env: Env): string | null {
  return env[LIBRARY_FOLDER_ENV] || null;
}
