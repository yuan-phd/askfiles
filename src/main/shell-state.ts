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
 * A file added on its own (Add files, drag and drop): linked by its absolute path and watched
 * through its folder, like a file inside a linked folder; never copied or modified.
 */
export interface FileSource {
  /** Stable id, part of the document names of the file. */
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
  /** Individually added files; absent in records written before files were linked. */
  files?: FileSource[];
  /** The highest added-file id number given so far, so a removed file's id is never given again. */
  lastFileId?: number;
  createdAt: string;
  /** Profile id (config/profiles, src/main/graph/profiles.ts); absent means the default. */
  profile?: string;
  /** The user's document types, per profile id, by document id; never replaced by detection. */
  typeOverrides?: Record<string, Record<string, string>>;
  /** The user's answers to family questions, by pair key (src/main/graph/families.ts pairKey). */
  familyDecisions?: Record<string, boolean>;
  /** Section summaries for every document of the library (docs/summaries.md); off by default. */
  sectionSummaries?: boolean;
  /**
   * Set before a delete removes anything: the library is hidden at once, and a delete the app could
   * not finish (it quit, the server was down) is finished at the next start (src/main/library-data.ts).
   */
  deleting?: boolean;
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

/** One library record as shell.json (or a library's library.json) stores it; null when unusable. */
export function readLibrary(v: unknown): LibraryRecord | null {
  const d = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const id = str(d.id);
  const name = str(d.name);
  if (!id || !name || !/^[a-z0-9-]{1,40}$/.test(id)) return null;
  const folders = (Array.isArray(d.folders) ? d.folders : [])
    .map((f) => (f && typeof f === 'object' ? (f as Record<string, unknown>) : {}))
    .filter((f) => str(f.id) && str(f.path))
    .map((f) => ({ id: f.id as string, path: f.path as string, addedAt: str(f.addedAt) ?? new Date(0).toISOString() }));
  const files = (Array.isArray(d.files) ? d.files : [])
    .map((f) => (f && typeof f === 'object' ? (f as Record<string, unknown>) : {}))
    .filter((f) => str(f.id) && str(f.path))
    .map((f) => ({ id: f.id as string, path: f.path as string, addedAt: str(f.addedAt) ?? new Date(0).toISOString() }));
  const profile = str(d.profile);
  const overrides: Record<string, Record<string, string>> = {};
  if (d.typeOverrides && typeof d.typeOverrides === 'object') {
    for (const [pid, map] of Object.entries(d.typeOverrides as Record<string, unknown>)) {
      if (!/^[a-z0-9-]{1,40}$/.test(pid) || !map || typeof map !== 'object') continue;
      const clean: Record<string, string> = {};
      for (const [doc, type] of Object.entries(map as Record<string, unknown>))
        if (/^[0-9a-f]{16}$/.test(doc) && typeof type === 'string' && /^[a-z0-9-]{1,30}$/.test(type)) clean[doc] = type;
      if (Object.keys(clean).length) overrides[pid] = clean;
    }
  }
  const decisions: Record<string, boolean> = {};
  if (d.familyDecisions && typeof d.familyDecisions === 'object') {
    for (const [pair, v] of Object.entries(d.familyDecisions as Record<string, unknown>))
      if (/^[0-9a-f]{16}\|[0-9a-f]{16}$/.test(pair) && typeof v === 'boolean') decisions[pair] = v;
  }
  return {
    id,
    name,
    workspaceSlug: str(d.workspaceSlug),
    folders,
    ...(files.length ? { files } : {}),
    ...(Number.isInteger(d.lastFileId) && (d.lastFileId as number) > 0 ? { lastFileId: d.lastFileId as number } : {}),
    createdAt: str(d.createdAt) ?? new Date(0).toISOString(),
    ...(profile && /^[a-z0-9-]{1,40}$/.test(profile) ? { profile } : {}),
    ...(Object.keys(overrides).length ? { typeOverrides: overrides } : {}),
    ...(Object.keys(decisions).length ? { familyDecisions: decisions } : {}),
    ...(d.sectionSummaries === true ? { sectionSummaries: true } : {}),
    ...(d.deleting === true ? { deleting: true } : {}),
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

export const SHELL_STATE_BACKUP = 'shell.json.bak';
/**
 * Marker of a start whose shell.json could not be trusted (src/main/library-recovery.ts). A file of
 * its own, so no later save of shell.json can drop it: while it exists the self-check removes
 * nothing, the watcher keeps files of sources it does not know, and saves never replace a good
 * shell.json.bak.
 */
export const SELF_CHECK_HOLD = 'self-check-hold.json';
/** A library's own copy of its record, under <dataDir>/libraries/<id>/, for rebuilding shell.json. */
export const LIBRARY_RECORD_FILE = 'library.json';

/**
 * Where a loaded state came from. Only 'file' is the app's latest word on which libraries exist:
 * the startup self-check removes data of unknown libraries only then. The backup is one save
 * behind, so a library created in the last save may be missing from it; an empty state knows none.
 */
export type ShellStateSource = 'file' | 'backup' | 'missing' | 'unreadable';

export interface ShellStateRead {
  state: ShellState & { migrated?: 1 };
  source: ShellStateSource;
  /**
   * Every library id the file names, also of records too damaged to load: data under such an id
   * is never treated as belonging to no library.
   */
  knownIds: Set<string>;
}

function parseShellState(raw: string): { state: ShellState & { migrated?: 1 }; knownIds: Set<string> } {
  const d = JSON.parse(raw) as Record<string, unknown>;
  if (!d || typeof d !== 'object') throw new Error('not an object');
  if (d.version === 1) return { state: { ...migrateV1(d), migrated: 1 }, knownIds: new Set([DEFAULT_LIBRARY_ID]) };
  if (d.version !== 2) throw new Error(`version ${String(d.version)}`);
  const rawLibs = Array.isArray(d.libraries) ? d.libraries : [];
  const knownIds = new Set<string>([DEFAULT_LIBRARY_ID]);
  for (const l of rawLibs) {
    const id = l && typeof l === 'object' ? (l as Record<string, unknown>).id : null;
    if (typeof id === 'string' && id) knownIds.add(id);
  }
  const libraries = withDefault(rawLibs.map(readLibrary).filter((l): l is LibraryRecord => !!l));
  const current = str(d.currentLibrary);
  const shown = libraries.find((l) => l.id === current && !l.deleting);
  return {
    state: {
      version: 2,
      apiKey: str(d.apiKey),
      setupCompletedAt: str(d.setupCompletedAt),
      libraries,
      currentLibrary: shown ? shown.id : DEFAULT_LIBRARY_ID,
      settings: readSettings(d.settings),
    },
    knownIds,
  };
}

function parses(text: string | null): boolean {
  if (text === null) return false;
  try {
    parseShellState(text);
    return true;
  } catch {
    return false;
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Why and since when the self-check is held; null when it is not. */
export interface SelfCheckHold {
  since: string;
  reason: string;
}

/** The hold, or null. A marker that cannot be read still holds: it exists, so something went wrong. */
export function readSelfCheckHold(dataDir: string): SelfCheckHold | null {
  const text = readText(path.join(dataDir, SELF_CHECK_HOLD));
  if (text === null) return fs.existsSync(path.join(dataDir, SELF_CHECK_HOLD)) ? { since: '', reason: '' } : null;
  try {
    const d = JSON.parse(text) as Record<string, unknown>;
    return { since: str(d.since) ?? '', reason: str(d.reason) ?? '' };
  } catch {
    return { since: '', reason: '' };
  }
}

/** Sets the hold; an existing one keeps its time and reason (the first trouble is the one to know). */
export function setSelfCheckHold(dataDir: string, reason: string, now = new Date()): SelfCheckHold {
  const held = readSelfCheckHold(dataDir);
  if (held) return held;
  fs.mkdirSync(dataDir, { recursive: true });
  const hold = { since: now.toISOString(), reason };
  replaceDurably(path.join(dataDir, SELF_CHECK_HOLD), JSON.stringify(hold) + '\n');
  return hold;
}

export function clearSelfCheckHold(dataDir: string): void {
  fs.rmSync(path.join(dataDir, SELF_CHECK_HOLD), { force: true });
}

/**
 * Keeps text as shell.json.bak. While the self-check is held, shell.json may be a rebuilt or reset
 * state, so a backup that still reads is never replaced then: it may be the last good one.
 */
function keepBackup(dataDir: string, text: string): void {
  const backup = path.join(dataDir, SHELL_STATE_BACKUP);
  const current = readText(backup);
  if (current === text) return;
  if (readSelfCheckHold(dataDir) && parses(current)) return;
  replaceDurably(backup, text);
}

/**
 * Reads shell.json. When it is missing or unreadable, the backup (shell.json.bak) is loaded and the
 * event logged; an unreadable file is first moved aside as shell.json.broken-<time> so it can be
 * looked at. Without a usable backup a missing or unreadable file is an empty state. A file that
 * reads is also kept as the backup when the backup differs, so a backup exists from the first
 * start, not only after the first save. Rebuilding libraries from their own folders and the
 * self-check hold are library-recovery.ts openShellState, which calls this. migrated is set when
 * the file was version 1, so the caller can move that version's files and save the new shape.
 */
export function readShellState(dataDir: string, log: (msg: string) => void = () => {}): ShellStateRead {
  const file = path.join(dataDir, SHELL_STATE_FILE);
  const backup = path.join(dataDir, SHELL_STATE_BACKUP);
  let source: ShellStateSource;
  let reason: string;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = parseShellState(raw);
    try {
      keepBackup(dataDir, raw);
    } catch (e) {
      log(`[shell-state] backup not refreshed: ${(e as Error).message}`);
    }
    return { ...parsed, source: 'file' };
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    source = missing ? 'missing' : 'unreadable';
    reason = (e as Error).message;
    if (!missing) {
      const aside = `${file}.broken-${Date.now()}`;
      try {
        fs.renameSync(file, aside);
        log(`[shell-state] ${file} unreadable (${reason}), moved to ${aside}`);
      } catch {
        log(`[shell-state] ${file} unreadable (${reason})`);
      }
    }
  }
  try {
    const parsed = parseShellState(fs.readFileSync(backup, 'utf8'));
    log(`[shell-state] ${file} ${source === 'missing' ? 'missing' : 'unreadable'}, loaded the backup ${backup}`);
    return { ...parsed, source: 'backup' };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      log(`[shell-state] backup ${backup} unreadable too (${(e as Error).message})`);
    else if (source === 'unreadable') log(`[shell-state] no backup ${backup}`);
  }
  if (source === 'unreadable') log(`[shell-state] ${file} unreadable (${reason}), no state to load`);
  return { state: emptyShellState(), source, knownIds: new Set([DEFAULT_LIBRARY_ID]) };
}

/** The state alone (readShellState has the source and the ids the file names). */
export function loadShellState(dataDir: string, log: (msg: string) => void = () => {}): ShellState & { migrated?: 1 } {
  return readShellState(dataDir, log).state;
}

function writeDurably(file: string, text: string): void {
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function replaceDurably(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeDurably(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Each library's record also goes to <dataDir>/libraries/<id>/library.json, so a lost shell.json
 * can be rebuilt with names, kinds and sources (library-recovery.ts). Only into a folder that
 * exists: a library without one has nothing to rebuild, and a library being deleted gets none.
 */
function writeLibraryRecords(dataDir: string, libraries: LibraryRecord[]): void {
  for (const lib of libraries) {
    if (lib.deleting) continue;
    const dir = path.join(dataDir, 'libraries', lib.id);
    if (!fs.existsSync(dir)) continue;
    const file = path.join(dir, LIBRARY_RECORD_FILE);
    const text = JSON.stringify(lib, null, 2) + '\n';
    if (readText(file) !== text) replaceDurably(file, text);
  }
}

/**
 * Temp file and rename, so a crash never leaves half a file. The version being replaced is kept as
 * shell.json.bak first, but only when it still reads (a damaged file never replaces a good backup)
 * and, while the self-check is held, only when the backup does not read either.
 */
export function saveShellState(dataDir: string, state: ShellState): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, SHELL_STATE_FILE);
  const { version, apiKey, setupCompletedAt, libraries, currentLibrary, settings } = state;
  const out = { version, apiKey, setupCompletedAt, libraries, currentLibrary, settings };
  const tmp = `${file}.tmp-${process.pid}`;
  writeDurably(tmp, JSON.stringify(out, null, 2) + '\n');
  const previous = readText(file);
  if (previous !== null && parses(previous)) keepBackup(dataDir, previous);
  fs.renameSync(tmp, file);
  // After shell.json: a failure here leaves the library copies one save behind, never shell.json.
  try {
    writeLibraryRecords(dataDir, libraries);
  } catch {
    // The copies are a second line of defence; shell.json itself is saved.
  }
}

export function currentLibraryOf(state: ShellState): LibraryRecord {
  return state.libraries.find((l) => l.id === state.currentLibrary) ?? state.libraries[0]!;
}

/** Setup is complete once the first run finished with a key and the default library's workspace. */
export function isSetupComplete(state: ShellState): boolean {
  return state.setupCompletedAt !== null && !!state.apiKey && !!state.libraries[0]?.workspaceSlug;
}
