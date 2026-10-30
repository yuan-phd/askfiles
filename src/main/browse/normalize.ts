/**
 * Heading normalization for the cross-document heading index (plan task 4.4): the same heading in
 * two files must give the same key even when one numbers it, writes it in full-width forms or in
 * another case. Only the key is normalized; pages always show the heading as written.
 */

import { stripNumbering } from '../sections/headings.js';

const PUNCTUATION = /[\p{P}\p{S}]+/gu;

/** NFKC turns full-width letters, digits and most punctuation into their ASCII forms. */
function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
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
