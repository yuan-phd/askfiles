import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sectionDocuments } from '../sections/index.js';
import { isHidden, isIndexable, SUPPORTED_EXTENSIONS } from './file-types.js';
import { loadIndex, saveIndex } from './index-store.js';
import { DOCS_FOLDER, hashFile, readSectionText, writeSectionDocument } from './section-docs.js';
import { createSourceResolver, type SourceLike } from './sources.js';
import type {
  DeadLetter,
  FileEvent,
  FileRecord,
  IndexData,
  JobKind,
  LibraryApi,
  SectionRecord,
  Splitter,
  WatchFactory,
  WatchHandle,
  WatcherStatus,
} from './types.js';

/** One folder the watcher reads: a linked folder, or a library's own folder of added files. */
export interface WatchRoot {
  /** Stable id; part of every document name, so equal files under two roots never share a name. */
  id: string;
  path: string;
  /** Shown before the path inside the root (the folder's name); empty for the added files. */
  label: string;
}

export interface FolderWatcherOptions {
  /** Folders to watch recursively; never modified. Give roots, or root for a single folder. */
  roots?: WatchRoot[];
  root?: string;
  /** index.json is written here: the library's folder under the data directory. */
  dataDir: string;
  /** STORAGE_DIR of the server; section documents go to <storageDir>/documents/<docsFolder>. */
  storageDir: string;
  /** Folder under STORAGE_DIR/documents for this library's section documents. Default askfiles. */
  docsFolder?: string;
  workspaceSlug: string;
  api: LibraryApi;
  splitter: Splitter;
  watch: WatchFactory;
  extensions?: readonly string[];
  /** Quiet time per path before it is looked at. Default 2000. */
  debounceMs?: number;
  /** A file whose size changed within this time is not indexed yet. Default 2000. */
  stableMs?: number;
  /** One entry per retry; after the last one the job goes to the dead-letter list. Default 1, 4, 16 s. */
  retryDelaysMs?: number[];
  log?: (msg: string) => void;
  now?: () => Date;
}

interface Job {
  path: string;
  kind: JobKind;
  attempt: number;
}

type Outcome = { outcome: 'indexed' | 'unchanged' | 'removed'; sections?: number };

export class FolderWatcher extends EventEmitter<{ status: [WatcherStatus]; file: [FileEvent]; watchError: [Error] }> {
  private readonly o: Required<Omit<FolderWatcherOptions, 'log' | 'now' | 'root' | 'roots' | 'docsFolder'>> & {
    log: (msg: string) => void;
    now: () => Date;
  };
  private readonly indexFile: string;
  private readonly docsFolder: string;
  /** The roots as given, and as watched: real paths of those that could be read at start. */
  private readonly given: WatchRoot[];
  private roots: WatchRoot[] = [];
  private unavailable: WatchRoot[] = [];
  private data: IndexData = { version: 1, files: {} };
  private handle: WatchHandle | null = null;
  private state: WatcherStatus['state'] = 'stopped';
  /** Paths in the debounce stage, with the size seen when the timer was set (-1: missing). */
  private readonly settling = new Map<string, { timer: NodeJS.Timeout; size: number }>();
  private readonly queue: Job[] = [];
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private readonly dead = new Map<string, DeadLetter>();
  private current: Job | null = null;
  private running: Promise<void> | null = null;
  private readonly idleWaiters: (() => void)[] = [];
  readonly resolveSources: <T extends SourceLike>(sources: T[]) => T[];

  constructor(options: FolderWatcherOptions) {
    super();
    this.o = {
      ...options,
      extensions: options.extensions ?? SUPPORTED_EXTENSIONS,
      debounceMs: options.debounceMs ?? 2000,
      stableMs: options.stableMs ?? 2000,
      retryDelaysMs: options.retryDelaysMs ?? [1000, 4000, 16000],
      log: options.log ?? ((msg) => console.log(`[watcher] ${msg}`)),
      now: options.now ?? (() => new Date()),
    };
    const roots = options.roots ?? (options.root ? [{ id: '', path: options.root, label: '' }] : []);
    this.given = roots.map((r) => ({ ...r, path: path.resolve(r.path) }));
    this.docsFolder = options.docsFolder ?? DOCS_FOLDER;
    this.indexFile = path.join(options.dataDir, 'index.json');
    this.resolveSources = createSourceResolver({
      files: () => Object.values(this.data.files),
      readText: (location) => readSectionText(this.o.storageDir, location),
    });
  }

  /**
   * Loads index.json, starts watching, then queues the differences between folders and index. A
   * folder that cannot be read (an unplugged drive) is listed in status().unavailable and its
   * files stay in the index until it is back or removed from the library.
   */
  async start(): Promise<void> {
    if (this.state !== 'stopped') throw new Error(`start() called while ${this.state}`);
    this.state = 'starting';
    this.roots = [];
    this.unavailable = [];
    for (const r of this.given) {
      try {
        // realpath so the paths the watch reports match the keys in index.json (macOS /var is /private/var).
        const real = fs.realpathSync(r.path);
        if (!fs.statSync(real).isDirectory()) throw new Error('not a folder');
        this.roots.push({ ...r, path: real });
      } catch (e) {
        this.unavailable.push(r);
        this.o.log(`folder not available: ${r.path} (${(e as Error).message})`);
      }
    }
    this.data = loadIndex(this.indexFile, this.o.log);
    this.o.log(
      `watching ${this.roots.length} of ${this.given.length} folders, ${Object.keys(this.data.files).length} files in index`,
    );
    // Watch before walking, so nothing written during the walk is missed. chokidar treats files
    // that appear before it is ready as initial and, with ignoreInitial, never reports them.
    const handles = this.roots.map((r) =>
      this.o.watch(
        r.path,
        (_type, p) => this.onPath(p),
        (err) => {
          // Not 'error': an EventEmitter throws on an 'error' event nobody listens to.
          this.o.log(`watch error: ${err.message}`);
          this.emit('watchError', err);
        },
      ),
    );
    this.handle = {
      ready: Promise.all(handles.map((h) => h.ready)).then(() => undefined),
      close: () => Promise.all(handles.map((h) => h.close())).then(() => undefined),
    };
    await this.handle.ready;
    await this.reconcile();
    this.state = 'idle';
    this.kick();
    this.emitStatus();
  }

  /** Stops watching and waits for the job in progress. Queued work is picked up by the next start. */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    for (const { timer } of this.settling.values()) clearTimeout(timer);
    this.settling.clear();
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    this.queue.length = 0;
    await this.handle?.close();
    this.handle = null;
    await this.running;
    this.o.log('stopped');
    this.flushIdle();
  }

  status(): WatcherStatus {
    return {
      state: this.state === 'idle' && !this.isIdle() ? 'working' : this.state,
      pending: this.settling.size + this.queue.length + this.retryTimers.size + (this.current ? 1 : 0),
      current: this.current?.path ?? null,
      indexed: Object.keys(this.data.files).length,
      deadLetters: [...this.dead.values()],
      unavailable: this.unavailable.map((r) => r.path),
    };
  }

  /**
   * Forgets every indexed file: unembeds and deletes its section documents and empties index.json,
   * so the next start indexes everything again (Reindex). Only while stopped.
   */
  async clearIndex(): Promise<void> {
    if (this.state !== 'stopped') throw new Error(`clearIndex() called while ${this.state}`);
    this.data = loadIndex(this.indexFile, this.o.log);
    const locations = Object.values(this.data.files).flatMap((f) => f.sections.map((s) => s.location));
    await this.o.api.removeDocuments(this.o.workspaceSlug, locations);
    this.data = { version: 1, files: {} };
    this.dead.clear();
    this.save();
    this.o.log(`index cleared, ${locations.length} section documents removed`);
  }

  /** The watched root that holds p (the deepest one), or null. */
  private rootOf(p: string): WatchRoot | null {
    let best: WatchRoot | null = null;
    for (const r of this.roots) {
      const rel = path.relative(r.path, p);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && (!best || r.path.length > best.path.length))
        best = r;
    }
    return best;
  }

  /** p under its root, with the root's label in front: what the browse pages show. */
  private relPathOf(p: string, r: WatchRoot): string {
    const rel = path.relative(r.path, p);
    return r.label ? path.join(r.label, rel) : rel;
  }

  /** A copy of the index, for the status bar and the browse view. */
  files(): FileRecord[] {
    return structuredClone(Object.values(this.data.files));
  }

  /** A copy of one file's record, or null when the file is not in the index. */
  file(filePath: string): FileRecord | null {
    const rec = this.data.files[filePath];
    return rec ? structuredClone(rec) : null;
  }

  /** Resolves once nothing is settling, queued, waiting for a retry or running. */
  whenIdle(): Promise<void> {
    if (this.isIdle() || this.state === 'stopped') return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.settling.size === 0 && this.queue.length === 0 && this.retryTimers.size === 0 && !this.current;
  }

  private onPath(p: string): void {
    const r = this.rootOf(p);
    if (this.state === 'stopped' || !r || !isIndexable(p, r.path, this.o.extensions)) return;
    this.settle(p);
  }

  /**
   * Every event, delete included, goes through the same quiet period: editors save by writing a
   * temp file and renaming it, which shows up as unlink then add, and must not re-embed the file.
   */
  private settle(p: string, delayMs = this.o.debounceMs): void {
    const prev = this.settling.get(p);
    if (prev) clearTimeout(prev.timer);
    const size = sizeOf(p);
    const timer = setTimeout(() => this.settled(p, size), delayMs);
    this.settling.set(p, { timer, size });
    this.emitStatus();
  }

  private settled(p: string, seenSize: number): void {
    this.settling.delete(p);
    if (this.state === 'stopped') return;
    const size = sizeOf(p);
    if (size === -1) {
      this.enqueue(p, 'remove');
    } else if (size !== seenSize) {
      // Still being written: wait until the size holds still for stableMs.
      this.settle(p, this.o.stableMs);
    } else {
      this.enqueue(p, 'upsert');
    }
  }

  private enqueue(p: string, kind: JobKind): void {
    this.dead.delete(p);
    const queued = this.queue.find((j) => j.path === p);
    if (queued) {
      queued.kind = kind;
      queued.attempt = 0;
    } else {
      this.queue.push({ path: p, kind, attempt: 0 });
    }
    this.kick();
    this.emitStatus();
  }

  private kick(): void {
    if (this.running || this.state === 'stopped' || this.state === 'starting') return;
    const job = this.queue.shift();
    if (!job) {
      this.emitStatus();
      this.flushIdle();
      return;
    }
    this.current = job;
    this.emitStatus();
    this.running = this.runJob(job).finally(() => {
      this.current = null;
      this.running = null;
      this.kick();
    });
  }

  private async runJob(job: Job): Promise<void> {
    try {
      const r = job.kind === 'upsert' ? await this.upsert(job.path) : await this.remove(job.path);
      this.o.log(`${r.outcome} ${job.path}${r.sections !== undefined ? ` (${r.sections} sections)` : ''}`);
      this.emit('file', { path: job.path, kind: job.kind, ...r });
    } catch (e) {
      const error = (e as Error).message;
      const attempt = job.attempt + 1;
      const delay = this.o.retryDelaysMs[attempt - 1];
      if (delay === undefined || this.state === 'stopped') {
        const letter: DeadLetter = {
          path: job.path,
          kind: job.kind,
          error,
          attempts: attempt,
          at: this.o.now().toISOString(),
        };
        this.dead.set(job.path, letter);
        this.o.log(`dead-letter ${job.kind} ${job.path} after ${attempt} attempts: ${error}`);
        this.emit('file', { path: job.path, kind: job.kind, outcome: 'dead-letter', attempt, error });
        return;
      }
      this.o.log(`retry ${attempt} of ${job.kind} ${job.path} in ${delay} ms: ${error}`);
      this.emit('file', { path: job.path, kind: job.kind, outcome: 'retrying', attempt, error });
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        // A newer event for the same path already queued fresh work.
        if (this.state !== 'stopped' && !this.queue.some((j) => j.path === job.path)) {
          this.queue.push({ ...job, attempt });
        }
        this.kick();
      }, delay);
      this.retryTimers.add(timer);
    }
  }

  private async upsert(p: string): Promise<Outcome> {
    let st: fs.Stats;
    try {
      st = await fsp.stat(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.remove(p);
      throw e;
    }
    if (!st.isFile()) return { outcome: 'unchanged' };
    const root = this.rootOf(p);
    if (!root) return this.remove(p);
    const hash = await hashFile(p);
    const old = this.data.files[p];
    const { splitKey } = this.o.splitter;
    const relPath = this.relPathOf(p, root);
    if (old && old.hash === hash && old.splitKey === splitKey && old.relPath === relPath) {
      if (old.size !== st.size || old.mtimeMs !== st.mtimeMs) {
        this.data.files[p] = { ...old, size: st.size, mtimeMs: st.mtimeMs };
        this.save();
      }
      return { outcome: 'unchanged', sections: old.sections.length };
    }

    const chunks = (await this.o.splitter.split(p)).filter((c) => c.text.trim() !== '');
    // Names depend on path, bytes, split key and chunk position only: a changed file gets all new
    // names and is embedded afresh; an unchanged one keeps them (src/main/sections/documents.ts).
    const rel = path.relative(root.path, p);
    const docs = sectionDocuments(
      chunks,
      { path: p, relPath: root.id ? `${root.id}/${rel}` : rel, hash },
      { splitKey, published: this.o.now().toLocaleString('en-US') },
    );
    const oldByLocation = new Map((old?.sections ?? []).map((s) => [s.location, s]));
    const records: SectionRecord[] = [];
    for (const [i, { name, doc }] of docs.entries()) {
      const location = `${this.docsFolder}/${name}`;
      if (readSectionText(this.o.storageDir, location) === null) writeSectionDocument(this.o.storageDir, location, doc);
      // Path and labels live only here, not in the document: LanceDB fixes a table's columns from
      // its first rows, so the document JSON keeps the keys it had (src/main/sections/documents.ts).
      const c = chunks[i]!;
      records.push({
        location,
        docId: null,
        sectionTitle: doc.sectionTitle,
        sectionIndex: doc.sectionIndex,
        sectionLevel: c.sectionLevel,
        sectionPath: c.sectionPath ?? [],
        subIndex: doc.subIndex,
        // 0 is how the documents say no page.
        pageStart: doc.pageStart || null,
        pageEnd: doc.pageEnd || null,
        pageLabelStart: c.pageLabelStart || null,
        pageLabelEnd: c.pageLabelEnd || null,
      });
    }

    const slug = this.o.workspaceSlug;
    // Asking first makes a retry safe: upstream embeds a path again if it is posted twice.
    let embedded = await this.o.api.workspaceDocuments(slug);
    const adds = records.map((r) => r.location).filter((l) => !embedded.has(l));
    if (adds.length) {
      await this.o.api.updateEmbeddings(slug, { adds, deletes: [] });
      // update-embeddings does not report per-document failures (docs/upstream-analysis.md Q9).
      embedded = await this.o.api.workspaceDocuments(slug);
      const missing = adds.filter((l) => !embedded.has(l));
      if (missing.length) throw new Error(`server did not embed ${missing.length} of ${adds.length} sections`);
    }
    for (const r of records) r.docId = embedded.get(r.location) || null;

    const keep = new Set(records.map((r) => r.location));
    const stale = [...oldByLocation.keys()].filter((l) => !keep.has(l));
    if (stale.length) await this.o.api.removeDocuments(slug, stale);

    this.data.files[p] = {
      path: p,
      url: pathToFileURL(p).href,
      relPath,
      sourceId: root.id,
      hash,
      splitKey,
      size: st.size,
      mtimeMs: st.mtimeMs,
      indexedAt: this.o.now().toISOString(),
      sections: records,
    };
    this.save();
    return { outcome: 'indexed', sections: records.length };
  }

  private async remove(p: string): Promise<Outcome> {
    const old = this.data.files[p];
    if (!old) return { outcome: 'removed', sections: 0 };
    await this.o.api.removeDocuments(
      this.o.workspaceSlug,
      old.sections.map((s) => s.location),
    );
    delete this.data.files[p];
    this.save();
    return { outcome: 'removed', sections: old.sections.length };
  }

  private async reconcile(): Promise<void> {
    const found = new Set<string>();
    const walked: string[] = [];
    for (const r of this.roots) {
      for await (const p of walk(r.path, r.path)) {
        if (!isIndexable(p, r.path, this.o.extensions) || this.rootOf(p) !== r) continue;
        walked.push(p);
      }
    }
    for (const p of walked) {
      found.add(p);
      const rec = this.data.files[p];
      let st: fs.Stats;
      try {
        st = await fsp.stat(p);
      } catch {
        continue;
      }
      // Size and time decide what to look at; the job then compares hashes before any work.
      const changed = !rec || rec.size !== st.size || rec.mtimeMs !== st.mtimeMs;
      if (changed || rec.splitKey !== this.o.splitter.splitKey) this.settle(p);
    }
    let missing = 0;
    // Files of a folder that cannot be read now are kept; files of a folder no longer in the
    // library are not under any root and go.
    const keep = (p: string) => this.unavailable.some((u) => belongsTo(p, this.data.files[p], u));
    for (const p of Object.keys(this.data.files)) {
      if (!found.has(p) && !keep(p)) {
        this.queue.push({ path: p, kind: 'remove', attempt: 0 });
        missing++;
      }
    }
    this.o.log(`reconcile: ${found.size} files in folders, ${this.settling.size} to check, ${missing} to remove`);
  }

  private save(): void {
    saveIndex(this.indexFile, this.data);
  }

  private emitStatus(): void {
    this.emit('status', this.status());
  }

  private flushIdle(): void {
    if (!this.isIdle() && this.state !== 'stopped') return;
    for (const w of this.idleWaiters.splice(0)) w();
  }
}

/**
 * True when an indexed file came from root r. By source id, since a folder that cannot be read
 * cannot be resolved to the real path the index keys use; by path for records without one.
 */
function belongsTo(p: string, rec: FileRecord | undefined, r: WatchRoot): boolean {
  if (rec?.sourceId !== undefined) return rec.sourceId === r.id;
  const rel = path.relative(r.path, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

async function* walk(dir: string, root: string): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (isHidden(p, root)) continue;
    if (e.isDirectory()) yield* walk(p, root);
    else if (e.isFile()) yield p;
  }
}
