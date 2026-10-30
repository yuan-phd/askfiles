/**
 * Heading normalization for the cross-document heading index (plan task 4.4): the same heading in
 * two files must give the same key even when one numbers it, writes it in full-width forms or in
 * another case. Only the key is normalized; pages always show the heading as written.
 */

const CN_DIGITS = '一二三四五六七八九十百千零〇两';

// Applied in a loop, so stacked prefixes such as 第一章 1.1 or Part II Section 3 all go.
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

const PUNCTUATION = /[\p{P}\p{S}]+/gu;

/** NFKC turns full-width letters, digits and most punctuation into their ASCII forms. */
function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function stripNumbering(text: string): string {
  let s = text;
  for (let i = 0; i < 8; i++) {
    const before = s;
    for (const re of PREFIXES) s = s.replace(re, '');
    s = s.trim();
    if (s === before) break;
  }
  return s;
}

function stripPunctuation(text: string): string {
  return text.replace(PUNCTUATION, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Key of a heading: NFKC (full-width to half-width), lower case, numbering prefixes removed,
 * punctuation and symbols removed, whitespace collapsed. A heading that is nothing but numbering,
 * such as 第一章 alone, keeps its numbering, so all such headings do not fall into one group.
 */
export function normalizeHeading(title: string): string {
  const folded = fold(title);
  return stripPunctuation(stripNumbering(folded)) || stripPunctuation(folded);
}
