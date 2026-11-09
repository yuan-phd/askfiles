/**
 * The answer without its Markdown syntax, for sentence splitting and verification. The model may
 * write lists (1. , - , * ), bold, italic and inline code; the Ask page renders them
 * (src/renderer/shared/markdown.js), and every check reads the text without them, so formatting
 * never changes a score or where a sentence ends. A list number would otherwise be a sentence of
 * its own, or a content token, and a bold full stop (**Note.** Next) would hide a sentence end.
 *
 * This is the main process copy of scanLines, scanInline (without the streaming options) and
 * plainText of the renderer module; src/renderer/shared/markdown.test.js checks that both remove
 * the same characters.
 */

const ITEM = /^([ \t]*)([*+-]|\d{1,9}[.)])([ \t]+|$)/;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef\u3000-\u303f]/;
const SPACE = /\s/u;
// Private-use characters stand in for citations and the unsupported marker on the Ask page; next
// to a delimiter they count as punctuation, as the [n] they replace would.
const PUNCT = /[\p{P}\p{S}\p{Co}]/u;

const isSpace = (ch: string | undefined) => ch === undefined || SPACE.test(ch);
const isPunct = (ch: string | undefined) => ch !== undefined && (PUNCT.test(ch) || CJK.test(ch));

type Range = [number, number];

interface Delim {
  ch: string;
  len: number;
  lo: number;
  hi: number;
  canOpen: boolean;
  canClose: boolean;
  dead: boolean;
}

/** Syntax characters of one line's content src[from, to): escapes, code span backticks, paired delimiters. */
export function inlineSyntax(src: string, from: number, to: number): Range[] {
  const removed: Range[] = [];
  const delims: Delim[] = [];
  let i = from;
  while (i < to) {
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < to && ESCAPABLE.test(src[i + 1]!)) {
      removed.push([i, i + 1]);
      i += 2;
      continue;
    }
    if (ch === '`') {
      let n = 1;
      while (i + n < to && src[i + n] === '`') n++;
      let j = i + n;
      let close = -1;
      while (j < to) {
        if (src[j] !== '`') {
          j++;
          continue;
        }
        let m = 1;
        while (j + m < to && src[j + m] === '`') m++;
        if (m === n) {
          close = j;
          break;
        }
        j += m;
      }
      if (close < 0) {
        i += n;
        continue;
      }
      let a = i + n;
      let b = close;
      if (b - a >= 2 && src[a] === ' ' && src[b - 1] === ' ' && /[^ ]/.test(src.slice(a, b))) {
        a++;
        b--;
      }
      removed.push([i, a], [b, close + n]);
      i = close + n;
      continue;
    }
    if (ch === '*' || ch === '_') {
      let n = 1;
      while (i + n < to && src[i + n] === ch) n++;
      const before = i > from ? src[i - 1] : undefined;
      const after = i + n < to ? src[i + n] : undefined;
      const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      const canOpen = ch === '*' ? left : left && (!right || isPunct(before));
      const canClose = ch === '*' ? right : right && (!left || isPunct(after));
      delims.push({ ch, len: n, lo: i, hi: i + n, canOpen, canClose, dead: false });
      i += n;
      continue;
    }
    i++;
  }
  // CommonMark's process emphasis, as in the renderer module.
  for (let c = 0; c < delims.length; c++) {
    const closer = delims[c]!;
    if (!closer.canClose) continue;
    while (closer.hi > closer.lo) {
      let o = c - 1;
      for (; o >= 0; o--) {
        const d = delims[o]!;
        if (d.dead || d.ch !== closer.ch || !d.canOpen || d.hi === d.lo) continue;
        const odd =
          (d.canClose || closer.canOpen) && (d.len + closer.len) % 3 === 0 && (d.len % 3 !== 0 || closer.len % 3 !== 0);
        if (!odd) break;
      }
      if (o < 0) break;
      const opener = delims[o]!;
      const use = opener.hi - opener.lo >= 2 && closer.hi - closer.lo >= 2 ? 2 : 1;
      removed.push([opener.hi - use, opener.hi], [closer.lo, closer.lo + use]);
      opener.hi -= use;
      closer.lo += use;
      for (let k = o + 1; k < c; k++) delims[k]!.dead = true;
    }
  }
  return removed.sort((a, b) => a[0] - b[0]);
}

/** Every syntax character of src as sorted [from, to) ranges: list markers (with indentation and the spaces after) and inline syntax. */
export function syntaxRanges(src: string): Range[] {
  const out: Range[] = [];
  let start = 0;
  while (start <= src.length) {
    let end = src.indexOf('\n', start);
    if (end < 0) end = src.length;
    const line = src.slice(start, end);
    if (line.trim()) {
      const m = ITEM.exec(line);
      const from = m ? start + m[0].length : start;
      if (m) out.push([start, from]);
      out.push(...inlineSyntax(src, from, end));
    }
    if (end === src.length) break;
    start = end + 1;
  }
  return out.filter(([a, b]) => b > a);
}

/** src without its Markdown syntax, and map[i], the index in src of plain[i]. */
export function plainText(src: string): { plain: string; map: number[] } {
  const ranges = syntaxRanges(src);
  let plain = '';
  const map: number[] = [];
  let r = 0;
  for (let i = 0; i < src.length; i++) {
    while (r < ranges.length && ranges[r]![1] <= i) r++;
    if (r < ranges.length && i >= ranges[r]![0]) continue;
    plain += src[i];
    map.push(i);
  }
  return { plain, map };
}
