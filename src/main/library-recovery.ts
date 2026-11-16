import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY_ID_RE, peekIndex } from './library-data.js';
import {
  DEFAULT_LIBRARY_ID,
  isSetupComplete,
  LIBRARY_RECORD_FILE,
  readLibrary,
  readSelfCheckHold,
  readShellState,
  saveShellState,
  setSelfCheckHold,
  type FileSource,
  type FolderSource,
  type LibraryRecord,
  type SelfCheckHold,
  type ShellState,
  type ShellStateRead,
} from './shell-state.js';

/**
 * Rebuilding shell.json's libraries from what each library keeps in its own folders, and the
 * self-check hold (docs/app.md, Where the API key lives):
 *
 * - A start whose shell.json could not be trusted (loaded from the backup, unreadable with no
 *   backup, missing while library data exists) rebuilds every library that has a folder under
 *   <dataDir>/libraries or <storage>/documents/askfiles, from its library.json (written with every
 *   save), its index.json (sources) and graph.json (kind), and sets the hold.
 * - While the hold is set, every start rebuilds the libraries shell.json does not name, so a save
 *   that dropped one (a first run on a reset state) cannot make its data look unused.
 * - The hold is lifted by the self-check at the first start where shell.json, as read, names every
 *   library folder on disk (library-data.ts startupLibraryCheck).
 */

const RECOVERED_NAME = 'Recovered library';

export interface OpenedShellState extends ShellStateRead {
  /**
   * The libraries came back from the backup or were rebuilt: the first run is not needed again
   * when the server's settings file exists (finishRestore makes the API key and workspaces).
   */
  restored: boolean;
  /** The self-check hold; unnamed lists the library ids on disk shell.json did not name as read. */
  hold: (SelfCheckHold & { unnamed: string[] }) | null;
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Ids of the libraries with data on disk: a library folder or a folder of section documents. */
export function libraryIdsOnDisk(dataDir: string, storageDir: string): string[] {
  const ids = new Set<string>();
  for (const dir of [path.join(dataDir, 'libraries'), path.join(storageDir, 'documents', 'askfiles')])
    for (const name of listDirs(dir)) if (name === DEFAULT_LIBRARY_ID || LIBRARY_ID_RE.test(name)) ids.add(name);
  return [...ids].sort((a, b) => (a === DEFAULT_LIBRARY_ID ? -1 : b === DEFAULT_LIBRARY_ID ? 1 : a.localeCompare(b)));
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** The kind (profile id) graph.json was built with, or null. */
function profileFromGraph(dir: string): string | null {
  const g = readJson(path.join(dir, 'graph.json')) as { profile?: { id?: unknown } } | null;
  const id = g?.profile?.id;
  return typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id) ? id : null;
}

interface IndexSources {
  folders: FolderSource[];
  files: FileSource[];
  /** Source ids whose folder could not be worked out, with their number of files. */
  unknown: Map<string, number>;
  earliest: string | null;
}

/**
 * The sources index.json's records name. A folder's file has relPath "<folder name>/<path inside>"
 * (watcher relPathOf), so the folder is the file's path without the part inside it. An added file
 * is its own path. Copies of earlier versions (source id files) need no record. Null when the index
 * cannot be read.
 */
function sourcesFromIndex(dir: string): IndexSources | null {
  const index = peekIndex(path.join(dir, 'index.json'));
  if (!index) return null;
  const folders = new Map<string, FolderSource>();
  const files = new Map<string, FileSource>();
  const unknown = new Map<string, number>();
  let earliest: string | null = null;
  const older = (a: string | null, b: string) => (!a || b < a ? b : a);
  for (const rec of Object.values(index.files)) {
    if (!rec || typeof rec.path !== 'string') continue;
    const at = typeof rec.indexedAt === 'string' ? rec.indexedAt : new Date(0).toISOString();
    earliest = older(earliest, at);
    const id = rec.sourceId;
    if (typeof id !== 'string') continue;
    if (/^folder-\d+$/.test(id)) {
      const parts = typeof rec.relPath === 'string' ? rec.relPath.split(/[\\/]/) : [];
      const inside = parts.slice(1).join(path.sep);
      const folder =
        parts.length >= 2 && rec.path.endsWith(path.sep + inside) ? rec.path.slice(0, -(inside.length + 1)) : null;
      const known = folders.get(id);
      if (!folder || (known && known.path !== folder)) {
        unknown.set(id, (unknown.get(id) ?? 0) + 1);
        continue;
      }
      folders.set(id, { id, path: folder, addedAt: older(known?.addedAt ?? null, at) });
    } else if (/^file-\d+$/.test(id)) {
      files.set(id, { id, path: rec.path, addedAt: older(files.get(id)?.addedAt ?? null, at) });
    }
  }
  for (const id of unknown.keys()) folders.delete(id);
  const byNumber = (a: { id: string }, b: { id: string }) =>
    Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, ''));
  return {
    folders: [...folders.values()].sort(byNumber),
    files: [...files.values()].sort(byNumber),
    unknown,
    earliest,
  };
}

function isEmptyDefault(lib: LibraryRecord | undefined): boolean {
  return !!lib && lib.id === DEFAULT_LIBRARY_ID && !lib.folders.length && !lib.files?.length && !lib.workspaceSlug;
}

/**
 * Rebuilds the records of the given library ids into state. The base is the library's
 * library.json (written with every save, so never older than shell.json.bak), else the record the
 * state has (from the backup), else a new record. Sources index.json names and the base lacks are
 * added, except to a library.json base: it is the latest word, and a folder removed in the last
 * save may still have files in the index while their removal waits. Returns the new state, the
 * ids rebuilt and one log line per finding.
 */
export function rebuildLibraries(o: {
  dataDir: string;
  storageDir: string;
  state: ShellState;
  ids: string[];
  now?: () => Date;
}): { state: ShellState; rebuilt: string[]; lines: string[] } {
  const lines: string[] = [];
  const rebuilt: string[] = [];
  const libraries = [...o.state.libraries];
  const nameOf = new Map(libraries.map((l) => [l.id, l.name.toLowerCase()]));
  const taken = (name: string, self: string) => [...nameOf].some(([id, n]) => id !== self && n === name.toLowerCase());
  let n = 0;
  const placeholder = (self: string) => {
    let name: string;
    do name = `${RECOVERED_NAME} ${++n}`;
    while (taken(name, self));
    return name;
  };

  for (const id of o.ids) {
    const dir = path.join(o.dataDir, 'libraries', id);
    const at = libraries.findIndex((l) => l.id === id);
    const existing = at >= 0 ? libraries[at] : undefined;
    if (existing?.deleting) continue;
    const say = (m: string) => lines.push(`[recovery] ${id}: ${m}`);
    const copy = readLibrary(readJson(path.join(dir, LIBRARY_RECORD_FILE)));
    const mirror = copy && copy.id === id && !copy.deleting ? copy : null;
    let lib: LibraryRecord;
    let base: 'mirror' | 'state' | 'new';
    if (mirror) {
      lib = { ...mirror };
      base = 'mirror';
      say('record rebuilt from library.json');
    } else if (existing && !isEmptyDefault(existing)) {
      lib = { ...existing };
      base = 'state';
    } else {
      lib = existing
        ? { ...existing }
        : { id, name: '', workspaceSlug: null, folders: [], createdAt: (o.now?.() ?? new Date()).toISOString() };
      base = 'new';
      if (!existing) say('no library.json, name not known');
    }
    if (id !== DEFAULT_LIBRARY_ID && (!lib.name || taken(lib.name, id))) {
      const was = lib.name;
      lib.name = placeholder(id);
      say(
        was
          ? `its name ${JSON.stringify(was)} is taken, called ${JSON.stringify(lib.name)}`
          : `called ${JSON.stringify(lib.name)}`,
      );
    }
    nameOf.set(id, lib.name.toLowerCase());

    const hasDir = fs.existsSync(dir);
    const fromIndex = hasDir ? sourcesFromIndex(dir) : null;
    if (!hasDir) say('only its section documents are left, no sources rebuilt');
    else if (!fromIndex) say('index.json cannot be read, no sources rebuilt');
    if (fromIndex && base !== 'mirror') {
      const usedPaths = new Set(lib.folders.map((f) => f.path));
      const folders = fromIndex.folders.filter(
        (f) => !lib.folders.some((x) => x.id === f.id) && !usedPaths.has(f.path),
      );
      const files = fromIndex.files.filter((f) => !(lib.files ?? []).some((x) => x.id === f.id || x.path === f.path));
      if (folders.length || files.length) {
        lib.folders = [...lib.folders, ...folders];
        if (files.length) lib.files = [...(lib.files ?? []), ...files];
        const top = Math.max(
          lib.lastFileId ?? 0,
          ...(lib.files ?? []).map((f) => Number(f.id.slice('file-'.length)) || 0),
        );
        if (top > 0) lib.lastFileId = top;
        say(`${folders.length} folders and ${files.length} added files from index.json`);
      }
      for (const [sid, count] of fromIndex.unknown)
        say(`source ${sid} not rebuilt: its folder cannot be worked out from its ${count} files`);
      if (base === 'new' && !existing && fromIndex.earliest) lib.createdAt = fromIndex.earliest;
    }
    if (!lib.profile && id !== DEFAULT_LIBRARY_ID) {
      const profile = profileFromGraph(dir);
      if (profile) {
        lib.profile = profile;
        say(`kind ${profile} from graph.json`);
      }
    }
    if (!lib.workspaceSlug) say('workspace not known, looked up when the search engine runs');
    if (at >= 0) libraries[at] = lib;
    else libraries.push(lib);
    rebuilt.push(id);
  }
  return { state: { ...o.state, libraries }, rebuilt, lines };
}

/**
 * shell.json as the app starts with it: readShellState, then, when the state cannot be trusted or
 * the hold is set, the libraries rebuilt from their folders and saved, and the hold set. A first
 * install (no shell.json, no library data) is left as it is.
 */
export function openShellState(o: {
  dataDir: string;
  storageDir: string;
  log: (msg: string) => void;
  now?: () => Date;
}): OpenedShellState {
  const read = readShellState(o.dataDir, o.log);
  const onDisk = libraryIdsOnDisk(o.dataDir, o.storageDir);
  const unnamed = onDisk.filter((id) => id !== DEFAULT_LIBRARY_ID && !read.knownIds.has(id));
  const held = readSelfCheckHold(o.dataDir);
  const trusted = read.source === 'file';
  if (!held && (trusted || (read.source === 'missing' && !onDisk.length)))
    return { ...read, restored: false, hold: null };

  const { migrated, ...state } = read.state;
  const r = rebuildLibraries({
    dataDir: o.dataDir,
    storageDir: o.storageDir,
    state,
    // From shell.json itself only what it does not name; otherwise everything there is data of.
    ids: trusted ? unnamed : onDisk,
    ...(o.now ? { now: o.now } : {}),
  });
  for (const line of r.lines) o.log(line);
  const reason = trusted
    ? 'held from an earlier start'
    : `shell.json ${read.source === 'backup' ? 'replaced by its backup' : read.source}`;
  const hold = setSelfCheckHold(o.dataDir, reason, o.now?.());
  const added = r.rebuilt.filter((id) => !read.knownIds.has(id));
  if (r.rebuilt.length) {
    o.log(
      `[recovery] ${r.rebuilt.length} libraries rebuilt (${r.rebuilt.join(', ')})${added.length ? `, ${added.length} were not in shell.json` : ''}`,
    );
  }
  if (!trusted || added.length) {
    saveShellState(o.dataDir, r.state);
    o.log('[recovery] shell.json saved with the rebuilt libraries');
  }
  if (!held) o.log(`[self-check] held: ${hold.reason}; nothing is removed until shell.json names every library folder`);
  const knownIds = new Set([...read.knownIds, ...r.rebuilt]);
  const restored = !trusted ? read.source === 'backup' || onDisk.length > 0 : true;
  return {
    state: migrated ? { ...r.state, migrated } : r.state,
    source: read.source,
    knownIds,
    restored,
    hold: { ...hold, unnamed },
  };
}

/** True when a restored state should finish without the first run: the server's settings exist. */
export function shouldFinishRestore(state: ShellState, restored: boolean, envFileExists: boolean): boolean {
  if (!restored || !envFileExists) return false;
  return !isSetupComplete(state) || state.libraries.some((l) => !l.workspaceSlug && !l.deleting);
}

/**
 * What the first run's createLibrary step does, for a restored state: the API key (the stored one
 * when still valid), the default library's workspace and the workspaces of rebuilt libraries,
 * found by name (created only when gone). A failure for the default library throws, so the first
 * run starts instead; another library keeps no workspace and is not watched until the next start.
 */
export async function finishRestore(o: {
  state: ShellState;
  ensureApiKey(stored: string | null): Promise<{ apiKey: string; created: boolean }>;
  ensureDefault(apiKey: string): Promise<string>;
  ensureWorkspace(apiKey: string, libraryId: string): Promise<string>;
  log: (msg: string) => void;
  now?: () => Date;
}): Promise<ShellState> {
  const { apiKey, created } = await o.ensureApiKey(o.state.apiKey);
  o.log(`[recovery] ${created ? 'created an API key' : 'kept the stored API key'}`);
  const libraries: LibraryRecord[] = [];
  for (const lib of o.state.libraries) {
    if (lib.workspaceSlug || lib.deleting) {
      libraries.push(lib);
      continue;
    }
    if (lib.id === DEFAULT_LIBRARY_ID) {
      const slug = await o.ensureDefault(apiKey);
      o.log(`[recovery] ${lib.id}: workspace ${slug}`);
      libraries.push({ ...lib, workspaceSlug: slug });
      continue;
    }
    try {
      const slug = await o.ensureWorkspace(apiKey, lib.id);
      o.log(`[recovery] ${lib.id}: workspace ${slug}`);
      libraries.push({ ...lib, workspaceSlug: slug });
    } catch (e) {
      o.log(
        `[recovery] ${lib.id}: workspace not found or made (${(e as Error).message}); not watched until the next start`,
      );
      libraries.push(lib);
    }
  }
  return {
    ...o.state,
    apiKey,
    libraries,
    setupCompletedAt: o.state.setupCompletedAt ?? (o.now?.() ?? new Date()).toISOString(),
  };
}
