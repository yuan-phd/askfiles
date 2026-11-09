import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileRecord } from '../watcher/index.js';
import { detectKind } from '../graph/kinds.js';
import { buildDocument, buildOutline, documentId, PAGE_PART, type StoredChunk } from './build.js';
import { normalizeHeading } from './normalize.js';
import { buildIdentities, warmMatchers, displayName, type FileIdentity } from './identifiers.js';
import { rankSections, sectionFrequency, type FoldedSection, type KeywordOptions, type RankedSection } from './rank.js';
import { stemFolded } from './stem.js';
import { fold, markRanges, matchesOf, matchTier, queryTerms, snippetOf } from './search.js';
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
 * A change to the index: a document built again (sections true when its text was read again, not
 * only its size or time), a document dropped, or the end of a sync or load.
 */
export type BrowseChange =
  { type: 'update'; id: string; sections: boolean } | { type: 'remove'; id: string } | { type: 'sync' };

/** The file identities (identifiers.ts), beside the document files; load() skips it. */
const IDENTITIES_FILE = 'identifiers.json';

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
  /** The folded sections with English words stemmed (keywordStemming), built on first use. */
  private readonly stemmed = new Map<string, string[]>();
  /** Rebuilt after any document changed; null until then. */
  private identityList: FileIdentity[] | null = null;
  private readonly root: string | undefined;
  private readonly log: (msg: string) => void;
  private readonly listeners = new Set<(c: BrowseChange) => void>();

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

  /** Calls listener after every change; returns the unsubscribe function. A throwing listener is logged. */
  onChange(listener: (c: BrowseChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(c: BrowseChange): void {
    for (const l of this.listeners) {
      try {
        l(c);
      } catch (e) {
        this.log(`change listener failed: ${(e as Error).message}`);
      }
    }
  }

  /** Reads every stored document. Unreadable files are skipped; the next sync rebuilds them. */
  load(): void {
    this.docs.clear();
    this.folded.clear();
    this.stemmed.clear();
    let names: string[];
    try {
      names = fs.readdirSync(this.o.dir).filter((n) => n.endsWith('.json') && n !== IDENTITIES_FILE);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const name of names) {
      try {
        const stored = JSON.parse(fs.readFileSync(path.join(this.o.dir, name), 'utf8')) as BrowseDocument;
        // The outline comes from the sections each time, so files stored before page parts folded
        // into one entry show the folded outline too, with no reindex.
        const doc =
          Array.isArray(stored?.sections) && stored.sections.every((s) => Array.isArray(s?.lead))
            ? { ...stored, outline: buildOutline(stored.sections) }
            : stored;
        // Older versions lack paths, labels or sub-chunks; skipped here, the next sync rebuilds them.
        if (doc?.version === 3 && typeof doc.id === 'string' && Array.isArray(doc.sections)) {
          // Stored before kinds existed: detected now and written back, so it happens once.
          if (!doc.kind) this.store({ ...doc, kind: detectKind(doc) }, { notify: false });
          else this.docs.set(doc.id, doc);
        }
      } catch (e) {
        this.log(`skipped ${name}: ${(e as Error).message}`);
      }
    }
    this.log(`loaded ${this.docs.size} documents`);
    this.emit({ type: 'sync' });
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
    this.identities();
    this.emit({ type: 'sync' });
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
        this.store({ ...old, size: rec.size, mtimeMs: rec.mtimeMs }, { sections: false });
      }
      return false;
    }
    this.store(buildDocument(rec, { root: this.root, readChunk: this.o.readChunk }), { sections: true });
    return true;
  }

  /** Drops a file the watcher removed. */
  remove(filePath: string): void {
    this.drop(documentId(filePath));
  }

  /** Every document with its sections, sorted by shown path; for the graph and the summaries. */
  allDocuments(): BrowseDocument[] {
    return [...this.docs.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
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
      // One card per document under a heading, by logical identity: the document and the heading
      // without the splitter's part marker. Parts it cut by page or after a table (T (page N),
      // T (continued), and a table section titled T between them) and a heading the document uses
      // more than once all go into that card, text in document order, one page range over them.
      const mine = new Map<string, HeadingEntry>();
      for (const s of d.sections) {
        const part = PAGE_PART.test(s.title);
        const title = part ? s.title.replace(PAGE_PART, '').trim() : s.title;
        const key = part ? normalizeHeading(title) : s.heading;
        if (!key || (o.key && key !== o.key)) continue;
        const owner = mine.get(key);
        if (owner) {
          if (s.pageStart !== null && (owner.pageStart === null || s.pageStart < owner.pageStart)) {
            owner.pageStart = s.pageStart;
            owner.pageLabelStart = s.pageLabelStart;
          }
          const end = s.pageEnd ?? s.pageStart;
          if (end !== null && (owner.pageEnd === null || end > owner.pageEnd)) {
            owner.pageEnd = end;
            owner.pageLabelEnd = s.pageLabelEnd ?? s.pageLabelStart;
          }
          if (o.key) {
            owner.text = [owner.text, s.text].filter(Boolean).join('\n\n');
            addPart(owner, s);
          }
          continue;
        }
        const entry: HeadingEntry = {
          documentId: d.id,
          documentTitle: d.title,
          display: displayName(d.title),
          relPath: d.relPath,
          url: d.url,
          sectionIndex: s.index,
          title,
          pageStart: s.pageStart,
          pageEnd: s.pageEnd,
          pageLabelStart: s.pageLabelStart,
          pageLabelEnd: s.pageLabelEnd,
          ...(o.key ? { text: s.text, parts: [] } : {}),
        };
        if (o.key) addPart(entry, s);
        mine.set(key, entry);
        groups.set(key, [...(groups.get(key) ?? []), entry]);
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

  /**
   * Keyword search; see search.ts for the matching rules. Every matching section is ranked before
   * the limit applies, so the hits kept are the best ones: documents by their best match tier, then
   * by how many sections match at that tier, then by occurrences (a term in a title counts 5);
   * within a document its sections by tier, then in document order.
   */
  search(query: string, limit = SEARCH_LIMIT): SearchResult {
    const terms = queryTerms(query);
    const result: SearchResult = { query, terms, total: 0, groups: [], truncated: false };
    if (!terms.length) return result;
    type Found = {
      s: BrowseDocument['sections'][number];
      count: number;
      tier: 0 | 1 | 2;
      titleMarks: [number, number][];
    };
    const docs: { d: BrowseDocument; found: Found[]; score: number }[] = [];
    for (const d of [...this.docs.values()].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      const hay = this.foldedOf(d);
      const found: Found[] = [];
      let score = 0;
      for (const [i, s] of d.sections.entries()) {
        const counts = terms.map((t) => matchesOf(hay[i]!, t).length);
        if (counts.some((c) => c === 0)) continue;
        result.total++;
        const count = counts.reduce((a, b) => a + b, 0);
        const titleMarks = markRanges(s.title, terms);
        score += count + (titleMarks.length ? 5 : 0);
        found.push({ s, count, tier: matchTier(hay[i]!, terms), titleMarks });
      }
      if (!found.length) continue;
      found.sort((a, b) => a.tier - b.tier || a.s.index - b.s.index);
      docs.push({ d, found, score });
    }
    const best = (x: (typeof docs)[number]) => x.found[0]!.tier;
    const atBest = (x: (typeof docs)[number]) => x.found.filter((f) => f.tier === best(x)).length;
    docs.sort((a, b) => best(a) - best(b) || atBest(b) - atBest(a) || b.score - a.score);
    let kept = 0;
    for (const { d, found } of docs) {
      const group: SearchGroup = { document: summary(d), count: 0, hits: [] };
      for (const f of found) {
        if (kept >= limit) {
          result.truncated = true;
          break;
        }
        kept++;
        group.count += f.count;
        group.hits.push({
          sectionIndex: f.s.index,
          title: f.s.title,
          titleMarks: f.titleMarks,
          pageStart: f.s.pageStart,
          pageEnd: f.s.pageEnd,
          pageLabelStart: f.s.pageLabelStart,
          pageLabelEnd: f.s.pageLabelEnd,
          count: f.count,
          tier: f.tier,
          ...snippetOf(f.s.text, terms),
        });
      }
      if (group.hits.length) result.groups.push(group);
    }
    return result;
  }

  /**
   * Per file the names a question may use for it. They depend on the whole library (a type word
   * names a file only when no other file has it), so they are rebuilt after any change and stored.
   */
  identities(): FileIdentity[] {
    if (this.identityList) return this.identityList;
    const docs = [...this.docs.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
    this.identityList = buildIdentities(docs);
    // Every name's matcher is built here, once per identity list, not per question; in the
    // background, so a large library does not hold the main process.
    const list = this.identityList;
    void warmMatchers(list, () => this.identityList === list);
    const file = path.join(this.o.dir, IDENTITIES_FILE);
    try {
      // An empty library leaves no file behind, as it leaves no documents.
      if (!docs.length) fs.rmSync(file, { force: true });
      else {
        fs.mkdirSync(this.o.dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(this.identityList));
      }
    } catch (e) {
      this.log(`identifiers not stored: ${(e as Error).message}`);
    }
    return this.identityList;
  }

  /** Number of sections over all documents. */
  sectionTotal(): number {
    let n = 0;
    for (const d of this.docs.values()) n += d.sections.length;
    return n;
  }

  /**
   * Number of sections whose folded title or text contains the folded term. With stem, English
   * words on both sides are matched by their Porter stem, as whole words (stem.ts).
   */
  sectionFrequency(term: string, o: KeywordOptions = {}): number {
    return o.stem
      ? sectionFrequency(this.foldedSections(true), stemFolded(fold(term)))
      : sectionFrequency(this.foldedSections(), fold(term));
  }

  /**
   * BM25 over all sections for terms (any term matches); see rank.ts. With stem, matched by stems
   * as above; each hit still lists the terms as they were given.
   */
  rankSections(terms: string[], limit: number, o: KeywordOptions = {}): RankedSection[] {
    if (!o.stem) return rankSections(this.foldedSections(), terms.map(fold), limit);
    const back = new Map<string, string>();
    for (const t of terms) {
      const k = stemFolded(fold(t));
      if (!back.has(k)) back.set(k, fold(t));
    }
    return rankSections(this.foldedSections(true), [...back.keys()], limit).map((r) => ({
      ...r,
      terms: r.terms.map((t) => back.get(t) ?? t),
    }));
  }

  /** One section of a document by its 1-based index. */
  section(documentId: string, sectionIndex: number): { document: BrowseDocument; section: BrowseSection } | null {
    const document = this.docs.get(documentId);
    const section = document?.sections.find((s) => s.index === sectionIndex);
    return document && section ? { document, section } : null;
  }

  private foldedSections(stem = false): FoldedSection[] {
    const out: FoldedSection[] = [];
    for (const d of [...this.docs.values()].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      const hay = stem ? this.stemmedOf(d) : this.foldedOf(d);
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

  private stemmedOf(d: BrowseDocument): string[] {
    let f = this.stemmed.get(d.id);
    if (!f) {
      f = this.foldedOf(d).map(stemFolded);
      this.stemmed.set(d.id, f);
    }
    return f;
  }

  private store(doc: BrowseDocument, o: { sections?: boolean; notify?: boolean } = {}): void {
    this.docs.set(doc.id, doc);
    this.folded.delete(doc.id);
    this.stemmed.delete(doc.id);
    this.identityList = null;
    fs.mkdirSync(this.o.dir, { recursive: true });
    const file = path.join(this.o.dir, `${doc.id}.json`);
    // Temp file and rename, so a crash mid-write never leaves half a document.
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc));
    fs.renameSync(tmp, file);
    if (o.notify !== false) this.emit({ type: 'update', id: doc.id, sections: o.sections ?? true });
  }

  private drop(id: string): void {
    const had = this.docs.delete(id);
    this.folded.delete(id);
    this.stemmed.delete(id);
    this.identityList = null;
    fs.rmSync(path.join(this.o.dir, `${id}.json`), { force: true });
    if (had) this.emit({ type: 'remove', id });
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
    ...(d.kind ? { kind: d.kind } : {}),
  };
}

/** Adds a section's text to an entry's parts; a part on the same pages as the last one joins it. */
function addPart(
  e: HeadingEntry,
  s: {
    pageStart: number | null;
    pageEnd: number | null;
    pageLabelStart: string | null;
    pageLabelEnd: string | null;
    text: string;
  },
): void {
  const parts = (e.parts ??= []);
  const last = parts[parts.length - 1];
  const end = s.pageEnd ?? s.pageStart;
  if (last && last.pageStart === s.pageStart && (last.pageEnd ?? last.pageStart) === end) {
    last.text = [last.text, s.text].filter(Boolean).join('\n\n');
    return;
  }
  parts.push({
    pageStart: s.pageStart,
    pageEnd: end,
    pageLabelStart: s.pageLabelStart,
    pageLabelEnd: s.pageLabelEnd ?? s.pageLabelStart,
    text: s.text,
  });
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
