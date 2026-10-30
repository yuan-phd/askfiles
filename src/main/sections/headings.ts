/**
 * Heading rules shared by the parsers and the browse index: numbering prefixes, and the quality
 * filter that keeps OCR noise and body sentences out of the outline (Session K, part 3).
 */

const CN_DIGITS = '一二三四五六七八九十百千零〇两';

// Applied in a loop, so stacked prefixes such as 第一章 1.1 or Part II Section 3 all go.
// Written for lower-case text; callers fold case first.
const PREFIXES: RegExp[] = [
  // 第一章, 第3节, 第十二条, 第二部分
  new RegExp(`^第[${CN_DIGITS}\\d]+[章节条部篇款项回卷编]分?\\s*`, 'u'),
  // 一、 二. 十一．
  new RegExp(`^[${CN_DIGITS}]+\\s*[、.]\\s*`, 'u'),
  // (一) (1) (a)
  new RegExp(`^\\(\\s*(?:[${CN_DIGITS}]+|\\d+|[a-z])\\s*\\)\\s*`, 'u'),
  // Chapter 3, Section 2.1, Part II, Article 5, Appendix A, § 4, with an optional colon or dot
  /^(?:chapter|section|part|article|appendix|annex|clause|§)\s*(?:\d+(?:\.\d+)*|[ivx]{1,6}\b|[a-z]\b)\s*[.:)-]?\s*/u,
  // 1.2.3 Scope, 1.2.3. Scope, 1) Scope, 1、总则. At most three digits per part, so a year such
  // as 2026 Budget keeps its year and does not group with 2025 Budget.
  /^\d{1,3}(?:\.\d{1,3})+\.?\s*/u,
  /^\d{1,3}\s*[.)、:-]?\s+/u,
  /^\d{1,3}[.)、:-]\s*/u,
  // I. II) iv. A. b) : a letter or roman numeral only with a closing mark and a space after it
  /^(?:[ivx]{1,6}|[a-z])[.)]\s+/u,
];

/** Removes leading numbering such as 1.2, 第一章, (a) or Chapter 3 from lower-case text. */
export function stripNumbering(text: string): string {
  let s = text;
  for (let i = 0; i < 8; i++) {
    const before = s;
    for (const re of PREFIXES) s = s.replace(re, '');
    s = s.trim();
    if (s === before) break;
  }
  return s;
}

export const MAX_HEADING_CHARS = 120;
/** Share of letters (CJK included) a heading needs among its visible characters. */
const MIN_LETTER_SHARE = 0.6;
// Sentence end. The question mark is left out on purpose: question headings (FAQ documents) are
// common and are real headings; a decision recorded in the Session K PR.
const SENTENCE_END = /[.。!！;；,，]$/u;
// Dot leaders and ellipses end table of contents lines, which are not headings either.
const LEADER = /(?:\.{3,}|…|·{3,})\s*\d*$/u;

/**
 * True when a heading candidate is a plausible heading: at most 120 characters, not ending like a
 * sentence, at least 60 percent letters or CJK characters among its visible characters once
 * leading numbering is set aside, so 2.1 Scope and 第一章 pass and 3.5 / 12 or a line of OCR
 * specks does not.
 */
export function isAcceptableHeading(title: string): boolean {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_HEADING_CHARS) return false;
  if (SENTENCE_END.test(t) || LEADER.test(t)) return false;
  const folded = t.normalize('NFKC').toLowerCase();
  // A heading that is only numbering words (第一章, Chapter 3) is measured as written.
  const rest = (stripNumbering(folded) || folded).replace(/\s+/g, '');
  const letters = rest.match(/\p{L}/gu)?.length ?? 0;
  return letters / rest.length >= MIN_LETTER_SHARE;
}
