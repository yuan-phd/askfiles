import fs from 'node:fs';
import path from 'node:path';

/**
 * What the shell itself remembers between launches, in <dataDir>/shell.json. The API key is a
 * secret for the local server, so the file is written with mode 0600 like server/.env.
 */
export interface ShellState {
  version: 1;
  /** The one folder the user picked; watched recursively, never modified. */
  folder: string | null;
  /** Slug of the hidden library workspace. */
  workspaceSlug: string | null;
  /** Developer API key the main process and the search page use. */
  apiKey: string | null;
  /** ISO time the first run finished. Its presence is the completed-setup marker. */
  setupCompletedAt: string | null;
}

export const SHELL_STATE_FILE = 'shell.json';

export function emptyShellState(): ShellState {
  return { version: 1, folder: null, workspaceSlug: null, apiKey: null, setupCompletedAt: null };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * A missing or unreadable file is an empty state: the first run then starts again, which is safe
 * because every first-run step is idempotent (models already pulled are skipped, the library
 * workspace is found by name, a stored key is checked before reuse).
 */
export function loadShellState(dataDir: string, log: (msg: string) => void = () => {}): ShellState {
  const file = path.join(dataDir, SHELL_STATE_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyShellState();
    throw e;
  }
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (d.version !== 1) throw new Error(`version ${String(d.version)}`);
    return {
      version: 1,
      folder: str(d.folder),
      workspaceSlug: str(d.workspaceSlug),
      apiKey: str(d.apiKey),
      setupCompletedAt: str(d.setupCompletedAt),
    };
  } catch (e) {
    log(`${file} unreadable (${(e as Error).message}), starting setup again`);
    return emptyShellState();
  }
}

/** Temp file and rename, so a crash never leaves half a file. */
export function saveShellState(dataDir: string, state: ShellState): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, SHELL_STATE_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function isSetupComplete(state: ShellState): boolean {
  return state.setupCompletedAt !== null && state.folder !== null && state.workspaceSlug !== null && !!state.apiKey;
}
