/**
 * Families (docs/graph.md, Families): documents whose titles are the same once years, version
 * tokens, a leading file number and the format are taken off, such as the PDF and the Word copy of
 * one regulation or its 2024 and 2025 issues. Titles that are close but not equal after that are
 * listed as questions; the user's answers (same or not) are stored per pair in the library record
 * and override detection both ways.
 */
import { createHash } from 'node:crypto';
import { dateIn, orderingDate } from './dates.js';

export interface FamilyInput {
  id: string;
  title: string;
  mtimeMs: number;
  sections: { text: string }[];
}

export interface Family {
  id: string;
  /** The normalized title the members share (the first member's when joined by the user). */
  key: string;
  /** Oldest first: by date (title, front matter, else file time), then version number, then title. */
  members: string[];
}

export interface FamilyQuestion {
  a: string;
  b: string;
}

export interface FamilyResult {
  families: Family[];
  familyOf: Map<string, string>;
  /** Close titles the user has not decided on. */
  questions: FamilyQuestion[];
}

const CJK = /[㐀-䶿一-鿿豈-﫿]/g;

/** Year, date and version tokens, and copy markers; removed before titles are compared. */
const STRIP = [
  /(?<!\d)(?:19|20)\d{2}[-_./]\d{1,2}[-_./]\d{1,2}(?!\d)/g,
  /(?<!\d)(?:19|20)\d{2}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?/g,
  /(?<!\d)(?:19|20)\d{2}(?:\s*年版|\s*年|\s*版)?(?!\d)/g,
  /\b(?:v|ver|version|rev|revision|release|edition|ed)\.?\s*\d+(?:\.\d+)*\b/g,
  /\b(?:draft|final|updated|revised|amended|copy|clean|signed)\b/g,
  /第[一二三四五六七八九十\d]+版|修订版|修正版|最终版|定稿|草案|征求意见稿|试行|副本/g,
  /\(\d{1,2}\)$/g,
];

/** The family key of a title; '' when too little is left to compare. */
export function familyKey(title: string): string {
  let t = title
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^\d{1,3}(?=[_\-. ])[_\-. ]+/, '')
    .replace(/[_\-.]+/g, ' ');
  for (const re of STRIP) t = t.replace(re, ' ');
  t = t.replace(/[^\p{L}\p{N}]+/gu, '');
  const cjk = t.match(CJK)?.length ?? 0;
  const latin = t.length - cjk;
  return cjk >= 3 || latin >= 4 ? t : '';
}

/** A version number in the title (v2, version 3.1, rev 4), for ordering; 0 when none. */
export function versionNumber(title: string): number {
  const m = /\b(?:v|ver|version|rev|revision|release|edition)\.?\s*(\d+(?:\.\d+)?)/i.exec(title.normalize('NFKC'));
  return m ? parseFloat(m[1]!) : 0;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Keys close enough to ask about: at least 6 characters each and either an edit distance of at
 * most 20 percent of the longer key, at least 2 (a typo, a plural, a changed word ending: leave
 * policy and leave policies are 3 apart in 13), or one key the start of the other with at most a
 * quarter of the longer one left over (Leave policy and Leave policy summary).
 */
export function closeKeys(a: string, b: string): boolean {
  if (a === b || a.length < 6 || b.length < 6) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l.startsWith(s) && (l.length - s.length) / l.length <= 0.25) return true;
  const max = Math.max(2, Math.ceil(0.2 * l.length));
  return levenshtein(s.slice(0, 80), l.slice(0, 80), max) <= max;
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

/**
 * Families of a library. decisions maps pairKey(a, b) to true (same document) or false (not);
 * a false splits a detected pair, a true joins a pair detection did not join or only asked about.
 */
export function detectFamilies(docs: FamilyInput[], decisions: Record<string, boolean> = {}): FamilyResult {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const keyOf = new Map(docs.map((d) => [d.id, familyKey(d.title)]));
  const groups = new Map<string, string[]>();
  for (const d of docs) {
    const k = keyOf.get(d.id)!;
    if (k) groups.set(k, [...(groups.get(k) ?? []), d.id]);
  }
  const uf = new UnionFind();
  for (const ids of groups.values()) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        if (decisions[pairKey(ids[i]!, ids[j]!)] !== false) uf.union(ids[i]!, ids[j]!);
  }
  for (const [pair, same] of Object.entries(decisions)) {
    const [a, b] = pair.split('|');
    if (same && a && b && byId.has(a) && byId.has(b)) uf.union(a, b);
  }
  const questions: FamilyQuestion[] = [];
  const keys = [...groups.keys()].sort();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (!closeKeys(keys[i]!, keys[j]!)) continue;
      // One question per pair of key groups: their first members stand for the rest.
      const a = groups.get(keys[i]!)![0]!;
      const b = groups.get(keys[j]!)![0]!;
      if (pairKey(a, b) in decisions || uf.find(a) === uf.find(b)) continue;
      questions.push(a < b ? { a, b } : { a: b, b: a });
    }
  }
  const members = new Map<string, string[]>();
  for (const d of docs) {
    const root = uf.find(d.id);
    members.set(root, [...(members.get(root) ?? []), d.id]);
  }
  const families: Family[] = [];
  const familyOf = new Map<string, string>();
  for (const ids of members.values()) {
    if (ids.length < 2) continue;
    const ordered = ids
      .map((id) => {
        const d = byId.get(id)!;
        return { id, date: orderingDate(d).value, version: versionNumber(d.title), title: d.title };
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.version - b.version || a.title.localeCompare(b.title))
      .map((x) => x.id);
    const key = keyOf.get(ordered[0]!) || familyKey(byId.get(ordered[0]!)!.title) || ordered[0]!;
    const id = `fam-${createHash('sha256')
      .update([...ids].sort().join('|'))
      .digest('hex')
      .slice(0, 10)}`;
    families.push({ id, key, members: ordered });
    for (const m of ordered) familyOf.set(m, id);
  }
  families.sort((a, b) => a.key.localeCompare(b.key));
  return { families, familyOf, questions };
}

/** True when two family members differ by their dated issue rather than only by format. */
export function datedApart(a: FamilyInput, b: FamilyInput): boolean {
  const stem = (t: string) => t.replace(/\.[a-z0-9]{1,5}$/i, '');
  const da = dateIn(stem(a.title)) ?? '';
  const db = dateIn(stem(b.title)) ?? '';
  return da !== db || versionNumber(a.title) !== versionNumber(b.title);
}
