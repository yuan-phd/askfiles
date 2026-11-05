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
  /**
   * identifiers plus the name forms this file shares with files of the same name in another
   * format (必须招标的工程项目规定 for the .pdf and the .docx): crossDocument counts such a name
   * as one mention of both files. Absent in identities built before round A2.
   */
  names?: Identifier[];
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

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** True for a name with Chinese, Japanese or Korean characters, which is matched without word boundaries. */
function isCjkName(text: string): boolean {
  return CJK.test(text);
}

/**
 * 01_Procurement_Regulations_2025.pdf: Procurement Regulations 2025, and without the year. A CJK
 * name has no spaces, so its title is the first part before an underscore with the number prefix
 * removed: 01_标准设备采购招标文件_2017年版.pdf is 标准设备采购招标文件, the form a question
 * writes in title marks (《标准设备采购招标文件》).
 */
export function nameForms(file: string): string[] {
  const stem = file.replace(/\.[^.]+$/, '');
  const spaced = stem
    .replace(/[_-]+/g, ' ')
    .replace(/^\d+\s+/, '')
    .trim();
  const noYear = spaced.replace(/\s+(19|20)\d\d$/, '').trim();
  const cjkTitle = stem
    .replace(/^\d+[_\s-]+/, '')
    .split('_')[0]!
    .trim();
  const cjk = isCjkName(cjkTitle) && [...cjkTitle].length >= 4 ? [cjkTitle] : [];
  return [
    ...new Set([file, stem, ...[spaced, noYear].filter((x) => x.split(' ').length >= 2 && !isCjkName(x)), ...cjk]),
  ];
}

/**
 * Markers of a derived copy at the end of a file name part (14_..._衍生.xlsx, 15_..._网页正文.txt):
 * not part of the document's name. Matched as whole underscore- or space-separated parts, Latin
 * ones in any case.
 */
export const DERIVED_COPY_MARKERS = ['网页正文', '衍生', '副本', 'copy', 'draft'];

/**
 * The name a source header shows for a file (sourceFileNames, docs/plan.md round N1): the file
 * name without its leading sequence number and its extension, derived-copy markers left out, year
 * and version markers kept (2025, 2017年版, 试行), underscores as spaces, spaces collapsed.
 * 01_Procurement_Regulations_2025.pdf is Procurement Regulations 2025; 01_标准设备采购招标文件_2017年版.pdf
 * is 标准设备采购招标文件 2017年版. Falls back to the file name when nothing is left.
 */
export function displayName(file: string): string {
  const markers = new Set(DERIVED_COPY_MARKERS.map((m) => m.toLowerCase()));
  const name = file
    .replace(/\.[^.\s]{1,5}$/, '')
    .replace(/^\d+(?:[_\s-]+|$)/, '')
    .split(/[_\s]+/)
    .filter((part) => part && !markers.has(part.toLowerCase()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name || file;
}

/**
 * questionFileNames (docs/plan.md round N2): in the question text sent to the model, every
 * indexed file name written whole with its extension (in backticks or not, on word boundaries)
 * becomes its display name followed by the file name in parentheses. The retrieval query is not
 * changed by this.
 */
export function rewriteFileNames(question: string, files: string[]): string {
  let out = question;
  // Longest first, so a file name inside another one is not replaced first.
  for (const file of [...new Set(files)].sort((a, b) => b.length - a.length)) {
    const name = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\`${name}\`|(?<![\\p{L}\\p{N}_.])${name}(?![\\p{L}\\p{N}_])`, 'gu');
    out = out.replace(re, () => `${displayName(file)} (${file})`);
  }
  return out;
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
    const phrases: (Identifier & { fromName?: boolean })[] = [
      ...names.map((text) => ({ text, caseSensitive: false, fromName: true })),
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
  // A name form several files share is a name of each when it comes from every owner's file name.
  const fromNames = new Map<string, Set<string>>();
  for (const c of candidates)
    for (const p of c.phrases)
      if (p.fromName) {
        const k = fold(p.text);
        if (!fromNames.has(k)) fromNames.set(k, new Set());
        fromNames.get(k)!.add(c.d.id);
      }
  const plain = (p: Identifier): Identifier => ({ text: p.text, caseSensitive: p.caseSensitive });
  return candidates.map((c) => {
    const seen = new Set<string>();
    const identifiers = c.phrases.filter((p) => {
      const k = `${fold(p.text)}|${p.caseSensitive}`;
      if (seen.has(k) || owners.get(fold(p.text))!.size !== 1) return false;
      seen.add(k);
      return true;
    });
    const shared = c.phrases.filter((p) => {
      const k = fold(p.text);
      const n = owners.get(k)!.size;
      return p.fromName && n > 1 && fromNames.get(k)!.size === n && !seen.has(`${k}|${p.caseSensitive}`);
    });
    return {
      documentId: c.d.id,
      file: c.d.title,
      title: c.title,
      type: c.type,
      identifiers: identifiers.map(plain),
      names: [...identifiers, ...shared].map(plain),
    };
  });
}

function escape(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where the question names the identifier as a whole word sequence, -1 when it does not; a CJK
 * name anywhere, spaces ignored (the position is then in the text without spaces).
 */
function mentionAt(question: string, id: Identifier): number {
  if (isCjkName(id.text)) return fold(question).replace(/\s+/g, '').indexOf(fold(id.text).replace(/\s+/g, ''));
  const words = id.text
    .trim()
    .split(/[\s_]+/)
    .map(escape)
    .join('[\\s_]+');
  if (id.caseSensitive) {
    // Capitalized or all capitals, never lower case.
    const upper = id.text.toUpperCase().split(/\s+/).map(escape).join('\\s+');
    return question.search(new RegExp(`(?<![\\p{L}\\p{N}])(?:${words}|${upper})(?![\\p{L}\\p{N}])`, 'u'));
  }
  return question.normalize('NFKC').search(new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'iu'));
}

function mentions(question: string, id: Identifier): boolean {
  return mentionAt(question, id) >= 0;
}

/** The documents the question names, in library order. */
export function mentionedDocuments(question: string, identities: FileIdentity[]): FileIdentity[] {
  return identities.filter((f) => f.identifiers.some((id) => mentions(question, id)));
}

/**
 * The files a text names, one group per name, in the order the text names them (crossDocument,
 * docs/plan.md round A2): a name that several files share by their file names (the same
 * regulation as .pdf and .docx) is one group of all of them; a group inside another (the file
 * name and its title) counts once. A question naming two or more groups asks about several
 * documents.
 */
export function namedFileGroups(text: string, identities: FileIdentity[]): FileIdentity[][] {
  const byName = new Map<string, { docs: Set<string>; at: number }>();
  for (const f of identities)
    for (const id of f.names ?? f.identifiers) {
      const at = mentionAt(text, id);
      if (at < 0) continue;
      const k = fold(id.text);
      const g = byName.get(k) ?? { docs: new Set<string>(), at };
      g.docs.add(f.documentId);
      byName.set(k, g);
    }
  const kept: { docs: Set<string>; at: number }[] = [];
  for (const g of [...byName.values()].sort((a, b) => b.docs.size - a.docs.size || a.at - b.at)) {
    const outer = kept.find((k) => [...g.docs].every((d) => k.docs.has(d)));
    if (outer) outer.at = Math.min(outer.at, g.at);
    else kept.push({ ...g });
  }
  // In the order the text names them; files of one group in library order.
  return kept.sort((a, b) => a.at - b.at).map((g) => identities.filter((f) => g.docs.has(f.documentId)));
}
