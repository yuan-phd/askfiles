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
