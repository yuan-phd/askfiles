/**
 * Citations in the model's streamed answer. The model writes [n] after a claim (also [1, 2], [1-3],
 * and the full-width 【1】 that Chinese output often uses). The stream may cut a citation anywhere,
 * so a bracket that could still become one is held back until the next chunk decides it.
 */

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
}

const END = /[.!?。！？]+["'”’）)]*\s+|[。！？]+|\n+/g;

/**
 * Sentences of the answer with the citations each one carries. A citation belongs to the sentence
 * it follows, also when it comes after the full stop. Citations outside 1 to max are dropped, so
 * a sentence citing only a source that does not exist counts as unsupported.
 */
export function claimsOf(parts: Part[], max: number): Claim[] {
  const claims: Claim[] = [];
  let cur: Claim = { text: '', citations: [], unsupported: false };
  const close = () => {
    if (cur.text.trim() || cur.citations.length) claims.push(cur);
    cur = { text: '', citations: [], unsupported: false };
  };
  for (const p of parts) {
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
      from = end;
      close();
    }
    cur.text += p.text.slice(from);
  }
  close();
  for (const c of claims) c.unsupported = c.citations.length === 0 && /[\p{L}\p{N}]{2}/u.test(c.text);
  return claims;
}
