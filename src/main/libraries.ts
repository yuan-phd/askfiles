import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowseIndex } from './browse/index.js';
import { isSupported } from './sections/index.js';
import {
  currentLibraryOf,
  DEFAULT_LIBRARY_ID,
  type FileSource,
  type FolderSource,
  type LibraryRecord,
  type ShellState,
} from './shell-state.js';
import { loadIndex } from './watcher/index-store.js';
import type { FileEvent, FileRecord, SourceLike, WatchRoot, WatcherStatus } from './watcher/index.js';

/**
 * One source as the library menu and the Sources section list it: a linked folder, an added file
 * (linked by its path), or a copy that a version before linking made in the library's own folder.
 */
export interface SourceView {
  id: string;
  kind: 'folder' | 'file' | 'copy';
  path: string;
  name: string;
  /** False for a folder that cannot be read, and for an added file whose original is gone. */
  available: boolean;
}

export interface LibraryView {
  id: string;
  name: string;
  isDefault: boolean;
  isCurrent: boolean;
  /** Indexed files; for the current library live from the watcher, for others from index.json. */
  indexed: number;
  sources: SourceView[];
  /** The profile id (src/main/graph/profiles.ts); the default when the record has none. */
  profile: string;
  /** The library switch for section summaries (docs/summaries.md). */
  sectionSummaries: boolean;
}

export interface LibrariesView {
  current: string;
  libraries: LibraryView[];
}

/** Watcher status of the current library as the pages show it. */
export type LibraryStatus = WatcherStatus & { libraryId: string; error?: string };

/** An added file with the name of a file already added on its own: the page asks Replace or Keep both. */
export interface AddConflict {
  path: string;
  name: string;
  existing: { id: string; path: string; kind: 'file' | 'copy' };
}

/** The answer to an AddConflict, by the added file's path. */
export type AddDecision = { action: 'replace'; replaces: string } | { action: 'keep' };

/** What an add returns to the page: how many sources were added and what was left out, and why. */
export interface AddResult {
  added: number;
  skipped: { name: string; reason: string }[];
  /** Names of files whose path is already in the library: nothing is done, they are kept up to date. */
  already: string[];
  /** Files not added yet: each waits for Replace or Keep both (addPaths with a decision). */
  conflicts: AddConflict[];
  /** Added although a file inside a linked folder has the same name; both are kept. */
  kept: { name: string; path: string }[];
}

function emptyResult(): AddResult {
  return { added: 0, skipped: [], already: [], conflicts: [], kept: [] };
}

/** The parts of FolderWatcher the manager drives. */
export interface WatcherLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  clearIndex(): Promise<void>;
  status(): WatcherStatus;
  files(): FileRecord[];
  file(path: string): FileRecord | null;
  whenIdle(): Promise<void>;
  resolveSources<T extends SourceLike>(sources: T[]): T[];
  addRoots(roots: WatchRoot[]): Promise<void>;
  removeRoot(id: string): void;
  forget(path: string): void;
  checkNow(): Promise<{ toCheck: number }>;
  on(event: 'status', listener: (s: WatcherStatus) => void): unknown;
  on(event: 'file', listener: (e: FileEvent) => void): unknown;
}

export interface LibraryManagerDeps {
  dataDir: string;
  getState(): ShellState;
  setState(state: ShellState): void;
  /** Server calls; ensure creates the workspace or finds it by name and applies the preset. */
  workspaces: {
    ensure(libraryId: string): Promise<string>;
    remove(slug: string): Promise<void>;
  };
  /** Deletes the library's section documents under STORAGE_DIR/documents. */
  removeDocuments(docsFolder: string): void;
  createWatcher(o: { roots: WatchRoot[]; dataDir: string; docsFolder: string; workspaceSlug: string }): WatcherLike;
  createBrowse(o: { dir: string; libraryId: string }): BrowseIndex;
  /** Keeps the browse index current from the watcher's file events (browse/index.ts followWatcher). */
  followWatcher(browse: BrowseIndex, watcher: WatcherLike): void;
  onChange(view: LibrariesView): void;
  onStatus(status: LibraryStatus): void;
  /** The profile a library without one uses, and the ids a library may choose. */
  profiles?: { defaultId: string; ids: string[] };
  log?: (msg: string) => void;
  now?: () => Date;
}

const MAX_NAME = 60;
/** Copies made by versions before linking sit in one watched folder; its source id in the document names. */
const FILES_ROOT_ID = 'files';
/** Source id of such a copy: the prefix and its file name. */
const COPY_SOURCE_PREFIX = 'file:';
/** Source ids of added files: file-1, file-2. */
const FILE_ID_PREFIX = 'file-';

export function libraryDir(dataDir: string, id: string): string {
  return path.join(dataDir, 'libraries', id);
}

/** The folder of copies that versions before linking made of added files. */
export function filesDir(dataDir: string, id: string): string {
  return path.join(libraryDir(dataDir, id), 'files');
}

/** Folder under STORAGE_DIR/documents for one library's section documents. */
export function docsFolderOf(id: string): string {
  return `askfiles/${id}`;
}

/** A name a user typed: trimmed, whitespace collapsed, 1 to 60 characters, unique ignoring case. */
export function checkLibraryName(name: unknown, taken: { id: string; name: string }[], self?: string): string {
  const n = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (!n) throw new Error('A library needs a name.');
  if (n.length > MAX_NAME) throw new Error(`A library name can have at most ${MAX_NAME} characters.`);
  if (taken.some((l) => l.id !== self && l.name.toLowerCase() === n.toLowerCase())) {
    throw new Error(`There is already a library called ${n}.`);
  }
  return n;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The watch root of an added file. */
function fileRoot(f: FileSource): WatchRoot {
  return { id: f.id, path: f.path, label: '', file: true };
}

/**
 * True when an added file's original is gone while its folder is still there; a folder that
 * cannot be read (an unplugged drive) keeps the file, as it keeps a linked folder's files.
 */
function isGone(p: string): boolean {
  return !fs.existsSync(p) && fs.existsSync(path.dirname(p));
}

function nativeRealOrResolved(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The folder sources after linking folder: refuses a folder that is or lies inside a linked one,
 * and one that holds the data directory or lies inside it (the library would index its own
 * records); linked folders inside the new one are replaced by it.
 */
export function linkFolder(
  folders: FolderSource[],
  folder: string,
  o: { dataDir: string; id: string; addedAt: string },
): { folders: FolderSource[]; replaced: FolderSource[] } {
  const real = realOrResolved(folder);
  const data = realOrResolved(o.dataDir);
  if (isInside(real, data) || isInside(data, real)) {
    throw new Error('This folder holds AskFiles data. Choose a folder of documents, such as Documents.');
  }
  for (const f of folders) {
    if (isInside(real, realOrResolved(f.path))) throw new Error(`${path.basename(real)} is already in this library.`);
  }
  const replaced = folders.filter((f) => isInside(realOrResolved(f.path), real));
  return {
    folders: [...folders.filter((f) => !replaced.includes(f)), { id: o.id, path: real, addedAt: o.addedAt }],
    replaced,
  };
}

/**
 * Version 1 kept index.json and browse/ at the top of the data directory; they move to the default
 * library's folder. The splitter version changed with them, so every file is split again anyway;
 * keeping the old index lets the watcher remove the old section documents by their locations.
 */
export function moveLegacyLibraryFiles(dataDir: string, log: (m: string) => void = () => {}): void {
  const dir = libraryDir(dataDir, DEFAULT_LIBRARY_ID);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['index.json', 'browse']) {
    const from = path.join(dataDir, name);
    const to = path.join(dir, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.renameSync(from, to);
      log(`moved ${from} to ${to}`);
    }
  }
}

/**
 * The libraries (Session K, part 1): records in shell.json, one upstream workspace each, and for the
 * current library a running watcher and browse index. Every change goes through one queue, so a
 * switch, an add and a delete never interleave.
 */
export class LibraryManager {
  private watcher: WatcherLike | null = null;
  private browseIndex: BrowseIndex | null = null;
  private runningId: string | null = null;
  private startError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Added files whose original went away, dropped from the record together (onFileEvent). */
  private readonly gone = new Set<string>();
  private goneTimer: NodeJS.Timeout | null = null;
  private readonly log: (msg: string) => void;
  private readonly now: () => Date;

  constructor(private readonly d: LibraryManagerDeps) {
    this.log = (m) => (d.log ?? (() => {}))(`[libraries] ${m}`);
    this.now = d.now ?? (() => new Date());
  }

  // --- reads ---------------------------------------------------------------------------------

  current(): LibraryRecord {
    return currentLibraryOf(this.d.getState());
  }

  watcherOf(): WatcherLike | null {
    return this.watcher;
  }

  browse(): BrowseIndex | null {
    return this.browseIndex;
  }

  view(): LibrariesView {
    const s = this.d.getState();
    return {
      current: s.currentLibrary,
      libraries: s.libraries.map((l) => ({
        id: l.id,
        name: l.name,
        isDefault: l.id === DEFAULT_LIBRARY_ID,
        isCurrent: l.id === s.currentLibrary,
        indexed: l.id === this.runningId && this.watcher ? this.watcher.status().indexed : this.indexedCount(l.id),
        sources: this.sourcesOf(l),
        profile: this.profileOf(l),
        sectionSummaries: l.sectionSummaries === true,
      })),
    };
  }

  status(): LibraryStatus {
    const lib = this.current();
    const base: WatcherStatus = this.watcher?.status() ?? {
      state: 'stopped',
      pending: 0,
      current: null,
      indexed: this.indexedCount(lib.id),
      deadLetters: [],
      unavailable: [],
    };
    const n = base.unavailable.length;
    const error =
      this.startError ??
      (n ? (n === 1 ? `${base.unavailable[0]} is not available` : `${n} folders are not available`) : null);
    return { ...base, libraryId: lib.id, ...(error ? { error } : {}) };
  }

  /** The library's profile id: its own when it is still offered, else the default. */
  profileOf(lib: LibraryRecord): string {
    const p = this.d.profiles;
    if (!p) return lib.profile ?? 'legal-finance';
    return lib.profile && p.ids.includes(lib.profile) ? lib.profile : p.defaultId;
  }

  /** True when the library has no source at all: the pages show the empty state. */
  isEmpty(id = this.d.getState().currentLibrary): boolean {
    const lib = this.d.getState().libraries.find((l) => l.id === id);
    return !lib || this.sourcesOf(lib).length === 0;
  }

  private indexedCount(id: string): number {
    try {
      return Object.keys(loadIndex(path.join(libraryDir(this.d.dataDir, id), 'index.json')).files).length;
    } catch {
      return 0;
    }
  }

  private sourcesOf(lib: LibraryRecord): SourceView[] {
    const folders: SourceView[] = lib.folders.map((f) => ({
      id: f.id,
      kind: 'folder',
      path: f.path,
      name: path.basename(f.path),
      available: fs.existsSync(f.path),
    }));
    const files: SourceView[] = (lib.files ?? []).map((f) => ({
      id: f.id,
      kind: 'file',
      path: f.path,
      name: path.basename(f.path),
      available: fs.existsSync(f.path),
    }));
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(filesDir(this.d.dataDir, lib.id), { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      // No copies: the library was made after added files were linked.
    }
    const copies: SourceView[] = names.map((name) => ({
      id: `${COPY_SOURCE_PREFIX}${name}`,
      kind: 'copy',
      path: path.join(filesDir(this.d.dataDir, lib.id), name),
      name,
      available: true,
    }));
    const single = [...files, ...copies].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return [...folders, ...single];
  }

  // --- runtime -------------------------------------------------------------------------------

  /** Starts the watcher and browse index of the current library. */
  start(): Promise<void> {
    return this.serial(() => this.startRuntime());
  }

  /** Stops the watcher; queued work is picked up by the next start (quit, backend restart). */
  stop(): Promise<void> {
    return this.serial(() => this.stopRuntime());
  }

  /** Pauses and resumes the running watcher without rebuilding it (backend restart). */
  async pause(): Promise<void> {
    await this.watcher?.stop();
  }

  async resume(): Promise<void> {
    await this.watcher?.start();
  }

  private roots(lib: LibraryRecord): WatchRoot[] {
    const copies = filesDir(this.d.dataDir, lib.id);
    return [
      ...(fs.existsSync(copies) ? [{ id: FILES_ROOT_ID, path: copies, label: '' }] : []),
      ...lib.folders.map((f) => ({ id: f.id, path: f.path, label: path.basename(f.path) })),
      ...(lib.files ?? []).map((f) => fileRoot(f)),
    ];
  }

  private async startRuntime(): Promise<void> {
    if (this.watcher) return;
    const lib = this.current();
    if (!lib.workspaceSlug) {
      this.log(`library ${lib.id} has no workspace yet; not watching`);
      return;
    }
    const dir = libraryDir(this.d.dataDir, lib.id);
    const watcher = this.d.createWatcher({
      roots: this.roots(lib),
      dataDir: dir,
      docsFolder: docsFolderOf(lib.id),
      workspaceSlug: lib.workspaceSlug,
    });
    watcher.on('status', () => this.d.onStatus(this.status()));
    watcher.on('file', (e) => this.onFileEvent(lib.id, e));
    // Loaded before the watcher starts, so the browse pages list the library during a long reconcile.
    const browse = this.d.createBrowse({ dir: path.join(dir, 'browse'), libraryId: lib.id });
    try {
      browse.load();
    } catch (e) {
      this.log(`browse index of ${lib.id} not loaded: ${(e as Error).message}`);
    }
    this.d.followWatcher(browse, watcher);
    this.browseIndex = browse;
    this.startError = null;
    try {
      await watcher.start();
    } catch (e) {
      this.startError = `The library could not be read: ${(e as Error).message}`;
      this.log(`watcher of ${lib.id} not started: ${(e as Error).message}`);
      this.d.onStatus(this.status());
      return;
    }
    this.watcher = watcher;
    this.runningId = lib.id;
    this.dropMissing(lib.id);
    try {
      // Files unchanged since the last run send no event; this catches them and anything stale.
      browse.sync(watcher.files());
    } catch (e) {
      this.log(`browse sync of ${lib.id} failed: ${(e as Error).message}`);
    }
    this.log(`library ${lib.id} running`);
    this.d.onStatus(this.status());
  }

  private async stopRuntime(): Promise<void> {
    const w = this.watcher;
    this.watcher = null;
    this.runningId = null;
    await w?.stop();
  }

  private async restartRuntime(): Promise<void> {
    await this.stopRuntime();
    this.browseIndex = null;
    await this.startRuntime();
  }

  // --- changes -------------------------------------------------------------------------------

  /** Shows another library: its watcher replaces the current one. */
  select(id: string): Promise<LibrariesView> {
    return this.serial(async () => {
      const s = this.d.getState();
      if (!s.libraries.some((l) => l.id === id)) throw new Error('That library no longer exists.');
      if (s.currentLibrary !== id) {
        this.d.setState({ ...s, currentLibrary: id });
        await this.restartRuntime();
        this.log(`switched to ${id}`);
      }
      return this.changed();
    });
  }

  /** Creates a library with its own workspace and profile (the default when none is given) and switches to it. */
  create(name: string, profile?: string | null): Promise<LibrariesView> {
    return this.serial(async () => {
      const s = this.d.getState();
      const clean = checkLibraryName(name, s.libraries);
      const ids = this.d.profiles?.ids;
      if (profile && ids && !ids.includes(profile)) throw new Error('That kind of library is not available.');
      let id: string;
      do id = `lib-${randomBytes(3).toString('hex')}`;
      while (s.libraries.some((l) => l.id === id));
      const workspaceSlug = await this.d.workspaces.ensure(id);
      const lib: LibraryRecord = {
        id,
        name: clean,
        workspaceSlug,
        folders: [],
        createdAt: this.now().toISOString(),
        profile: profile || this.d.profiles?.defaultId || 'legal-finance',
      };
      this.d.setState({ ...this.d.getState(), libraries: [...this.d.getState().libraries, lib], currentLibrary: id });
      await this.restartRuntime();
      this.log(`created ${id} (${clean}), workspace ${workspaceSlug}`);
      return this.changed();
    });
  }

  /**
   * Changes a library's own record (profile, type overrides, family answers, the section summary
   * switch) without touching its index. change gets the record and returns the new one.
   */
  updateRecord(id: string, change: (lib: LibraryRecord) => LibraryRecord): Promise<LibrariesView> {
    return this.serial(async () => {
      const s = this.d.getState();
      const lib = s.libraries.find((l) => l.id === id);
      if (!lib) throw new Error('That library no longer exists.');
      const next = {
        ...change(lib),
        id: lib.id,
        name: lib.name,
        workspaceSlug: lib.workspaceSlug,
        folders: lib.folders,
        ...(lib.files ? { files: lib.files } : {}),
        ...(lib.lastFileId ? { lastFileId: lib.lastFileId } : {}),
      };
      this.d.setState({ ...s, libraries: s.libraries.map((l) => (l.id === id ? next : l)) });
      return this.changed();
    });
  }

  rename(id: string, name: string): Promise<LibrariesView> {
    return this.serial(async () => {
      if (id === DEFAULT_LIBRARY_ID) throw new Error('All files cannot be renamed.');
      const s = this.d.getState();
      if (!s.libraries.some((l) => l.id === id)) throw new Error('That library no longer exists.');
      const clean = checkLibraryName(name, s.libraries, id);
      this.d.setState({ ...s, libraries: s.libraries.map((l) => (l.id === id ? { ...l, name: clean } : l)) });
      return this.changed();
    });
  }

  /**
   * Deletes a library: its workspace (vectors included), its section documents, its index, browse
   * index and the copies of added files. Linked folders and the original files are never touched.
   */
  remove(id: string): Promise<LibrariesView> {
    return this.serial(async () => {
      if (id === DEFAULT_LIBRARY_ID) throw new Error('All files cannot be deleted.');
      const s = this.d.getState();
      const lib = s.libraries.find((l) => l.id === id);
      if (!lib) throw new Error('That library no longer exists.');
      if (s.currentLibrary === id) {
        this.d.setState({ ...s, currentLibrary: DEFAULT_LIBRARY_ID });
        await this.restartRuntime();
      }
      if (lib.workspaceSlug) await this.d.workspaces.remove(lib.workspaceSlug);
      this.d.removeDocuments(docsFolderOf(id));
      fs.rmSync(libraryDir(this.d.dataDir, id), { recursive: true, force: true });
      const now = this.d.getState();
      this.d.setState({ ...now, libraries: now.libraries.filter((l) => l.id !== id) });
      this.log(`deleted ${id}`);
      return this.changed();
    });
  }

  /** Links a folder into the current library; it is watched and never modified. */
  addFolder(folder: string): Promise<AddResult> {
    return this.serial(async () => {
      const r = this.linkFolders([folder]);
      if (r.added) await this.restartRuntime();
      this.changed();
      return r;
    });
  }

  /**
   * Adds dropped or chosen paths to the current library: folders and files are linked by their
   * paths and watched, never copied or modified. Files of a type AskFiles cannot read are left out
   * and reported. A file whose name matches a file added on its own is not added until the page
   * passes a decision for its path (Replace or Keep both); one matching a file inside a linked
   * folder is added, and both are kept.
   */
  addPaths(paths: string[], decisions: Record<string, AddDecision> = {}): Promise<AddResult> {
    return this.serial(async () => {
      const libId = this.d.getState().currentLibrary;
      const result = emptyResult();
      const folders: string[] = [];
      const added: WatchRoot[] = [];
      for (const p of paths) {
        const name = path.basename(p);
        let st: fs.Stats;
        try {
          st = fs.statSync(p);
        } catch {
          result.skipped.push({ name, reason: 'not found' });
          continue;
        }
        if (st.isDirectory()) folders.push(p);
        else if (!st.isFile()) result.skipped.push({ name, reason: 'not a file' });
        else if (!isSupported(p)) result.skipped.push({ name, reason: 'not a type AskFiles can read' });
        else {
          try {
            const root = this.linkFile(libId, p, decisions[p], result);
            if (root) added.push(root);
          } catch (e) {
            result.skipped.push({ name, reason: (e as Error).message });
          }
        }
      }
      const linked = this.linkFolders(folders, libId);
      result.added += linked.added;
      result.skipped.push(...linked.skipped);
      // A new folder needs a restart; added files are watched by the running watcher at once.
      if (linked.added) await this.restartRuntime();
      else if (added.length && this.watcher && this.runningId === libId) await this.watcher.addRoots(added);
      this.log(
        `added ${result.added} to ${libId}, skipped ${result.skipped.length}, already in ${result.already.length}, asking about ${result.conflicts.length}`,
      );
      this.changed();
      return result;
    });
  }

  /** Links one file into the library's record; the root to watch, or null when nothing was added. */
  private linkFile(
    libId: string,
    file: string,
    decision: AddDecision | undefined,
    result: AddResult,
  ): WatchRoot | null {
    const name = path.basename(file);
    // The native realpath gives the name as stored on disk, so Report.pdf and report.pdf on a
    // case-insensitive Mac volume are one path, and the path matches what the watch reports.
    const real = nativeRealOrResolved(file);
    if (isInside(real, realOrResolved(this.d.dataDir))) throw new Error('this file is AskFiles data');
    const lib = this.libraryOf(libId);
    if (
      (lib.files ?? []).some((f) => f.path === real) ||
      lib.folders.some((f) => isInside(real, realOrResolved(f.path)))
    ) {
      result.already.push(name);
      return null;
    }
    const lower = name.toLowerCase();
    const sameName = this.sourcesOf(lib).filter(
      (x): x is SourceView & { kind: 'file' | 'copy' } =>
        (x.kind === 'file' || x.kind === 'copy') && x.name.toLowerCase() === lower,
    );
    if (sameName.length) {
      if (!decision) {
        const first = sameName[0]!;
        result.conflicts.push({ path: file, name, existing: { id: first.id, path: first.path, kind: first.kind } });
        return null;
      }
      if (decision.action === 'replace') {
        const target = sameName.find((x) => x.id === decision.replaces);
        if (!target) throw new Error('the file to replace is no longer in this library');
        this.dropSource(libId, target);
        this.log(`${target.path} replaced by ${real}`);
      }
    } else {
      const inFolder = this.folderFileNamed(lib, lower);
      if (inFolder) result.kept.push({ name, path: inFolder });
    }
    // Never an id used before in this library: a removed file's queued removal goes by its id.
    const used = (this.libraryOf(libId).files ?? []).map((f) => Number(f.id.slice(FILE_ID_PREFIX.length)) || 0);
    const n = Math.max(0, this.libraryOf(libId).lastFileId ?? 0, ...used) + 1;
    const source: FileSource = { id: `${FILE_ID_PREFIX}${n}`, path: real, addedAt: this.now().toISOString() };
    this.setLibrary(libId, (l) => ({ ...l, files: [...(l.files ?? []), source], lastFileId: n }));
    result.added++;
    return fileRoot(source);
  }

  /** The path of a file inside a linked folder of lib with this name (lower case), or null. */
  private folderFileNamed(lib: LibraryRecord, lower: string): string | null {
    if (!lib.folders.length) return null;
    const ids = new Set(lib.folders.map((f) => f.id));
    const files =
      this.runningId === lib.id && this.watcher
        ? this.watcher.files()
        : Object.values(loadIndex(path.join(libraryDir(this.d.dataDir, lib.id), 'index.json')).files);
    return files.find((f) => ids.has(f.sourceId) && path.basename(f.path).toLowerCase() === lower)?.path ?? null;
  }

  /**
   * Takes an added file or a copy out of the library: the record, then its sections, vectors,
   * browse entry, summaries, export page and graph node through the watcher's removal of the file.
   */
  private dropSource(libId: string, source: SourceView): void {
    const running = this.runningId === libId ? this.watcher : null;
    if (source.kind === 'copy') {
      // The copy is the library's own.
      fs.rmSync(source.path, { force: true });
      running?.forget(source.path);
      return;
    }
    this.setLibrary(libId, (l) => ({ ...l, files: (l.files ?? []).filter((f) => f.id !== source.id) }));
    running?.removeRoot(source.id);
  }

  /** Removes a source: a linked folder or an added file is unlinked, a copy is deleted. */
  removeSource(sourceId: string): Promise<LibrariesView> {
    return this.serial(async () => {
      const lib = this.current();
      // Only a source the library lists, so an id from a page can never point outside it.
      const source = this.sourcesOf(lib).find((x) => x.id === sourceId);
      if (source?.kind === 'file' || source?.kind === 'copy') {
        this.dropSource(lib.id, source);
      } else if (source?.kind === 'folder') {
        this.setLibrary(lib.id, (l) => ({ ...l, folders: l.folders.filter((f) => f.id !== sourceId) }));
        await this.restartRuntime();
      } else if (sourceId.startsWith(COPY_SOURCE_PREFIX) || sourceId.startsWith(FILE_ID_PREFIX)) {
        throw new Error('No such file in this library.');
      } else {
        throw new Error('That folder is no longer in this library.');
      }
      return this.changed();
    });
  }

  /**
   * Check for updates: the start-up comparison now for every source of the current library. The
   * status it returns says working while changed files are indexed, else up to date.
   */
  checkUpdates(): Promise<LibraryStatus> {
    return this.serial(async () => {
      // A library whose watcher could not start gets another try: its folder may be back.
      if (!this.watcher) await this.startRuntime();
      const r = await this.watcher?.checkNow();
      this.dropMissing(this.current().id);
      this.log(`check for updates in ${this.current().id}: ${r?.toCheck ?? 0} to look at`);
      return this.status();
    });
  }

  /**
   * An added file whose original was deleted or moved left the index: it leaves the library too,
   * like a file deleted from a linked folder. Batched, since a folder of them may go at once.
   */
  private onFileEvent(libId: string, e: FileEvent): void {
    if (e.outcome !== 'removed') return;
    const source = (this.libraryOf(libId, false)?.files ?? []).find((f) => f.path === e.path);
    if (!source || !isGone(source.path)) return;
    this.gone.add(`${libId}\u0000${source.id}`);
    if (this.goneTimer) return;
    this.goneTimer = setTimeout(() => {
      this.goneTimer = null;
      const ids = [...this.gone];
      this.gone.clear();
      void this.serial(async () => {
        for (const key of ids) {
          const [lib, id] = key.split('\u0000') as [string, string];
          this.dropFileRecord(lib, id);
        }
        this.changed();
      });
    }, 100);
  }

  /** Added files whose original is gone and that have no index record, so no removal event comes. */
  private dropMissing(libId: string): void {
    const lib = this.libraryOf(libId, false);
    const w = this.runningId === libId ? this.watcher : null;
    const missing = (lib?.files ?? []).filter((f) => isGone(f.path) && !w?.file(f.path));
    for (const f of missing) this.dropFileRecord(libId, f.id);
    if (missing.length) this.changed();
  }

  private dropFileRecord(libId: string, id: string): void {
    const lib = this.libraryOf(libId, false);
    const f = lib?.files?.find((x) => x.id === id);
    if (!f) return;
    this.setLibrary(libId, (l) => ({ ...l, files: (l.files ?? []).filter((x) => x.id !== id) }));
    if (this.runningId === libId) this.watcher?.removeRoot(id);
    this.log(`${f.path} is gone; removed from ${libId}`);
  }

  private libraryOf(id: string): LibraryRecord;
  private libraryOf(id: string, required: false): LibraryRecord | undefined;
  private libraryOf(id: string, required = true): LibraryRecord | undefined {
    const lib = this.d.getState().libraries.find((l) => l.id === id);
    if (!lib && required) throw new Error('That library no longer exists.');
    return lib;
  }

  private setLibrary(id: string, change: (l: LibraryRecord) => LibraryRecord): void {
    const s = this.d.getState();
    this.d.setState({ ...s, libraries: s.libraries.map((l) => (l.id === id ? change(l) : l)) });
  }

  /** Splits and embeds every file of the current library again. */
  reindex(): Promise<LibrariesView> {
    return this.serial(async () => {
      const lib = this.current();
      await this.stopRuntime();
      // A watcher only for clearing, so a library whose watcher could not start can still be reset.
      if (lib.workspaceSlug) {
        const w = this.d.createWatcher({
          roots: this.roots(lib),
          dataDir: libraryDir(this.d.dataDir, lib.id),
          docsFolder: docsFolderOf(lib.id),
          workspaceSlug: lib.workspaceSlug,
        });
        await w.clearIndex();
      }
      // Every section document of the library, also those no record or workspace lists any more.
      this.d.removeDocuments(docsFolderOf(lib.id));
      fs.rmSync(path.join(libraryDir(this.d.dataDir, lib.id), 'browse'), { recursive: true, force: true });
      this.browseIndex = null;
      this.log(`reindexing ${lib.id}`);
      await this.startRuntime();
      return this.changed();
    });
  }

  /** ASKFILES_LIBRARY_FOLDER: linked into All files once, when it holds no folder yet (smoke test). */
  linkPresetFolder(folder: string): Promise<void> {
    return this.serial(async () => {
      const def = this.d.getState().libraries[0]!;
      if (def.folders.length) return;
      const r = this.linkFolders([folder], DEFAULT_LIBRARY_ID);
      for (const s of r.skipped) this.log(`preset folder ${folder} not linked: ${s.reason}`);
      if (r.added && this.d.getState().currentLibrary === DEFAULT_LIBRARY_ID) await this.restartRuntime();
    });
  }

  private linkFolders(folders: string[], libraryId = this.d.getState().currentLibrary): AddResult {
    const result = emptyResult();
    for (const folder of folders) {
      const s = this.d.getState();
      const lib = s.libraries.find((l) => l.id === libraryId)!;
      try {
        if (!fs.statSync(folder).isDirectory()) throw new Error('not a folder');
        let n = lib.folders.length + 1;
        while (lib.folders.some((f) => f.id === `folder-${n}`)) n++;
        const next = linkFolder(lib.folders, folder, {
          dataDir: this.d.dataDir,
          id: `folder-${n}`,
          addedAt: this.now().toISOString(),
        });
        // Added files inside the folder are now its files; they leave the list of added files.
        const real = realOrResolved(folder);
        const inside = (lib.files ?? []).filter((f) => isInside(realOrResolved(f.path), real));
        this.d.setState({
          ...s,
          libraries: s.libraries.map((l) =>
            l.id === libraryId
              ? {
                  ...l,
                  folders: next.folders,
                  ...(l.files ? { files: l.files.filter((f) => !inside.includes(f)) } : {}),
                }
              : l,
          ),
        });
        for (const r of next.replaced) this.log(`${r.path} replaced by ${folder}, which holds it`);
        for (const f of inside) this.log(`${f.path} now comes from ${folder}, which holds it`);
        result.added++;
      } catch (e) {
        result.skipped.push({ name: path.basename(folder), reason: (e as Error).message });
      }
    }
    return result;
  }

  private changed(): LibrariesView {
    const v = this.view();
    this.d.onChange(v);
    return v;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
