// Display-only clean-up of section paths and passages, shared by the Ask, Compare and Browse pages.
// The index, the passages the model reads and citation verification never go through it.

/** A part the splitter cut from one section: T (page N) or T (continued); as src/main/browse/build.ts. */
export const PAGE_PART = /\s*\((?:page \d+|continued)\)\s*$/i;

/** A section title without its part marker: the logical section the part belongs to. */
export function sectionTitle(title) {
  return String(title ?? '')
    .replace(PAGE_PART, '')
    .trim();
}

/**
 * The displayed path of a section: each level without its part marker, and a level that repeats
 * the one above it once the marker is gone dropped, so a section cut by page or continued after a
 * table shows its logical parent once. The page has a line of its own on every card.
 */
export function displayPath(path, title) {
  const levels = (Array.isArray(path) && path.length ? path : [title]).map(sectionTitle).filter(Boolean);
  return levels.filter((t, i) => i === 0 || t !== levels[i - 1]).join(' > ');
}

const ROMAN = /^(?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;

function isPageNumber(s) {
  return /^\d{1,3}$/.test(s) || ROMAN.test(s.toLowerCase());
}

/**
 * A passage without the printed page number its text layer starts with: a first line that is
 * only digits (up to three) or a roman numeral (12, iv, XI), or a page number glued to the
 * capitalised heading that follows it (iiiIntroduction, 12Scope; a glued roman numeral has two
 * letters at least). Display only.
 */
export function withoutLeadingPageNumber(text) {
  const s = String(text ?? '');
  const lead = /^\s*/.exec(s)[0];
  const rest = s.slice(lead.length);
  const nl = rest.indexOf('\n');
  const first = (nl === -1 ? rest : rest.slice(0, nl)).trim();
  if (isPageNumber(first)) return nl === -1 ? '' : rest.slice(nl + 1).replace(/^\s*\n/, '');
  // Two letters at least: a single glued i or v starts words like iPad.
  const glued = /^(\d{1,3}|[ivxlcdm]{2,8})(?=\p{Lu}\p{Ll})/u.exec(rest);
  if (glued && isPageNumber(glued[1])) return rest.slice(glued[1].length);
  return s;
}
