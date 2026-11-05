/**
 * Sentences of a section text as the model read it, for verification at sentence level (rounds D2
 * and D3, docs/plan.md). Only in memory; no sentence index is stored.
 */
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
