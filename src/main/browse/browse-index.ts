import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileRecord } from '../watcher/index.js';
import { buildDocument, documentId, type StoredChunk } from './build.js';
import { rankSections, sectionFrequency, type FoldedSection, type RankedSection } from './rank.js';
import { fold, markRanges, occurrences, queryTerms, snippetOf } from './search.js';
import type {
  BrowseDocument,
  BrowseSection,
  DocumentRef,
  DocumentSummary,
  HeadingEntry,
  HeadingGroup,
  SearchGroup,
  SearchResult,
} from './types.js';

export interface BrowseIndexOptions {
  /** <libraryDir>/browse: one JSON file per document, named by its id. */
  dir: string;
  /** Only for watcher records without relPath (written before Session K): the folder they are under. */
  root?: string;
  /** Reads a section document the watcher wrote (STORAGE_DIR/documents/<location>). */
  readChunk: (location: string) => StoredChunk | null;
  log?: (msg: string) => void;
}

/** Matching sections returned at most per search; more are counted in total only. */
const SEARCH_LIMIT = 200;

/**
 * The browse view's own index (plan phase 4): per document its outline and the full text of every
 * section, built from the watcher's index.json records and the section documents, kept current
 * from the watcher's file events and stored under the data directory so the browse pages open
 * without waiting for the watcher. No model and no server call is involved.
 */
export class BrowseIndex {
  private readonly docs = new Map<string, BrowseDocument>();
  /** Folded title and text per section, built on the first search after a change. */
  private readonly folded = new Map<string, string[]>();
  private readonly root: string | undefined;
  private readonly log: (msg: string) => void;

  constructor(private readonly o: BrowseIndexOptions) {
    this.log = o.log ?? ((msg) => console.log(`[browse] ${msg}`));
    if (o.root) {
      // The watcher keys files by their real path (macOS /var is /private/var).
      let root = path.resolve(o.root);
      try {
        root = fs.realpathSync(root);
      } catch {
        // A folder that is gone still lists what was indexed from it.
      }
      this.root = root;
    }
  }

  /** Reads every stored document. Unreadable files are skipped; the next sync rebuilds them. */
  load(): void {
    this.docs.clear();
    this.folded.clear();
    let names: string[];
    try {
      names = fs.readdirSync(this.o.dir).filter((n) => n.endsWith('.json'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const name of names) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(this.o.dir, name), 'utf8')) as BrowseDocument;
        // Older versions lack paths and labels; skipped here, the next sync rebuilds them.
        if (doc?.version === 2 && typeof doc.id === 'string' && Array.isArray(doc.sections)) this.docs.set(doc.id, doc);
      } catch (e) {
        this.log(`skipped ${name}: ${(e as Error).message}`);
      }
    }
    this.log(`loaded ${this.docs.size} documents`);
  }

  /** Makes the index match the watcher's records: builds what is new or changed, drops the rest. */
  sync(records: FileRecord[]): void {
    const keep = new Set<string>();
    let built = 0;
    for (const rec of records) {
      keep.add(documentId(rec.path));
      if (this.update(rec)) built++;
    }
    let dropped = 0;
    for (const id of [...this.docs.keys()]) {
      if (!keep.has(id)) {
        this.drop(id);
        dropped++;
      }
    }
    this.log(`sync: ${records.length} files, ${built} built, ${dropped} dropped`);
  }

  /**
   * Adds or refreshes one file after the watcher indexed it. Returns true when the sections were
   * read again; a file with the same bytes and split only gets its size and time updated.
   */
  update(rec: FileRecord): boolean {
    const id = documentId(rec.path);
    const old = this.docs.get(id);
    const relPath = rec.relPath || old?.relPath;
    if (
      old &&
      old.hash === rec.hash &&
      old.splitKey === rec.splitKey &&
      old.path === rec.path &&
      old.relPath === relPath
    ) {
      if (old.size !== rec.size || old.mtimeMs !== rec.mtimeMs) {
        this.store({ ...old, size: rec.size, mtimeMs: rec.mtimeMs });
      }
      return false;
    }
    this.store(buildDocument(rec, { root: this.root, readChunk: this.o.readChunk }));
    return true;
  }

  /** Drops a file the watcher removed. */
  remove(filePath: string): void {
    this.drop(documentId(filePath));
  }

  listDocuments(): DocumentSummary[] {
    return [...this.docs.values()].map(summary).sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  /** A document by id, or by the url or file name a search source carries. */
  getDocument(ref: DocumentRef): BrowseDocument | null {
    if (ref.id) return this.docs.get(ref.id) ?? null;
    const all = [...this.docs.values()];
    if (ref.url) {
      const byUrl = all.find((d) => d.url === ref.url);
      if (byUrl) return byUrl;
      if (ref.url.startsWith('file:')) {
        try {
          const byPath = this.docs.get(documentId(fileURLToPath(ref.url)));
          if (byPath) return byPath;
        } catch {
          // Not a valid file URL; try the name.
        }
      }
    }
    if (ref.title) {
      const byName = all.filter((d) => d.title === ref.title);
      if (byName.length === 1) return byName[0]!;
    }
    return null;
  }

  /**
   * Sections grouped by normalized heading over all documents, the groups found in most documents
   * first. Without a key: only headings found in at least minDocuments documents (default 2, the
   * Headings page), entries without text. With a key: only that group, with the text.
   */
  headings(o: { key?: string | null; minDocuments?: number } = {}): HeadingGroup[] {
    const groups = new Map<string, HeadingEntry[]>();
    for (const d of this.docs.values()) {
      for (const s of d.sections) {
        if (!s.heading || (o.key && s.heading !== o.key)) continue;
        const entry: HeadingEntry = {
          documentId: d.id,
          documentTitle: d.title,
          relPath: d.relPath,
          url: d.url,
          sectionIndex: s.index,
          title: s.title,
          pageStart: s.pageStart,
          pageEnd: s.pageEnd,
          pageLabelStart: s.pageLabelStart,
          pageLabelEnd: s.pageLabelEnd,
          ...(o.key ? { text: s.text } : {}),
        };
        groups.set(s.heading, [...(groups.get(s.heading) ?? []), entry]);
      }
    }
    return [...groups.entries()]
      .map(([key, entries]) => {
        entries.sort((a, b) => a.relPath.localeCompare(b.relPath) || a.sectionIndex - b.sectionIndex);
        return { key, label: mostCommon(entries.map((e) => e.title)), documents: distinct(entries), entries };
      })
      .filter((g) => o.key || g.documents >= (o.minDocuments ?? 2))
      .sort((a, b) => b.documents - a.documents || a.label.localeCompare(b.label));
  }

  /** Keyword search; see search.ts for the matching rules. */
  search(query: string, limit = SEARCH_LIMIT): SearchResult {
    const terms = queryTerms(query);
    const result: SearchResult = { query, terms, total: 0, groups: [], truncated: false };
    if (!terms.length) return result;
    let kept = 0;
    const scored: { group: SearchGroup; score: number }[] = [];
    for (const d of [...this.docs.values()].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      const hay = this.foldedOf(d);
      let group: SearchGroup | null = null;
      let score = 0;
      for (const [i, s] of d.sections.entries()) {
        const counts = terms.map((t) => occurrences(hay[i]!, t).length);
        if (counts.some((c) => c === 0)) continue;
        result.total++;
        if (kept >= limit) {
          result.truncated = true;
          continue;
        }
        kept++;
        const count = counts.reduce((a, b) => a + b, 0);
        const titleMarks = markRanges(s.title, terms);
        score += count + (titleMarks.length ? 5 : 0);
        group ??= { document: summary(d), count: 0, hits: [] };
        group.count += count;
        group.hits.push({
          sectionIndex: s.index,
          title: s.title,
          titleMarks,
          pageStart: s.pageStart,
          pageEnd: s.pageEnd,
          pageLabelStart: s.pageLabelStart,
          pageLabelEnd: s.pageLabelEnd,
          count,
          ...snippetOf(s.text, terms),
        });
      }
      if (group) scored.push({ group, score });
    }
    result.groups = scored.sort((a, b) => b.score - a.score).map((x) => x.group);
    return result;
  }

  /** Number of sections over all documents. */
  sectionTotal(): number {
    let n = 0;
    for (const d of this.docs.values()) n += d.sections.length;
    return n;
  }

  /** Number of sections whose folded title or text contains the folded term. */
  sectionFrequency(term: string): number {
    return sectionFrequency(this.foldedSections(), fold(term));
  }

  /** BM25 over all sections for terms (any term matches); see rank.ts. */
  rankSections(terms: string[], limit: number): RankedSection[] {
    return rankSections(this.foldedSections(), terms.map(fold), limit);
  }

  /** One section of a document by its 1-based index. */
  section(documentId: string, sectionIndex: number): { document: BrowseDocument; section: BrowseSection } | null {
    const document = this.docs.get(documentId);
    const section = document?.sections.find((s) => s.index === sectionIndex);
    return document && section ? { document, section } : null;
  }

  private foldedSections(): FoldedSection[] {
    const out: FoldedSection[] = [];
    for (const d of [...this.docs.values()].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      const hay = this.foldedOf(d);
      d.sections.forEach((s, i) => out.push({ documentId: d.id, sectionIndex: s.index, folded: hay[i]! }));
    }
    return out;
  }

  private foldedOf(d: BrowseDocument): string[] {
    let f = this.folded.get(d.id);
    if (!f) {
      f = d.sections.map((s) => fold(`${s.title}\n${s.text}`));
      this.folded.set(d.id, f);
    }
    return f;
  }

  private store(doc: BrowseDocument): void {
    this.docs.set(doc.id, doc);
    this.folded.delete(doc.id);
    fs.mkdirSync(this.o.dir, { recursive: true });
    const file = path.join(this.o.dir, `${doc.id}.json`);
    // Temp file and rename, so a crash mid-write never leaves half a document.
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc));
    fs.renameSync(tmp, file);
  }

  private drop(id: string): void {
    this.docs.delete(id);
    this.folded.delete(id);
    fs.rmSync(path.join(this.o.dir, `${id}.json`), { force: true });
  }
}

function summary(d: BrowseDocument): DocumentSummary {
  return {
    id: d.id,
    path: d.path,
    url: d.url,
    relPath: d.relPath,
    title: d.title,
    size: d.size,
    mtimeMs: d.mtimeMs,
    indexedAt: d.indexedAt,
    outline: d.outline,
    sectionCount: d.sections.length,
  };
}

function distinct(entries: HeadingEntry[]): number {
  return new Set(entries.map((e) => e.documentId)).size;
}

/** The most frequent string, the first seen among equals. */
function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? '';
  for (const [v, n] of counts) if (n > counts.get(best)!) best = v;
  return best;
}
