import fs from 'node:fs';
import path from 'node:path';

/** A folder linked into a library: watched recursively, never modified. */
export interface FolderSource {
  /** Stable id, part of the document names of its files. */
  id: string;
  path: string;
  addedAt: string;
}

/**
 * One library: an upstream workspace plus the shell's own records under
 * <dataDir>/libraries/<id> (index.json, browse/, files/ for added files; src/main/libraries).
 */
export interface LibraryRecord {
  id: string;
  name: string;
  /** Slug of the library's hidden workspace; null until the server created it. */
  workspaceSlug: string | null;
  folders: FolderSource[];
  createdAt: string;
}

export type AnswerScope = 'strict' | 'balanced' | 'broad';
export type AnswerModel = 'faster' | 'better';
export const ANSWER_SCOPES: readonly AnswerScope[] = ['strict', 'balanced', 'broad'];
export const ANSWER_MODELS: readonly AnswerModel[] = ['faster', 'better'];
export const CONTEXT_LENGTHS: readonly number[] = [4096, 8192, 16384];

/** The Settings page values (src/main/settings.ts says what each one maps to). */
export interface Settings {
  answerScope: AnswerScope;
  answerModel: AnswerModel;
  /** Tokens; null means the preset's own contextLength. */
  contextLength: number | null;
}

/**
 * What the shell itself remembers between launches, in <dataDir>/shell.json. The API key is a
 * secret for the local server, so the file is written with mode 0600 like server/.env.
 */
export interface ShellState {
  version: 2;
  /** Developer API key the main process and the pages use. */
  apiKey: string | null;
  /** ISO time the first run finished. Its presence is the completed-setup marker. */
  setupCompletedAt: string | null;
  /** The default library comes first and always exists once loaded. */
  libraries: LibraryRecord[];
  /** Id of the library the window shows. */
  currentLibrary: string;
  settings: Settings;
}

export const SHELL_STATE_FILE = 'shell.json';

/** The library every install has: it cannot be renamed or deleted. */
export const DEFAULT_LIBRARY_ID = 'all-files';
export const DEFAULT_LIBRARY_NAME = 'All files';

export function defaultSettings(): Settings {
  return { answerScope: 'balanced', answerModel: 'better', contextLength: null };
}

export function defaultLibrary(createdAt = new Date().toISOString()): LibraryRecord {
  return { id: DEFAULT_LIBRARY_ID, name: DEFAULT_LIBRARY_NAME, workspaceSlug: null, folders: [], createdAt };
}

export function emptyShellState(): ShellState {
  return {
    version: 2,
    apiKey: null,
    setupCompletedAt: null,
    libraries: [defaultLibrary(new Date(0).toISOString())],
    currentLibrary: DEFAULT_LIBRARY_ID,
    settings: defaultSettings(),
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function readSettings(v: unknown): Settings {
  const d = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const def = defaultSettings();
  return {
    answerScope: ANSWER_SCOPES.includes(d.answerScope as AnswerScope)
      ? (d.answerScope as AnswerScope)
      : def.answerScope,
    answerModel: ANSWER_MODELS.includes(d.answerModel as AnswerModel)
      ? (d.answerModel as AnswerModel)
      : def.answerModel,
    contextLength: CONTEXT_LENGTHS.includes(d.contextLength as number) ? (d.contextLength as number) : null,
  };
}

function readLibrary(v: unknown): LibraryRecord | null {
  const d = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const id = str(d.id);
  const name = str(d.name);
  if (!id || !name || !/^[a-z0-9-]{1,40}$/.test(id)) return null;
  const folders = (Array.isArray(d.folders) ? d.folders : [])
    .map((f) => (f && typeof f === 'object' ? (f as Record<string, unknown>) : {}))
    .filter((f) => str(f.id) && str(f.path))
    .map((f) => ({ id: f.id as string, path: f.path as string, addedAt: str(f.addedAt) ?? new Date(0).toISOString() }));
  return {
    id,
    name,
    workspaceSlug: str(d.workspaceSlug),
    folders,
    createdAt: str(d.createdAt) ?? new Date(0).toISOString(),
  };
}

/** The default library first, with its fixed name, whatever the file said. */
function withDefault(libs: LibraryRecord[]): LibraryRecord[] {
  const found = libs.find((l) => l.id === DEFAULT_LIBRARY_ID) ?? defaultLibrary(new Date(0).toISOString());
  const rest = libs.filter((l, i) => l.id !== DEFAULT_LIBRARY_ID && libs.findIndex((x) => x.id === l.id) === i);
  return [{ ...found, name: DEFAULT_LIBRARY_NAME }, ...rest];
}

/**
 * Version 1 (Sessions H to J) had one folder and one workspace. They become the default library
 * with that folder linked; the files that went with it are moved by moveLegacyLibraryFiles.
 */
export function migrateV1(d: Record<string, unknown>): ShellState {
  const state = emptyShellState();
  state.apiKey = str(d.apiKey);
  state.setupCompletedAt = str(d.setupCompletedAt);
  const lib = state.libraries[0]!;
  lib.workspaceSlug = str(d.workspaceSlug);
  const folder = str(d.folder);
  if (folder) lib.folders.push({ id: 'folder-1', path: folder, addedAt: new Date(0).toISOString() });
  return state;
}

/**
 * A missing or unreadable file is an empty state: the first run then starts again, which is safe
 * because every first-run step is idempotent (models already pulled are skipped, the library
 * workspace is found by name, a stored key is checked before reuse). migrated is set when the
 * file was version 1, so the caller can move that version's files and save the new shape.
 */
export function loadShellState(dataDir: string, log: (msg: string) => void = () => {}): ShellState & { migrated?: 1 } {
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
    if (d.version === 1) return { ...migrateV1(d), migrated: 1 };
    if (d.version !== 2) throw new Error(`version ${String(d.version)}`);
    const libraries = withDefault(
      (Array.isArray(d.libraries) ? d.libraries : []).map(readLibrary).filter((l): l is LibraryRecord => !!l),
    );
    const current = str(d.currentLibrary);
    return {
      version: 2,
      apiKey: str(d.apiKey),
      setupCompletedAt: str(d.setupCompletedAt),
      libraries,
      currentLibrary: libraries.some((l) => l.id === current) ? current! : DEFAULT_LIBRARY_ID,
      settings: readSettings(d.settings),
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
  const { version, apiKey, setupCompletedAt, libraries, currentLibrary, settings } = state;
  const out = { version, apiKey, setupCompletedAt, libraries, currentLibrary, settings };
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function currentLibraryOf(state: ShellState): LibraryRecord {
  return state.libraries.find((l) => l.id === state.currentLibrary) ?? state.libraries[0]!;
}

/** Setup is complete once the first run finished with a key and the default library's workspace. */
export function isSetupComplete(state: ShellState): boolean {
  return state.setupCompletedAt !== null && !!state.apiKey && !!state.libraries[0]?.workspaceSlug;
}
