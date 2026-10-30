import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowseIndex } from './browse/index.js';
import { isSupported } from './sections/index.js';
import {
  currentLibraryOf,
  DEFAULT_LIBRARY_ID,
  type FolderSource,
  type LibraryRecord,
  type ShellState,
} from './shell-state.js';
import { loadIndex } from './watcher/index-store.js';
import type { FileEvent, FileRecord, SourceLike, WatchRoot, WatcherStatus } from './watcher/index.js';

/** One source as the library menu lists it: a linked folder or one added file. */
export interface SourceView {
  id: string;
  kind: 'folder' | 'file';
  path: string;
  name: string;
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
}

export interface LibrariesView {
  current: string;
  libraries: LibraryView[];
}

/** Watcher status of the current library as the pages show it. */
export type LibraryStatus = WatcherStatus & { libraryId: string; error?: string };

/** What an add returns to the page: how many sources were added and what was left out, and why. */
export interface AddResult {
  added: number;
  skipped: { name: string; reason: string }[];
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
  createBrowse(o: { dir: string }): BrowseIndex;
  /** Keeps the browse index current from the watcher's file events (browse/index.ts followWatcher). */
  followWatcher(browse: BrowseIndex, watcher: WatcherLike): void;
  onChange(view: LibrariesView): void;
  onStatus(status: LibraryStatus): void;
  log?: (msg: string) => void;
  now?: () => Date;
}

const MAX_NAME = 60;
/** The added files of a library sit in one watched folder; its source id in the document names. */
const FILES_ROOT_ID = 'files';
const FILE_SOURCE_PREFIX = 'file:';

export function libraryDir(dataDir: string, id: string): string {
  return path.join(dataDir, 'libraries', id);
}

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

/** A free file name in dir: report.pdf, then report (2).pdf, report (3).pdf. */
export function freeName(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

/** Copies one file into dir under a free name; a file with the same name and bytes is not copied again. */
export function copyInto(dir: string, file: string): string | null {
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(file);
  const same = path.join(dir, name);
  if (fs.existsSync(same)) {
    const a = fs.readFileSync(same);
    const b = fs.readFileSync(file);
    if (a.equals(b)) return null;
  }
  const to = path.join(dir, freeName(dir, name));
  // COPYFILE_EXCL: never overwrite, even if the name was taken a moment ago.
  fs.copyFileSync(file, to, fs.constants.COPYFILE_EXCL);
  return to;
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
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(filesDir(this.d.dataDir, lib.id), { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      // No file added yet.
    }
    const files: SourceView[] = names.map((name) => ({
      id: `${FILE_SOURCE_PREFIX}${name}`,
      kind: 'file',
      path: path.join(filesDir(this.d.dataDir, lib.id), name),
      name,
      available: true,
    }));
    return [...folders, ...files];
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
    const files = filesDir(this.d.dataDir, lib.id);
    fs.mkdirSync(files, { recursive: true });
    return [
      { id: FILES_ROOT_ID, path: files, label: '' },
      ...lib.folders.map((f) => ({ id: f.id, path: f.path, label: path.basename(f.path) })),
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
    // Loaded before the watcher starts, so the browse pages list the library during a long reconcile.
    const browse = this.d.createBrowse({ dir: path.join(dir, 'browse') });
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

  /** Creates a library with its own workspace and switches to it. */
  create(name: string): Promise<LibrariesView> {
    return this.serial(async () => {
      const s = this.d.getState();
      const clean = checkLibraryName(name, s.libraries);
      let id: string;
      do id = `lib-${randomBytes(3).toString('hex')}`;
      while (s.libraries.some((l) => l.id === id));
      const workspaceSlug = await this.d.workspaces.ensure(id);
      const lib: LibraryRecord = { id, name: clean, workspaceSlug, folders: [], createdAt: this.now().toISOString() };
      this.d.setState({ ...this.d.getState(), libraries: [...this.d.getState().libraries, lib], currentLibrary: id });
      fs.mkdirSync(filesDir(this.d.dataDir, id), { recursive: true });
      await this.restartRuntime();
      this.log(`created ${id} (${clean}), workspace ${workspaceSlug}`);
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
   * Adds dropped or chosen paths to the current library: folders are linked, files copied into the
   * library's own folder. Files of a type AskFiles cannot read are left out and reported.
   */
  addPaths(paths: string[]): Promise<AddResult> {
    return this.serial(async () => {
      const lib = this.current();
      const result: AddResult = { added: 0, skipped: [] };
      const folders: string[] = [];
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
            if (copyInto(filesDir(this.d.dataDir, lib.id), p)) result.added++;
            else result.skipped.push({ name, reason: 'already in this library' });
          } catch (e) {
            result.skipped.push({ name, reason: (e as Error).message });
          }
        }
      }
      const linked = this.linkFolders(folders);
      result.added += linked.added;
      result.skipped.push(...linked.skipped);
      // Added files are seen by the watch on the library's folder; a new folder needs a restart.
      if (linked.added) await this.restartRuntime();
      this.log(`added ${result.added} to ${lib.id}, skipped ${result.skipped.length}`);
      this.changed();
      return result;
    });
  }

  /** Removes a source: a linked folder is unlinked, an added file's copy is deleted. */
  removeSource(sourceId: string): Promise<LibrariesView> {
    return this.serial(async () => {
      const s = this.d.getState();
      const lib = currentLibraryOf(s);
      if (sourceId.startsWith(FILE_SOURCE_PREFIX)) {
        const name = sourceId.slice(FILE_SOURCE_PREFIX.length);
        // Only a file the library lists, so an id from a page can never point outside files/.
        if (!this.sourcesOf(lib).some((x) => x.kind === 'file' && x.name === name)) {
          throw new Error('No such file in this library.');
        }
        // The copy is the library's own; the watch on the folder unindexes it.
        fs.rmSync(path.join(filesDir(this.d.dataDir, lib.id), name), { force: true });
      } else {
        if (!lib.folders.some((f) => f.id === sourceId)) throw new Error('That folder is no longer in this library.');
        this.d.setState({
          ...s,
          libraries: s.libraries.map((l) =>
            l.id === lib.id ? { ...l, folders: l.folders.filter((f) => f.id !== sourceId) } : l,
          ),
        });
        await this.restartRuntime();
      }
      return this.changed();
    });
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
    const result: AddResult = { added: 0, skipped: [] };
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
        this.d.setState({
          ...s,
          libraries: s.libraries.map((l) => (l.id === libraryId ? { ...l, folders: next.folders } : l)),
        });
        for (const r of next.replaced) this.log(`${r.path} replaced by ${folder}, which holds it`);
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
