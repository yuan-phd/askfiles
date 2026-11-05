/**
 * sentenceMatch (docs/plan.md, round D2): citation verification scores an answer sentence against
 * the sentences of each sent section instead of the section's whole token set. Two measures per
 * source sentence, the larger kept: the content-token overlap of verify.ts applied to that one
 * sentence, and the cosine similarity of bge-m3 embeddings through Ollama. The section's score is
 * its best sentence. Sections are split only in memory, from the text the model read; their
 * vectors are cached by a hash of that text, so a section embedded once is not embedded again.
 */
import { createHash } from 'node:crypto';
import { cosine, type EmbedFn } from './paragraphs.js';
import { cjkTokens, contentTokens, mainlyCjk, overlap } from './verify.js';

const CJK_CHAR = '[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]';
const CJK_GAP = new RegExp(`(${CJK_CHAR})\\s+(?=${CJK_CHAR}|[，、。；：！？（）《》“”])`, 'gu');
const CJK_GAP_AFTER = new RegExp(`([，、。；：！？（）《》“”])\\s+(?=${CJK_CHAR})`, 'gu');

/**
 * Words whose full stop does not end an English sentence. Nothing in the code base had such a
 * list before this round; it holds the forms the two corpora use (para. 5.88, e.g., No. 3).
 */
const ABBREVIATIONS = new Set(
  (
    'e.g i.e etc vs cf al no nos para paras art arts sec secs fig figs p pp ch vol ref refs approx incl ' +
    'mr mrs ms dr st inc ltd co corp jan feb mar apr jun jul aug sep sept oct nov dec min max est dept govt'
  ).split(' '),
);

/** English: after .!? (closing quotes or brackets allowed) and whitespace. Chinese: after 。！？；. */
const END = /[.!?]+["'”’)\]]*(?=\s)|[。！？；]+[」』”’）)]*/gu;

/**
 * Sentences of a section text. Line breaks are not boundaries (PDF text wraps inside sentences,
 * Chinese text at every line); a full stop after an abbreviation, a single letter (an initial or
 * a list marker such as g.) or a bare number (1. as a list marker) does not end one.
 */
export function sourceSentences(text: string): string[] {
  const flat = text.replace(CJK_GAP, '$1').replace(CJK_GAP_AFTER, '$1').replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  let from = 0;
  for (const m of flat.matchAll(END)) {
    const end = m.index! + m[0].length;
    if (m[0].startsWith('.')) {
      const before = /(\S+)$/.exec(flat.slice(from, m.index))?.[1] ?? '';
      const word = before.replace(/^["'“‘([]+/, '').toLowerCase();
      if (ABBREVIATIONS.has(word) || /^[a-z]$/i.test(word) || /^[ivx]+$/i.test(word) || /^\d+$/.test(word)) continue;
    }
    const s = flat.slice(from, end).trim();
    if (s) out.push(s);
    from = end;
  }
  const rest = flat.slice(from).trim();
  if (rest) out.push(rest);
  return out.filter((s) => /[\p{L}\p{N}]{2}/u.test(s));
}

interface CachedSection {
  sentences: string[];
  vectors: Float32Array[];
}

/**
 * Sentence vectors of sections, by a hash of the embedding model and the section text. Kept in
 * memory for the life of the process; the oldest section goes first past the limit.
 */
export class SentenceVectorCache {
  private map = new Map<string, CachedSection>();
  hits = 0;
  misses = 0;
  constructor(private readonly limit = 4000) {}

  static key(model: string, text: string): string {
    return createHash('sha256').update(model).update('\0').update(text).digest('hex').slice(0, 32);
  }

  get(key: string): CachedSection | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, v: CachedSection): void {
    this.map.set(key, v);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value!);
  }
}

export interface SentenceMatchDeps {
  embed: EmbedFn;
  model: string;
  cache: SentenceVectorCache;
}

export interface SentenceScores {
  /** Per answer sentence (by index), the score per source (index n - 1); undefined when not scored. */
  scores: (number[] | undefined)[];
  /** Per scored sentence and source, the best source sentence and which measure gave the score. */
  best: ({ sentence: string; overlap: number; cosine: number }[] | undefined)[];
  embedMs: number;
  sectionsEmbedded: number;
  sentencesEmbedded: number;
}

/**
 * Scores each answer sentence that wants it against every passage: per passage, the best of its
 * sentences by the larger of token overlap and embedding cosine. Sentences without two letters
 * or digits in a row are skipped, as verifyClaims skips them.
 */
export async function sentenceScores(
  sentences: string[],
  passages: string[],
  o: { cjk: boolean; deps: SentenceMatchDeps; signal?: AbortSignal },
): Promise<SentenceScores> {
  const t0 = performance.now();
  const want = sentences.map((s) => /[\p{L}\p{N}]{2}/u.test(s));
  const sections: CachedSection[] = [];
  const missing: { i: number; key: string; sentences: string[] }[] = [];
  passages.forEach((p, i) => {
    const key = SentenceVectorCache.key(o.deps.model, p);
    const hit = o.deps.cache.get(key);
    if (hit) {
      o.deps.cache.hits++;
      sections[i] = hit;
    } else {
      o.deps.cache.misses++;
      missing.push({ i, key, sentences: sourceSentences(p) });
    }
  });
  const toEmbed = [...missing.flatMap((m) => m.sentences), ...sentences.filter((_, k) => want[k])];
  const vectors = toEmbed.length ? await o.deps.embed(toEmbed, o.signal) : [];
  let at = 0;
  for (const m of missing) {
    const entry = { sentences: m.sentences, vectors: m.sentences.map(() => Float32Array.from(vectors[at++]!)) };
    o.deps.cache.set(m.key, entry);
    sections[m.i] = entry;
  }
  const answerVectors = sentences.map((_, k) => (want[k] ? vectors[at++]! : null));
  const tokensOf = (t: string, pairs: boolean) => (pairs ? cjkTokens(t) : contentTokens(t));
  const scores: (number[] | undefined)[] = [];
  const best: SentenceScores['best'] = [];
  sentences.forEach((s, k) => {
    const v = answerVectors[k];
    if (!v) return;
    const pairs = o.cjk && mainlyCjk(s);
    const tokens = tokensOf(s, pairs);
    const row: number[] = [];
    const why: { sentence: string; overlap: number; cosine: number }[] = [];
    for (const sec of sections) {
      let top = 0;
      let at2 = { sentence: '', overlap: 0, cosine: 0 };
      sec.sentences.forEach((x, j) => {
        const ov = overlap(tokens, new Set(tokensOf(x, pairs)));
        const cs = cosine(v, sec.vectors[j]!);
        const score = Math.max(ov, cs);
        if (score > top) [top, at2] = [score, { sentence: x, overlap: ov, cosine: cs }];
      });
      row.push(top);
      why.push(at2);
    }
    scores[k] = row;
    best[k] = why;
  });
  return {
    scores,
    best,
    embedMs: Math.round(performance.now() - t0),
    sectionsEmbedded: missing.length,
    sentencesEmbedded: toEmbed.length,
  };
}
