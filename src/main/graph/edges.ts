/**
 * Edges of the library graph (docs/graph.md, Edges), each with a kind and a weight, from the
 * browse index only: no model. Which rules run is the profile's choice (profiles.ts edges). A pair
 * linked twice by the same rule, once in each direction, becomes one edge with the weights summed.
 */
import { buildIdentities } from '../browse/identifiers.js';
import { snippetOf } from '../browse/search.js';
import type { BrowseDocument } from '../browse/types.js';
import { contentTokens } from '../answer/verify.js';
import { documentDate } from './dates.js';
import { datedApart, type FamilyResult } from './families.js';
import { TICKET_ID } from './kinds.js';
import { titleWords, type EdgeRule, type Profile } from './profiles.js';

export const EDGE_KINDS = ['headings', 'reference', 'version', 'related', 'project', 'ticket', 'date'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Where one document mentions another: the section and the words around the mention. */
export interface Passage {
  /** The document whose text holds the mention. */
  documentId: string;
  sectionIndex: number;
  sectionTitle: string;
  snippet: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
  /** headings: the shared headings, most common spelling. */
  headings?: { key: string; label: string }[];
  /** reference: the referencing passages, at most PASSAGES_PER_EDGE. */
  passages?: Passage[];
  /** related, project, ticket: the shared terms or ids, at most 8. */
  terms?: string[];
  /** version: the two are the same issue in two formats (PDF and Word), not two issues. */
  sameIssue?: boolean;
}

/** Shared headings needed for an edge. */
export const MIN_SHARED_HEADINGS = 2;
/**
 * relatedness (general profile): rare terms are content words of four or more letters and CJK
 * character pairs found in at least 2 documents and at most 10 percent of them (2 in a small
 * library). A pair needs RELATED_MIN_SHARED of them in common and a set cosine (shared over the
 * geometric mean of both sets) of RELATED_MIN_SCORE, and must be among the RELATED_PER_DOCUMENT
 * best pairs of both its documents.
 */
export const RELATED_MIN_SHARED = 5;
export const RELATED_MIN_SCORE = 0.08;
export const RELATED_PER_DOCUMENT = 3;
/** date adjacency: the most days between two documents of one type. */
export const DATE_ADJACENT_DAYS = 31;
const PASSAGES_PER_EDGE = 5;
const MAX_TERMS = 8;
const TEXT_LIMIT = 150_000;

const CJK_CHAR = '[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]';
const CJK = new RegExp(CJK_CHAR);
const CJK_GAP = new RegExp(`(${CJK_CHAR})\\s+(?=${CJK_CHAR})`, 'gu');

/** NFKC, lower case, the spaces PDF text puts between CJK characters closed up, whitespace collapsed. */
export function foldText(t: string): string {
  return t.normalize('NFKC').toLowerCase().replace(CJK_GAP, '$1').replace(/\s+/g, ' ');
}

/** A heading key that is only numbering (第一章, chapter 3, 12): it names no subject. */
const NUMBERING_ONLY =
  /^(?:第[一二三四五六七八九十百千零〇两\d]+[章节条部分款项编篇]|(?:chapter|part|section|article|annex|appendix|schedule) ?[\divxlc]+|[\divxlc]{1,6}|[a-z])$/;

/** The chunker's titles for the pages of a long section and for continued tables. */
const PAGE_PART = /\s*\((?:page \d+|continued)\)\s*$/i;

/**
 * The heading key an edge counts: the browse key without a page or continued suffix, so the six
 * page parts of one long section count once; '' for numbering alone.
 */
export function edgeHeading(heading: string): string {
  const k = heading.replace(/ (?:page \d+|continued)$/, '').trim();
  return !k || NUMBERING_ONLY.test(k) ? '' : k;
}

class EdgeSet {
  private readonly map = new Map<string, GraphEdge>();
  add(e: Omit<GraphEdge, 'id'>): void {
    if (e.source === e.target) return;
    const [a, b] = e.source < e.target ? [e.source, e.target] : [e.target, e.source];
    const id = `${e.kind}:${a}:${b}`;
    const old = this.map.get(id);
    if (!old) {
      this.map.set(id, { id, ...e });
      return;
    }
    // The pair in the other direction (or again): one edge, weights summed, details joined.
    old.weight += e.weight;
    if (e.passages) old.passages = [...(old.passages ?? []), ...e.passages].slice(0, PASSAGES_PER_EDGE);
    if (e.terms) old.terms = [...new Set([...(old.terms ?? []), ...e.terms])].slice(0, MAX_TERMS);
    if (e.headings) {
      const keys = new Set((old.headings ?? []).map((h) => h.key));
      old.headings = [...(old.headings ?? []), ...e.headings.filter((h) => !keys.has(h.key))];
    }
  }
  list(): GraphEdge[] {
    return [...this.map.values()].sort((x, y) => x.id.localeCompare(y.id));
  }
}

// --- shared headings ---------------------------------------------------------------------------

function sharedHeadings(docs: BrowseDocument[], out: EdgeSet): void {
  const docsOf = new Map<string, Set<string>>();
  const spellings = new Map<string, Map<string, number>>();
  for (const d of docs) {
    for (const s of d.sections) {
      const key = edgeHeading(s.heading);
      if (!key) continue;
      docsOf.set(key, (docsOf.get(key) ?? new Set()).add(d.id));
      const sp = spellings.get(key) ?? new Map<string, number>();
      const title = s.title.replace(PAGE_PART, '').trim();
      sp.set(title, (sp.get(title) ?? 0) + 1);
      spellings.set(key, sp);
    }
  }
  const pairs = new Map<string, string[]>();
  for (const [key, ids] of docsOf) {
    if (ids.size < 2) continue;
    const list = [...ids].sort();
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const p = `${list[i]}|${list[j]}`;
        pairs.set(p, [...(pairs.get(p) ?? []), key]);
      }
  }
  const label = (key: string) => [...spellings.get(key)!.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  for (const [p, keys] of pairs) {
    if (keys.length < MIN_SHARED_HEADINGS) continue;
    const [a, b] = p.split('|') as [string, string];
    keys.sort();
    out.add({
      source: a,
      target: b,
      kind: 'headings',
      weight: keys.length,
      headings: keys.map((key) => ({ key, label: label(key) })),
    });
  }
}

// --- references --------------------------------------------------------------------------------

interface Names {
  /** Names that stand for the document on their own: several words, or four CJK characters. */
  strong: string[];
  /** Single type words (Regulations), counted only after a clause reference (Article 5 of the). */
  weak: string[];
}

/** The names other documents may use for d, folded; from the browse identifiers. */
function namesOf(docs: BrowseDocument[]): Map<string, Names> {
  const out = new Map<string, Names>();
  for (const id of buildIdentities(docs)) {
    const strong = new Set<string>();
    const weak = new Set<string>();
    for (const n of [...id.identifiers, ...(id.names ?? [])]) {
      const t = foldText(n.text).trim();
      if (/\.[a-z0-9]{2,5}$/.test(t) || /_/.test(t)) continue;
      const cjk = (t.match(new RegExp(CJK_CHAR, 'g')) ?? []).length;
      if (cjk >= 4 || (cjk === 0 && t.split(' ').length >= 2 && t.length >= 8)) strong.add(t);
      else if (cjk === 0 && n.caseSensitive && t.length >= 5) weak.add(n.text.normalize('NFKC'));
    }
    out.set(id.documentId, { strong: [...strong], weak: [...weak] });
  }
  return out;
}

const CLAUSE_BEFORE =
  /\b(?:article|section|paragraph|clause|annex|appendix|schedule|chapter|part|para)s?\.?\s+[\w.()-]+(?:\s*(?:,|and|to|or)\s*[\w.()-]+)*\s+of\s+(?:the|this|that)?\s*$/i;

function mentionAt(hay: string, name: string): number {
  if (CJK.test(name)) return hay.indexOf(name);
  // Whole word sequence: no letter or digit on either side.
  let from = 0;
  for (;;) {
    const i = hay.indexOf(name, from);
    if (i < 0) return -1;
    const before = hay[i - 1] ?? ' ';
    const after = hay[i + name.length] ?? ' ';
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return i;
    from = i + 1;
  }
}

/** The weak name used as the object of a clause reference: Article 5 of the Regulations. */
function clauseMention(text: string, name: string): number {
  let from = 0;
  for (;;) {
    const i = text.indexOf(name, from);
    if (i < 0) return -1;
    if (!/[\p{L}\p{N}]/u.test(text[i + name.length] ?? ' ') && CLAUSE_BEFORE.test(text.slice(Math.max(0, i - 120), i)))
      return i;
    from = i + 1;
  }
}

/** Titles in Chinese title marks: 《标准施工招标文件》. */
function bookTitles(hay: string): string[] {
  return [...hay.matchAll(/《([^《》]{2,60})》/g)].map((m) => m[1]!.replace(/\s+/g, ''));
}

function references(docs: BrowseDocument[], families: FamilyResult, clauses: boolean, out: EdgeSet): void {
  const names = namesOf(docs);
  const sectionHay = new Map(docs.map((d) => [d.id, d.sections.map((s) => foldText(`${s.title}\n${s.text}`))]));
  for (const a of docs) {
    const hays = sectionHay.get(a.id)!;
    const whole = hays.join('\n').slice(0, TEXT_LIMIT * 2);
    const flatWhole = whole.replace(/\s+/g, '');
    const marksOf = hays.map(bookTitles);
    for (const b of docs) {
      if (a.id === b.id) continue;
      const fa = families.familyOf.get(a.id);
      if (fa && fa === families.familyOf.get(b.id)) continue;
      const n = names.get(b.id);
      if (!n) continue;
      const cjkNames = n.strong.filter((x) => CJK.test(x)).map((x) => x.replace(/\s+/g, ''));
      const latinNames = n.strong.filter((x) => !CJK.test(x));
      // Quick rejection over the whole text before the per-section search.
      const maybe =
        latinNames.some((x) => whole.includes(x)) ||
        cjkNames.some((x) => flatWhole.includes(x)) ||
        (clauses && n.weak.length > 0);
      if (!maybe) continue;
      /** The name of b this section uses, or null. */
      const mentioned = (i: number): string | null => {
        const hay = hays[i]!;
        const latin = latinNames.find((x) => mentionAt(hay, x) >= 0);
        if (latin) return latin;
        const flat = hay.replace(/\s+/g, '');
        const cjk = cjkNames.find((x) => flat.includes(x));
        if (cjk) return cjk;
        // A title in marks that is a name of b or holds one (《中华人民共和国标准施工招标文件》); a
        // mark that is only part of a name (《商品包装》 in 商品包装政府采购需求标准) is not enough.
        for (const t of marksOf[i]!) {
          if (t.length < 4) continue;
          const hit = cjkNames.find((x) => x === t || t.includes(x));
          if (hit) return t;
        }
        if (!clauses) return null;
        const s = a.sections[i]!;
        return n.weak.find((x) => clauseMention(`${s.title}\n${s.text}`.normalize('NFKC'), x) >= 0) ?? null;
      };
      const passages: Passage[] = [];
      let count = 0;
      a.sections.forEach((s, i) => {
        const name = mentioned(i);
        if (!name) return;
        count++;
        if (passages.length < PASSAGES_PER_EDGE) {
          const { snippet } = snippetOf(s.text || s.title, [name]);
          passages.push({ documentId: a.id, sectionIndex: s.index, sectionTitle: s.title, snippet });
        }
      });
      if (count) out.add({ source: a.id, target: b.id, kind: 'reference', weight: count, passages });
    }
  }
}

// --- versions ----------------------------------------------------------------------------------

function versions(docs: BrowseDocument[], families: FamilyResult, out: EdgeSet): void {
  const byId = new Map(docs.map((d) => [d.id, d]));
  for (const f of families.families) {
    for (let i = 0; i + 1 < f.members.length; i++) {
      const a = byId.get(f.members[i]!)!;
      const b = byId.get(f.members[i + 1]!)!;
      out.add({ source: a.id, target: b.id, kind: 'version', weight: 1, sameIssue: !datedApart(a, b) });
    }
  }
}

// --- relatedness -------------------------------------------------------------------------------

function rareTerms(docs: BrowseDocument[]): Map<string, Set<string>> {
  const termsOf = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const d of docs) {
    let text = '';
    for (const s of d.sections) {
      if (text.length > TEXT_LIMIT) break;
      text += `${s.title}\n${s.text}\n`;
    }
    const set = new Set(
      contentTokens(text.slice(0, TEXT_LIMIT)).filter((t) =>
        CJK.test(t) ? t.length === 2 : t.length >= 4 && !/^\d/.test(t),
      ),
    );
    termsOf.set(d.id, set);
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const maxDf = Math.max(2, Math.ceil(0.1 * docs.length));
  for (const [id, set] of termsOf)
    termsOf.set(id, new Set([...set].filter((t) => (df.get(t) ?? 0) >= 2 && df.get(t)! <= maxDf)));
  return termsOf;
}

function related(docs: BrowseDocument[], out: EdgeSet): void {
  const rare = rareTerms(docs);
  const docsOf = new Map<string, string[]>();
  for (const [id, set] of rare) for (const t of set) docsOf.set(t, [...(docsOf.get(t) ?? []), id]);
  const shared = new Map<string, string[]>();
  for (const [t, ids] of docsOf) {
    ids.sort();
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const p = `${ids[i]}|${ids[j]}`;
        shared.set(p, [...(shared.get(p) ?? []), t]);
      }
  }
  const candidates: { a: string; b: string; terms: string[]; score: number }[] = [];
  for (const [p, terms] of shared) {
    const [a, b] = p.split('|') as [string, string];
    const score = terms.length / Math.sqrt(rare.get(a)!.size * rare.get(b)!.size);
    if (terms.length >= RELATED_MIN_SHARED && score >= RELATED_MIN_SCORE) candidates.push({ a, b, terms, score });
  }
  candidates.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  // Mutual nearest neighbours: an edge stays when it is among the top few of both its documents,
  // so one long document that shares rare words with everything does not become a hub.
  const top = new Map<string, Set<string>>();
  for (const c of candidates) {
    for (const [x, y] of [
      [c.a, c.b],
      [c.b, c.a],
    ] as const) {
      const set = top.get(x) ?? new Set<string>();
      if (set.size < RELATED_PER_DOCUMENT) set.add(y);
      top.set(x, set);
    }
  }
  for (const c of candidates) {
    if (!top.get(c.a)?.has(c.b) || !top.get(c.b)?.has(c.a)) continue;
    out.add({
      source: c.a,
      target: c.b,
      kind: 'related',
      weight: c.terms.length,
      terms: c.terms.sort().slice(0, MAX_TERMS),
    });
  }
}

// --- team work: projects, tickets, dates -------------------------------------------------------

const TITLE_STOP = new Set(
  (
    'the and for with from into about notes note meeting meetings minutes report reports spec specs draft final update ' +
    'updates weekly daily monthly status summary review plan plans team sync call kickoff retro standup notes copy ' +
    'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec'
  ).split(' '),
);

function titleTerms(title: string, cueWords: Set<string>): string[] {
  const words = titleWords(title).split(' ');
  const out = new Set<string>();
  for (const w of words) {
    if (CJK.test(w)) {
      for (let i = 0; i + 1 < w.length; i++) out.add(w.slice(i, i + 2));
    } else if (w.length >= 3 && !/\d/.test(w) && !TITLE_STOP.has(w) && !cueWords.has(w)) out.add(w);
  }
  return [...out];
}

function projects(docs: BrowseDocument[], profile: Profile, out: EdgeSet): void {
  const cueWords = new Set(
    Object.values(profile.cues)
      .flat()
      .map((w) => w.toLowerCase()),
  );
  const termsOf = new Map(docs.map((d) => [d.id, titleTerms(d.title, cueWords)]));
  const df = new Map<string, number>();
  for (const ts of termsOf.values()) for (const t of ts) df.set(t, (df.get(t) ?? 0) + 1);
  const maxDf = Math.max(2, Math.floor(0.3 * docs.length));
  const ok = (t: string) => df.get(t)! >= 2 && df.get(t)! <= maxDf;
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const a = docs[i]!;
      const b = docs[j]!;
      const tb = new Set(termsOf.get(b.id));
      const shared = termsOf.get(a.id)!.filter((t) => ok(t) && tb.has(t));
      const latin = shared.filter((t) => !CJK.test(t)).length;
      // Chinese titles share character pairs; two make one name (支付迁移: 支付, 付迁, 迁移).
      const weight = latin + Math.floor((shared.length - latin) / 2);
      if (weight >= 1)
        out.add({ source: a.id, target: b.id, kind: 'project', weight, terms: shared.slice(0, MAX_TERMS) });
    }
  }
}

function tickets(docs: BrowseDocument[], out: EdgeSet): void {
  const docsOf = new Map<string, Set<string>>();
  for (const d of docs) {
    const text = d.sections
      .map((s) => `${s.title}\n${s.text}`)
      .join('\n')
      .slice(0, TEXT_LIMIT);
    for (const m of `${d.title}\n${text}`.matchAll(TICKET_ID))
      docsOf.set(m[0], (docsOf.get(m[0]) ?? new Set()).add(d.id));
  }
  const shared = new Map<string, string[]>();
  for (const [ticket, ids] of docsOf) {
    const list = [...ids].sort();
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const p = `${list[i]}|${list[j]}`;
        shared.set(p, [...(shared.get(p) ?? []), ticket]);
      }
  }
  for (const [p, ids] of shared) {
    const [a, b] = p.split('|') as [string, string];
    out.add({ source: a, target: b, kind: 'ticket', weight: ids.length, terms: ids.sort().slice(0, MAX_TERMS) });
  }
}

function dateAdjacency(docs: BrowseDocument[], typeOf: Map<string, string>, out: EdgeSet): void {
  const byType = new Map<string, { id: string; day: number }[]>();
  for (const d of docs) {
    const v = documentDate(d)?.value;
    if (!v || v.length !== 10) continue;
    const t = typeOf.get(d.id) ?? '';
    byType.set(t, [...(byType.get(t) ?? []), { id: d.id, day: Date.parse(`${v}T00:00:00Z`) / 86_400_000 }]);
  }
  for (const list of byType.values()) {
    list.sort((a, b) => a.day - b.day || a.id.localeCompare(b.id));
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i]!;
      const b = list[i + 1]!;
      if (b.day - a.day <= DATE_ADJACENT_DAYS) out.add({ source: a.id, target: b.id, kind: 'date', weight: 1 });
    }
  }
}

/** Every edge the profile turns on; typeOf is the type per document id (for date adjacency). */
export function buildEdges(
  docs: BrowseDocument[],
  o: { profile: Profile; families: FamilyResult; typeOf: Map<string, string> },
): GraphEdge[] {
  const on = (r: EdgeRule) => o.profile.edges[r];
  const out = new EdgeSet();
  if (on('headings')) sharedHeadings(docs, out);
  if (on('references')) references(docs, o.families, on('clauseReferences'), out);
  if (on('versions')) versions(docs, o.families, out);
  if (on('related')) related(docs, out);
  if (on('projects')) projects(docs, o.profile, out);
  if (on('tickets')) tickets(docs, out);
  if (on('dates')) dateAdjacency(docs, o.typeOf, out);
  return out.list();
}
