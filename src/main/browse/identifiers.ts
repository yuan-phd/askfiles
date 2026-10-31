/**
 * Per file the names a question may use for it (documentAffinity, docs/plan.md round 7): the file
 * name, its title, and document type words that identify exactly one file of the library. Built
 * from the browse documents when the index changes; the answer pipeline looks for them in the
 * question. No model is involved.
 */
import type { BrowseDocument } from './types.js';

export interface FileIdentity {
  documentId: string;
  /** File name with its extension. */
  file: string;
  /** The title on the document's first page, from its top-level outline entries; '' when none. */
  title: string;
  /** The document type word of its name or title (Policy, Guidance, Template...); '' when none. */
  type: string;
  /** Strings that name this file and no other. */
  identifiers: Identifier[];
}

export interface Identifier {
  text: string;
  /**
   * A bare type word matches only as a name, capitalized (the Procedure), never as the common
   * noun (a streamlined procedure); names of several words match in any case.
   */
  caseSensitive: boolean;
}

/** Type words, longest first so Request for Bids wins over a shorter match. */
const TYPE_WORDS = [
  'Request for Proposals',
  'Request for Bids',
  'Regulations',
  'Guidelines',
  'Memorandum',
  'Directive',
  'Procedure',
  'Guidance',
  'Handbook',
  'Template',
  'Policy',
  'Manual',
];

/** Top-level outline entries up to this many make the title. */
const TITLE_ENTRIES = 4;

function fold(t: string): string {
  return t.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 01_Procurement_Regulations_2025.pdf: Procurement Regulations 2025, and without the year. */
function nameForms(file: string): string[] {
  const stem = file.replace(/\.[^.]+$/, '');
  const spaced = stem
    .replace(/[_-]+/g, ' ')
    .replace(/^\d+\s+/, '')
    .trim();
  const noYear = spaced.replace(/\s+(19|20)\d\d$/, '').trim();
  return [...new Set([file, stem, spaced, noYear])].filter((x) => x.split(' ').length >= 2 || x === file || x === stem);
}

/**
 * Top-level entries on the first page of a PDF; a cover title often spans several. Word and Excel
 * outlines are headings and sheet names, not a title, so those files have none.
 */
function titleEntries(doc: BrowseDocument): string[] {
  const out: string[] = [];
  if (!/\.pdf$/i.test(doc.title)) return out;
  for (const e of doc.outline) {
    if (out.length >= TITLE_ENTRIES || e.page === null || e.page > 1) break;
    if (e.level <= 1) out.push(e.title.replace(/\s+/g, ' ').trim());
  }
  return out.filter(Boolean);
}

function typeOf(text: string): string {
  const f = fold(text);
  return TYPE_WORDS.find((w) => new RegExp(`\\b${fold(w)}\\b`).test(f)) ?? '';
}

/** The identity of every document; an identifier that would name two files is left out of both. */
export function buildIdentities(docs: BrowseDocument[]): FileIdentity[] {
  const candidates = docs.map((d) => {
    const entries = titleEntries(d);
    const title = entries.join(' ');
    const names = nameForms(d.title);
    const spaced = names[names.length - 1] ?? d.title;
    const phrases = [
      ...names.map((text) => ({ text, caseSensitive: false })),
      // A cover line that ends in a type word (Bank Procedure); other lines are fragments (VALUE FOR).
      ...entries
        .filter((e) => e.split(' ').length >= 2 && TYPE_WORDS.some((w) => fold(e).endsWith(` ${fold(w)}`)))
        .map((text) => ({ text, caseSensitive: false })),
    ];
    if (title.split(' ').length >= 2) phrases.push({ text: title, caseSensitive: false });
    return { d, title, spaced, type: typeOf(spaced) || typeOf(title), phrases };
  });
  // A type word names a file only when no other file has it; else the word before it in the name
  // makes it specific (Strategy Guidance, Management Guidance).
  const typeCount = new Map<string, number>();
  for (const c of candidates) if (c.type) typeCount.set(c.type, (typeCount.get(c.type) ?? 0) + 1);
  for (const c of candidates) {
    if (!c.type) continue;
    if (typeCount.get(c.type) === 1) {
      c.phrases.push({ text: c.type, caseSensitive: true });
      continue;
    }
    const words = c.spaced.split(' ');
    const at = words.findIndex((w) => fold(w) === fold(c.type));
    if (at > 0) c.phrases.push({ text: `${words[at - 1]} ${c.type}`, caseSensitive: false });
  }
  const owners = new Map<string, Set<string>>();
  for (const c of candidates)
    for (const p of c.phrases) {
      const k = fold(p.text);
      if (!owners.has(k)) owners.set(k, new Set());
      owners.get(k)!.add(c.d.id);
    }
  return candidates.map((c) => {
    const seen = new Set<string>();
    const identifiers = c.phrases.filter((p) => {
      const k = `${fold(p.text)}|${p.caseSensitive}`;
      if (seen.has(k) || owners.get(fold(p.text))!.size !== 1) return false;
      seen.add(k);
      return true;
    });
    return { documentId: c.d.id, file: c.d.title, title: c.title, type: c.type, identifiers };
  });
}

function escape(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether the question names the identifier as a whole word sequence. */
function mentions(question: string, id: Identifier): boolean {
  const words = id.text
    .trim()
    .split(/[\s_]+/)
    .map(escape)
    .join('[\\s_]+');
  if (id.caseSensitive) {
    // Capitalized or all capitals, never lower case.
    const upper = id.text.toUpperCase().split(/\s+/).map(escape).join('\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${words}|${upper})(?![\\p{L}\\p{N}])`, 'u').test(question);
  }
  return new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'iu').test(question.normalize('NFKC'));
}

/** The documents the question names, in library order. */
export function mentionedDocuments(question: string, identities: FileIdentity[]): FileIdentity[] {
  return identities.filter((f) => f.identifiers.some((id) => mentions(question, id)));
}
