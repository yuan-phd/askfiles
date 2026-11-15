import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LIBRARY_ID, type ShellState, type ShellStateSource } from './shell-state.js';
import type { IndexData } from './watcher/index.js';

/**
 * Everything the app keeps for one library, and its removal (docs/app.md, Libraries, Delete):
 *
 * | Place | Keyed by |
 * | --- | --- |
 * | shell.json | the library's record (id, workspace slug, sources) |
 * | <dataDir>/libraries/<id>/ | index.json, browse/, summaries/, export/, graph.json, paragraphs/, files/ |
 * | <storage>/documents/askfiles/<id>/ | the section documents |
 * | <storage>/lancedb/<slug>.lance/ | the workspace's vectors |
 * | <storage>/askfiles.db | workspaces, workspace_documents, document_vectors, workspace_chats rows |
 * | <storage>/vector-cache/<uuid>.json | uuid v5 (URL namespace) of the section document's path |
 * | <dataDir>/ocr-cache/<sha256>[-subset][-up].pages.json | sha256 of the scanned file's bytes |
 *
 * The vector cache is upstream's (server/utils/files/index.js cachedVectorInformation): the name is
 * the uuid v5 of the document path as posted to update-embeddings, askfiles/<id>/<name>.json, so
 * every entry belongs to exactly one library, even when two libraries hold the same file. The OCR
 * cache is the shell's (src/main/watcher/ocr.ts) and is keyed by the file's content: two libraries
 * holding the same scanned file share one entry, which goes only when no other library lists it.
 */

/** Ids the app gives to libraries it creates (LibraryManager.create). All files is never one. */
export const LIBRARY_ID_RE = /^lib-[0-9a-f]{6}$/;
/** Workspace names of such libraries (library.ts workspaceNameOf). */
const WORKSPACE_NAME_RE = /^askfiles-(lib-[0-9a-f]{6})$/;
/** Their slugs: the name, or upstream's name-<8 digits> when the name's slug was taken. */
const WORKSPACE_SLUG_RE = /^askfiles-lib-[0-9a-f]{6}(-\d{8})?$/;
const VECTOR_CACHE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const OCR_CACHE_RE = /^([0-9a-f]{64})(-[0-9a-f]{12})?(-up)?\.pages\.json$/;
/** The folder under documents the shell writes section documents to (watcher DOCS_FOLDER). */
const SHELL_DOCS = 'askfiles';

/** The namespace upstream's uuid v5 calls use (uuidv5.URL). */
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/** RFC 4122 version 5 uuid, as the uuid package's v5 makes it. */
export function uuidv5(name: string, namespace = URL_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = crypto.createHash('sha1').update(ns).update(name, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** File name of upstream's vector cache entry for a document path (relative to documents/). */
export function vectorCacheName(docpath: string): string {
  return `${uuidv5(docpath)}.json`;
}

export interface DataPaths {
  dataDir: string;
  storageDir: string;
  /** <dataDir>/ocr-cache. */
  ocrCacheDir: string;
}

export const REMOVAL_STEPS = ['vector-cache', 'ocr-cache', 'workspace', 'vectors', 'documents', 'records'] as const;
export type RemovalStep = (typeof REMOVAL_STEPS)[number];

/**
 * index.json read without the side effect of loadIndex (which moves a damaged file aside): a
 * missing file is an empty index, a damaged one null.
 */
export function peekIndex(file: string): IndexData | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { version: 1, files: {} } : null;
  }
  try {
    const d = JSON.parse(raw) as IndexData;
    return d && d.version === 1 && d.files && typeof d.files === 'object' ? d : null;
  } catch {
    return null;
  }
}

function indexFileOf(dataDir: string, id: string): string {
  return path.join(dataDir, 'libraries', id, 'index.json');
}

/** Paths of every file below dir, relative to it with forward slashes. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  visit(dir, '');
  return out;
}

function listNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Content hashes of the files a library's index lists; null when its index is damaged. */
function hashesOf(dataDir: string, id: string): Set<string> | null {
  const index = peekIndex(indexFileOf(dataDir, id));
  return index ? new Set(Object.values(index.files).map((f) => f.hash)) : null;
}

export interface RemoveLibraryOptions extends DataPaths {
  id: string;
  workspaceSlug: string | null;
  /** Every other library in shell.json: their OCR cache entries stay. */
  otherLibraryIds: string[];
  /** DELETE /v1/workspace/{slug}: the database rows and the LanceDB table; gone counts as done. */
  removeWorkspace(slug: string): Promise<void>;
  /** Removes the record from shell.json, the last step. */
  removeRecord(): void;
  log(msg: string): void;
  /** Tests: called before each step, may throw to stop the delete there. */
  beforeStep?(step: RemovalStep): void | Promise<void>;
}

/**
 * Removes every trace of one library, in an order that can stop anywhere and be run again: the
 * caches first, while the section documents and index.json that name their entries still exist,
 * then the workspace, its LanceDB table, the documents, the library's folder, and the record last.
 * The record carries deleting: true before this starts (LibraryManager.remove), so a delete that
 * stopped midway is finished at the next start. The user's files are never touched: nothing here
 * reads a source path.
 */
export async function removeLibraryData(o: RemoveLibraryOptions): Promise<void> {
  if (o.id === DEFAULT_LIBRARY_ID || !LIBRARY_ID_RE.test(o.id)) throw new Error(`refusing to remove library ${o.id}`);
  const docsDir = path.join(o.storageDir, 'documents', SHELL_DOCS, o.id);
  const libDir = path.join(o.dataDir, 'libraries', o.id);
  const log = (m: string) => o.log(`[library-data] ${o.id}: ${m}`);
  const step = async (name: RemovalStep, run: () => void | Promise<void>) => {
    await o.beforeStep?.(name);
    await run();
  };

  await step('vector-cache', () => {
    const index = peekIndex(indexFileOf(o.dataDir, o.id));
    const locations = new Set(listFiles(docsDir).map((rel) => `${SHELL_DOCS}/${o.id}/${rel}`));
    for (const f of Object.values(index?.files ?? {})) for (const s of f.sections) locations.add(s.location);
    for (const list of Object.values(index?.pending ?? {})) for (const l of list) locations.add(l);
    const cacheDir = path.join(o.storageDir, 'vector-cache');
    let n = 0;
    for (const l of locations) {
      const file = path.join(cacheDir, vectorCacheName(l));
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        n++;
      }
    }
    if (n) log(`removed ${n} vector cache entries`);
  });

  await step('ocr-cache', () => {
    const mine = hashesOf(o.dataDir, o.id);
    if (!mine?.size) return;
    const used = new Set<string>();
    for (const other of o.otherLibraryIds) {
      const h = hashesOf(o.dataDir, other);
      if (!h) {
        // Without that library's list a shared entry could be removed under it.
        log(`OCR cache kept: the index of ${other} cannot be read`);
        return;
      }
      for (const x of h) used.add(x);
    }
    let n = 0;
    let shared = 0;
    for (const name of listNames(o.ocrCacheDir)) {
      const hash = OCR_CACHE_RE.exec(name)?.[1];
      if (!hash || !mine.has(hash)) continue;
      if (used.has(hash)) {
        shared++;
        continue;
      }
      fs.rmSync(path.join(o.ocrCacheDir, name), { force: true });
      n++;
    }
    if (n || shared) log(`removed ${n} OCR cache entries, kept ${shared} another library uses`);
  });

  await step('workspace', async () => {
    if (o.workspaceSlug) {
      await o.removeWorkspace(o.workspaceSlug);
      log(`workspace ${o.workspaceSlug} removed`);
    }
  });

  await step('vectors', () => {
    // Upstream drops the table with the workspace but only logs a failure; this makes sure.
    const slug = o.workspaceSlug;
    if (!slug || !WORKSPACE_SLUG_RE.test(slug)) return;
    const table = path.join(o.storageDir, 'lancedb', `${slug}.lance`);
    if (fs.existsSync(table)) {
      fs.rmSync(table, { recursive: true, force: true });
      log(`removed ${table}`);
    }
  });

  await step('documents', () => {
    if (fs.existsSync(docsDir)) {
      fs.rmSync(docsDir, { recursive: true, force: true });
      log(`removed ${docsDir}`);
    }
  });

  await step('records', () => {
    if (fs.existsSync(libDir)) {
      fs.rmSync(libDir, { recursive: true, force: true });
      log(`removed ${libDir}`);
    }
    o.removeRecord();
    log('removed from shell.json');
  });
}

/** No OCR cache folder: the self-check never touches it. */
export interface SelfCheckOptions extends Omit<DataPaths, 'ocrCacheDir'> {
  state: ShellState;
  /** Every library id shell.json names, damaged records included (readShellState knownIds). */
  knownIds: Set<string>;
  /** The server's workspaces; null when the list cannot be had (then no workspace or table goes). */
  listWorkspaces(): Promise<{ name: string; slug: string }[] | null>;
  removeWorkspace(slug: string): Promise<void>;
  log(msg: string): void;
  now?: () => number;
}

/**
 * Startup self-check: removes data that belongs to no library in shell.json. Only call it with a
 * state read from shell.json itself (readShellState source 'file'). Only what the app creates is
 * touched, by its own naming: library folders and document folders named lib-xxxxxx, workspaces
 * named askfiles-lib-xxxxxx and their LanceDB tables, vector cache entries whose section document
 * is gone. All files, the OCR cache, the models, the server's own files and the user's files are
 * never touched. Returns what was removed, one line each, logged.
 */
export async function selfCheck(o: SelfCheckOptions): Promise<string[]> {
  const removed: string[] = [];
  const log = (m: string) => o.log(`[self-check] ${m}`);
  const gone = (what: string) => {
    removed.push(what);
    log(`removed ${what}`);
  };
  const known = new Set([...o.knownIds, ...o.state.libraries.map((l) => l.id), DEFAULT_LIBRARY_ID]);
  const knownSlugs = new Set(o.state.libraries.map((l) => l.workspaceSlug).filter((s): s is string => !!s));
  const orphan = (id: string) => LIBRARY_ID_RE.test(id) && !known.has(id);
  // Entries written from now on (none should be, nothing is indexing yet) are never candidates.
  const startedAt = (o.now ?? Date.now)();

  for (const id of listNames(path.join(o.dataDir, 'libraries')).filter(orphan)) {
    fs.rmSync(path.join(o.dataDir, 'libraries', id), { recursive: true, force: true });
    gone(`library folder ${id}`);
  }
  const shellDocs = path.join(o.storageDir, 'documents', SHELL_DOCS);
  for (const id of listNames(shellDocs).filter(orphan)) {
    const dir = path.join(shellDocs, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    gone(`document folder ${id}`);
  }

  let workspaces: { name: string; slug: string }[] | null = null;
  try {
    workspaces = await o.listWorkspaces();
  } catch (e) {
    log(`workspaces not checked: ${(e as Error).message}`);
  }
  if (workspaces) {
    const left: string[] = [];
    for (const w of workspaces) {
      const id = WORKSPACE_NAME_RE.exec(w.name)?.[1];
      if (id && orphan(id) && !knownSlugs.has(w.slug)) {
        try {
          await o.removeWorkspace(w.slug);
          gone(`workspace ${w.slug}`);
          continue;
        } catch (e) {
          log(`workspace ${w.slug} not removed: ${(e as Error).message}`);
        }
      }
      left.push(w.slug);
    }
    const lance = path.join(o.storageDir, 'lancedb');
    for (const name of listNames(lance)) {
      if (!name.endsWith('.lance')) continue;
      const slug = name.slice(0, -'.lance'.length);
      if (!WORKSPACE_SLUG_RE.test(slug) || knownSlugs.has(slug) || left.includes(slug)) continue;
      fs.rmSync(path.join(lance, name), { recursive: true, force: true });
      gone(`vector table ${slug}`);
    }
  }

  // A vector cache entry is used only to embed its own document again; with the document gone,
  // nothing reaches it (upstream removes both together when it removes a document).
  const documents = path.join(o.storageDir, 'documents');
  const cacheDir = path.join(o.storageDir, 'vector-cache');
  if (fs.existsSync(documents)) {
    const live = new Set(listFiles(documents).map(vectorCacheName));
    let n = 0;
    for (const name of listNames(cacheDir)) {
      if (!VECTOR_CACHE_RE.test(name) || live.has(name)) continue;
      const file = path.join(cacheDir, name);
      try {
        if (fs.statSync(file).mtimeMs >= startedAt) continue;
      } catch {
        continue;
      }
      fs.rmSync(file, { force: true });
      n++;
    }
    if (n) gone(`${n} vector cache entries without a document`);
  }

  // The OCR cache is never looked at here (owner decision 2026-11-15): a scanned file whose
  // indexing never finished has no record yet, and the self-check runs most when startup is in
  // trouble, so such a file would be OCRed again and again. Only a delete removes OCR entries.

  log(removed.length ? `${removed.length} removals` : 'nothing to remove');
  return removed;
}

/**
 * At start, before any watcher writes: deletes the app could not finish first (LibraryManager
 * resumeRemovals), then the self-check, but only when shell.json itself was read. From the backup
 * (one save behind) or an empty state, data of a library the latest file names could look unused,
 * so nothing is removed then.
 */
export async function startupLibraryCheck(
  o: SelfCheckOptions & { source: ShellStateSource; resumeRemovals(): Promise<string[]> },
): Promise<'done' | 'skipped'> {
  try {
    const failed = await o.resumeRemovals();
    if (failed.length) o.log(`[libraries] deletes left for the next start: ${failed.join(', ')}`);
  } catch (e) {
    o.log(`[libraries] deletes not finished: ${(e as Error).message}`);
  }
  if (o.source !== 'file') {
    o.log(`[self-check] skipped: shell.json was not read (${o.source}), so no data is known to be unused`);
    return 'skipped';
  }
  const t0 = Date.now();
  try {
    await selfCheck(o);
    o.log(`[self-check] done in ${Date.now() - t0} ms`);
  } catch (e) {
    o.log(`[self-check] failed: ${(e as Error).message}`);
  }
  return 'done';
}
