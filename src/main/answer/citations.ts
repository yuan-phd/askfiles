/**
 * Citations in the model's streamed answer. The model writes [n] after a claim (also [1, 2], [1-3],
 * and the full-width 【1】 that Chinese output often uses). The stream may cut a citation anywhere,
 * so a bracket that could still become one is held back until the next chunk decides it.
 */
import { plainText } from './markdown.js';

export type Part = { type: 'text'; text: string } | { type: 'cite'; n: number };

const CITE = /[[【]\s*(\d{1,3}(?:\s*(?:[,，、;；]|-|–)\s*\d{1,3})*)\s*[\]】]/g;
/** An unclosed bracket that may still become a citation. */
const OPEN_TAIL = /[[【][\s\d,，、;；\-–]{0,16}$/;

/** Numbers of one citation body; 1-3 expands to 1, 2, 3 (at most 20). */
export function citationNumbers(body: string): number[] {
  const out: number[] = [];
  for (const piece of body.split(/[,，、;；]/)) {
    const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(piece);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = a; n <= Math.min(b, a + 19); n++) if (!out.includes(n)) out.push(n);
  }
  return out;
}

function partsOf(text: string): Part[] {
  const parts: Part[] = [];
  let from = 0;
  for (const m of text.matchAll(CITE)) {
    if (m.index! > from) parts.push({ type: 'text', text: text.slice(from, m.index) });
    for (const n of citationNumbers(m[1]!)) parts.push({ type: 'cite', n });
    from = m.index! + m[0].length;
  }
  if (from < text.length) parts.push({ type: 'text', text: text.slice(from) });
  return parts;
}

export class CitationStream {
  private held = '';

  /** Parts that are complete after this chunk; a possible citation at the end waits. */
  push(chunk: string): Part[] {
    const text = this.held + chunk;
    const tail = OPEN_TAIL.exec(text);
    const cut = tail ? tail.index : text.length;
    this.held = text.slice(cut);
    return partsOf(text.slice(0, cut));
  }

  /** Whatever is held, as text or a citation. */
  end(): Part[] {
    const rest = this.held;
    this.held = '';
    return rest ? partsOf(rest) : [];
  }
}

/** Parses a whole answer at once. */
export function parseCitations(text: string): Part[] {
  const s = new CitationStream();
  return [...s.push(text), ...s.end()];
}

/** Cited numbers in order of first citation, only those from 1 to max. */
export function citationOrder(parts: Part[], max: number): number[] {
  const out: number[] = [];
  for (const p of parts) if (p.type === 'cite' && p.n >= 1 && p.n <= max && !out.includes(p.n)) out.push(p.n);
  return out;
}

export interface Claim {
  text: string;
  /** Valid citations of this sentence, in the order written. */
  citations: number[];
  /** True for a sentence that cites nothing valid and has words in it. */
  unsupported: boolean;
  /** restatementExempt: an uncited sentence that only restates the question; neither cited nor unsupported. */
  restatement?: boolean;
  /** contentFreeExempt: a cited sentence with nothing of its own; its citations are not counted. */
  contentFree?: boolean;
  /** leadInExempt: an uncited lead-in ending with a colon before cited sentences; neither cited nor unsupported. */
  leadIn?: boolean;
  /** After verification: each citation's score against its source, in citation order. */
  support?: number[];
  /** After verification: the score a citation needed (the threshold the sentence was held to). */
  minSupport?: number;
  /** The sentence as the model wrote it, with its Markdown, when that differs from text (claimsOf). */
  markdown?: string;
}

const END = /[.!?。！？]+["'”’）)]*\s+|[。！？]+|\n+/g;

/** Index of the first entry of the sorted list that is at least x. */
function lowerBound(list: number[], x: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Sentences of the answer with the citations each one carries. A citation belongs to the sentence
 * it follows, also when it comes after the full stop. Citations outside 1 to max are dropped, so
 * a sentence citing only a source that does not exist counts as unsupported.
 *
 * Sentences are split on the answer without its Markdown syntax (markdown.ts), and text is that
 * plain sentence, which every check reads; markdown keeps the same stretch of the reply as written,
 * for the Ask page, when it differs. The kept claims' markdown spans tile the reply.
 */
export function claimsOf(parts: Part[], max: number): Claim[] {
  let raw = '';
  const at: { pos: number; n: number }[] = [];
  for (const p of parts) {
    if (p.type === 'cite') at.push({ pos: raw.length, n: p.n });
    else raw += p.text;
  }
  const { plain, map } = plainText(raw);
  // The same walk as over the parts, on the plain text: a citation stands where its raw position falls.
  const merged: Part[] = [];
  let from = 0;
  for (const c of at) {
    const to = lowerBound(map, c.pos);
    if (to > from) merged.push({ type: 'text', text: plain.slice(from, to) });
    merged.push({ type: 'cite', n: c.n });
    from = Math.max(from, to);
  }
  if (from < plain.length) merged.push({ type: 'text', text: plain.slice(from) });

  const claims: (Claim & { end: number })[] = [];
  let cur: Claim = { text: '', citations: [], unsupported: false };
  let pos = 0;
  const close = () => {
    if (cur.text.trim() || cur.citations.length) claims.push({ ...cur, end: pos });
    cur = { text: '', citations: [], unsupported: false };
  };
  for (const p of merged) {
    if (p.type === 'cite') {
      if (p.n < 1 || p.n > max) continue;
      // After a closed sentence with only whitespace since, the citation is that sentence's.
      const target = !cur.text.trim() && claims.length ? claims[claims.length - 1]! : cur;
      if (!target.citations.includes(p.n)) target.citations.push(p.n);
      continue;
    }
    let from = 0;
    for (const m of p.text.matchAll(END)) {
      const end = m.index! + m[0].length;
      cur.text += p.text.slice(from, end);
      pos += end - from;
      from = end;
      close();
    }
    cur.text += p.text.slice(from);
    pos += p.text.length - from;
  }
  close();
  // A sentence's stretch of the reply ends after the last plain character it holds; the syntax
  // before the next sentence's first character (its list marker, an opening **) is the next one's.
  let rawFrom = 0;
  return claims.map(({ end, ...c }, k) => {
    const rawTo = k === claims.length - 1 || end >= plain.length ? raw.length : end > 0 ? map[end - 1]! + 1 : 0;
    const markdown = raw.slice(rawFrom, rawTo);
    rawFrom = rawTo;
    c.unsupported = c.citations.length === 0 && /[\p{L}\p{N}]{2}/u.test(c.text);
    return markdown === c.text ? c : { ...c, markdown };
  });
}
