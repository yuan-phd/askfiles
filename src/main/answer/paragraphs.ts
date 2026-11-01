/**
 * Paragraph-level selection by embeddings (paragraphSelection). Each section longer than twice the
 * chunk maximum is split into paragraphs of about PARAGRAPH_MIN_CHARS to PARAGRAPH_MAX_CHARS, each
 * embedded with the library's embedding model and stored per document next to the browse index.
 * At question time a long selected section is sent as its paragraphs closest to the question
 * (cosine similarity plus keyword hits), each with one neighbour on both sides, in document order;
 * shorter sections are sent whole. One embedding call for the question, no model call.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BrowseDocument } from '../browse/index.js';
import type { AnswerSection } from './sections.js';

export const PARAGRAPH_MIN_CHARS = 200;
export const PARAGRAPH_MAX_CHARS = 500;
/** Paragraphs taken by score per section, before neighbours are added. */
export const PARAGRAPH_TOP = 3;
/** Added to the cosine similarity per distinct question term in the paragraph, at most KEYWORD_MAX_HITS. */
export const KEYWORD_WEIGHT = 0.05;
export const KEYWORD_MAX_HITS = 4;
/** Bumped when the split changes, so stored paragraphs are rebuilt. */
export const PARAGRAPH_VERSION = 1;

/** Sentence ends, list items and semicolons a long line may be cut after. */
const CUT = /(?<=[.!?;:。！？；])\s+|\s+(?=(?:[-•*]|\(?[a-z0-9]{1,3}[.)])\s)/giu;

/** Pieces of one line, each at most max characters; a piece with no cut point is cut at a space. */
function piecesOf(line: string, max: number): string[] {
  if (line.length <= max) return [line];
  const out: string[] = [];
  let cur = '';
  for (const s of line.split(CUT).filter(Boolean)) {
    if (cur && cur.length + 1 + s.length > max) {
      out.push(cur);
      cur = '';
    }
    let rest = s;
    while (rest.length > max) {
      const sp = rest.lastIndexOf(' ', max);
      const at = sp > max / 2 ? sp : max;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    cur = cur ? `${cur} ${rest}` : rest;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Paragraphs of a section text: lines joined until a paragraph reaches min characters at a blank
 * line or would pass max, long lines cut at sentence ends; a short last one joins the one before.
 */
export function splitParagraphs(text: string, o: { min?: number; max?: number } = {}): string[] {
  const min = o.min ?? PARAGRAPH_MIN_CHARS;
  const max = o.max ?? PARAGRAPH_MAX_CHARS;
  const out: string[] = [];
  let cur = '';
  for (const block of text.split(/\n\s*\n/)) {
    const units = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((l) => piecesOf(l, max));
    units.forEach((u, i) => {
      const blockStart = i === 0;
      if (cur && (cur.length + 1 + u.length > max || (blockStart && cur.length >= min))) {
        out.push(cur);
        cur = '';
      }
      cur = cur ? `${cur}\n${u}` : u;
    });
  }
  if (cur) {
    if (out.length && cur.length < min && out[out.length - 1]!.length + 1 + cur.length <= max + min) {
      out[out.length - 1] += `\n${cur}`;
    } else out.push(cur);
  }
  return out;
}

export type EmbedFn = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;

/** Ollama's batch embedding route (POST /api/embed), the same model the library is embedded with. */
export function ollamaEmbed(baseUrl: () => string, model: string, fetchFn: typeof fetch = fetch): EmbedFn {
  return async (texts, signal) => {
    const res = await fetchFn(`${baseUrl()}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal,
    });
    if (!res.ok) throw new Error(`embed failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length)
      throw new Error('embed failed: wrong number of embeddings');
    return body.embeddings;
  };
}

export interface SectionParagraphs {
  paragraphs: string[];
  vectors: Float32Array[];
}

interface StoredFile {
  version: number;
  model: string;
  hash: string;
  splitKey: string;
  minSectionChars: number;
  /** By section index: paragraph texts and their vectors as base64 float32. */
  sections: Record<string, { paragraphs: string[]; vectors: string[] }>;
}

const toB64 = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString('base64');
const fromB64 = (s: string) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

/** Batch size of one embedding call. */
const EMBED_BATCH = 32;

export interface ParagraphStoreOptions {
  /** <libraryDir>/paragraphs: one JSON file per document, named by its id. */
  dir: string;
  model: string;
  /** Sections longer than this get paragraphs: twice the chunk maximum. */
  minSectionChars: number;
  embed: EmbedFn;
  log?: (msg: string) => void;
}

export class ParagraphStore {
  private readonly cache = new Map<string, StoredFile>();
  private readonly log: (msg: string) => void;
  private running: Promise<void> | null = null;

  constructor(private readonly o: ParagraphStoreOptions) {
    this.log = o.log ?? (() => {});
  }

  private file(id: string): string {
    return path.join(this.o.dir, `${id}.json`);
  }

  private read(doc: Pick<BrowseDocument, 'id' | 'hash' | 'splitKey'>): StoredFile | null {
    let f = this.cache.get(doc.id);
    if (!f) {
      try {
        f = JSON.parse(fs.readFileSync(this.file(doc.id), 'utf8')) as StoredFile;
        this.cache.set(doc.id, f);
      } catch {
        return null;
      }
    }
    const current =
      f.version === PARAGRAPH_VERSION &&
      f.model === this.o.model &&
      f.hash === doc.hash &&
      f.splitKey === doc.splitKey &&
      f.minSectionChars === this.o.minSectionChars;
    return current ? f : null;
  }

  /** Splits and embeds the long sections of a document unless they are stored already; returns paragraphs embedded. */
  async ensure(doc: BrowseDocument, signal?: AbortSignal): Promise<number> {
    if (this.read(doc)) return 0;
    const sections: StoredFile['sections'] = {};
    let count = 0;
    for (const s of doc.sections) {
      if (s.text.length <= this.o.minSectionChars) continue;
      const paragraphs = splitParagraphs(s.text);
      const vectors: string[] = [];
      for (let i = 0; i < paragraphs.length; i += EMBED_BATCH) {
        const batch = await this.o.embed(paragraphs.slice(i, i + EMBED_BATCH), signal);
        vectors.push(...batch.map(toB64));
      }
      sections[String(s.index)] = { paragraphs, vectors };
      count += paragraphs.length;
    }
    const stored: StoredFile = {
      version: PARAGRAPH_VERSION,
      model: this.o.model,
      hash: doc.hash,
      splitKey: doc.splitKey,
      minSectionChars: this.o.minSectionChars,
      sections,
    };
    fs.mkdirSync(this.o.dir, { recursive: true });
    fs.writeFileSync(this.file(doc.id), JSON.stringify(stored));
    this.cache.set(doc.id, stored);
    this.log(`[paragraphs] ${doc.title}: ${count} paragraphs embedded`);
    return count;
  }

  /**
   * Brings every document up to date in the background, one at a time; a call while one runs
   * waits for it. Errors are logged and the document is tried again on the next call.
   */
  refresh(docs: () => BrowseDocument[]): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      for (const d of docs()) {
        try {
          await this.ensure(d);
        } catch (e) {
          this.log(`[paragraphs] ${d.title}: ${(e as Error).message}`);
        }
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Stored paragraphs of one section, null when not built (yet) or out of date. */
  get(doc: Pick<BrowseDocument, 'id' | 'hash' | 'splitKey'>, sectionIndex: number): SectionParagraphs | null {
    const s = this.read(doc)?.sections[String(sectionIndex)];
    return s ? { paragraphs: s.paragraphs, vectors: s.vectors.map(fromB64) } : null;
  }

  async embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
    return new Float32Array((await this.o.embed([text], signal))[0]!);
  }
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * The text of a long section made of its best paragraphs: the top PARAGRAPH_TOP by cosine plus
 * keyword hits, then one neighbour on each side, added while they fit cap, in document order with
 * ... where paragraphs are left out.
 */
export function selectParagraphs(p: SectionParagraphs, query: ArrayLike<number>, terms: string[], cap: number): string {
  const folded = terms.map((t) => t.normalize('NFKC').toLowerCase()).filter(Boolean);
  const scores = p.paragraphs.map((text, i) => {
    const t = text.normalize('NFKC').toLowerCase();
    const hits = Math.min(KEYWORD_MAX_HITS, folded.filter((w) => t.includes(w)).length);
    return { i, score: cosine(query, p.vectors[i]!) + KEYWORD_WEIGHT * hits };
  });
  const top = [...scores]
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, PARAGRAPH_TOP)
    .map((x) => x.i);
  const order = [...top, ...top.flatMap((i) => [i - 1, i + 1])].filter((i) => i >= 0 && i < p.paragraphs.length);
  const chosen = new Set<number>();
  let used = 0;
  for (const i of order) {
    if (chosen.has(i)) continue;
    // 5 is the separator or gap marker each paragraph brings along.
    const cost = p.paragraphs[i]!.length + 5;
    if (chosen.size && used + cost > cap) continue;
    chosen.add(i);
    used += cost;
  }
  const idx = [...chosen].sort((a, b) => a - b);
  let out = idx[0]! > 0 ? '...\n\n' : '';
  idx.forEach((i, k) => {
    if (k) out += i === idx[k - 1]! + 1 ? '\n\n' : '\n\n...\n\n';
    out += p.paragraphs[i]!;
  });
  if (idx[idx.length - 1]! < p.paragraphs.length - 1) out += '\n\n...';
  return out;
}

/** The parts of the store the answer step reads. */
export interface ParagraphSource {
  get(doc: Pick<BrowseDocument, 'id' | 'hash' | 'splitKey'>, sectionIndex: number): SectionParagraphs | null;
  embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array>;
}

/** Selected sections with long ones replaced by their best paragraphs; others unchanged. */
export async function withParagraphs(
  question: string,
  sections: AnswerSection[],
  o: {
    source: ParagraphSource;
    document: (id: string) => Pick<BrowseDocument, 'id' | 'hash' | 'splitKey'> | null;
    terms: string[];
    minSectionChars: number;
    cap: number;
    signal?: AbortSignal;
  },
): Promise<{ sections: AnswerSection[]; replaced: number }> {
  const long = sections.map((s) => {
    if (s.fullLength <= o.minSectionChars) return null;
    const doc = o.document(s.documentId);
    return doc ? o.source.get(doc, s.sectionIndex) : null;
  });
  if (!long.some(Boolean)) return { sections, replaced: 0 };
  const query = await o.source.embedQuery(question, o.signal);
  let replaced = 0;
  const out = sections.map((s, i) => {
    const p = long[i];
    if (!p || !p.paragraphs.length) return s;
    replaced++;
    return { ...s, text: selectParagraphs(p, query, o.terms, o.cap) };
  });
  return { sections: out, replaced };
}
