/**
 * Profiles (docs/profiles.md): how a library names and colours its document types, which edges the
 * Graph page draws and in which order the layered layout stacks the types. One JSON file per profile
 * in config/profiles; a library picks one when it is created (legal-finance by default) and can
 * change it in the library menu, which recomputes types and edges but never the index.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DOCUMENT_KINDS, type DocumentKind } from './kinds.js';

export const EDGE_RULES = [
  'headings',
  'references',
  'clauseReferences',
  'versions',
  'related',
  'projects',
  'tickets',
  'dates',
] as const;
export type EdgeRule = (typeof EDGE_RULES)[number];

export interface ProfileType {
  /** Stored in the library records and the export; lower case, no spaces. */
  name: string;
  /** As the pages show it. */
  label: string;
  /** A mid-tone colour, readable on the light and the dark background. */
  color: string;
}

export interface Profile {
  id: string;
  name: string;
  description: string;
  types: ProfileType[];
  /** The type of each structural kind (kinds.ts); every kind has one. */
  kinds: Record<DocumentKind, string>;
  /**
   * Words in a file name or title that name a type and win over the kind: Template, 合同, Minutes.
   * Matched as whole words in Latin script (a plural s allowed), anywhere in Chinese. When several
   * match, the one ending last wins, then the longer: the head noun of a title comes last in both
   * languages (Contract Management Guidance is guidance, 违法行为记录公告暂行办法 a regulation).
   */
  cues: Record<string, string[]>;
  /** The layered layout's bands, top to bottom; types not listed go last. */
  bands: string[];
  edges: Record<EdgeRule, boolean>;
  /** A long document of this kind gets another type: an explanatory text of 20000 words is a book. */
  long: { kind: DocumentKind; type: string; minWords: number } | null;
}

export interface ProfileInfo {
  id: string;
  name: string;
  description: string;
}

export const DEFAULT_PROFILE_ID = 'legal-finance';

const ID = /^[a-z0-9-]{1,40}$/;
const NAME = /^[a-z0-9-]{1,30}$/;
const COLOR = /^#[0-9a-f]{6}$/i;

/** Checks one parsed profile file; the message names the first problem. */
export function checkProfile(raw: unknown, source = 'profile'): Profile {
  const fail = (why: string): never => {
    throw new Error(`${source}: ${why}`);
  };
  const p = (raw && typeof raw === 'object' ? raw : fail('not an object')) as Record<string, unknown>;
  const id = typeof p.id === 'string' && ID.test(p.id) ? p.id : fail('id must be lower case letters, digits and -');
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : fail('name is missing');
  const description = typeof p.description === 'string' ? p.description : '';
  if (!Array.isArray(p.types) || !p.types.length) fail('types must be a non-empty list');
  const types = (p.types as unknown[]).map((t, i) => {
    const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    if (typeof o.name !== 'string' || !NAME.test(o.name))
      fail(`types[${i}].name must be lower case letters, digits and -`);
    if (typeof o.color !== 'string' || !COLOR.test(o.color)) fail(`types[${i}].color must be #rrggbb`);
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : (o.name as string);
    return { name: o.name as string, label, color: (o.color as string).toLowerCase() };
  });
  const names = new Set(types.map((t) => t.name));
  if (names.size !== types.length) fail('type names must be unique');
  const kindsRaw = (p.kinds && typeof p.kinds === 'object' ? p.kinds : fail('kinds is missing')) as Record<
    string,
    unknown
  >;
  const kinds = {} as Record<DocumentKind, string>;
  for (const k of DOCUMENT_KINDS) {
    const t = kindsRaw[k];
    if (typeof t !== 'string' || !names.has(t)) fail(`kinds.${k} must name one of the types`);
    kinds[k] = t as string;
  }
  const cuesRaw = (p.cues && typeof p.cues === 'object' ? p.cues : {}) as Record<string, unknown>;
  const cues: Record<string, string[]> = {};
  for (const [t, words] of Object.entries(cuesRaw)) {
    if (!names.has(t)) fail(`cues.${t} is not one of the types`);
    if (!Array.isArray(words) || words.some((w) => typeof w !== 'string' || !w.trim()))
      fail(`cues.${t} must be a list of words`);
    cues[t] = (words as string[]).map((w) => w.trim());
  }
  const bands = Array.isArray(p.bands) ? (p.bands as unknown[]) : fail('bands must be a list');
  for (const b of bands)
    if (typeof b !== 'string' || !names.has(b)) fail(`bands: ${String(b)} is not one of the types`);
  let long: Profile['long'] = null;
  if (p.long !== undefined && p.long !== null) {
    const l = (p.long && typeof p.long === 'object' ? p.long : fail('long must be an object')) as Record<
      string,
      unknown
    >;
    if (!(DOCUMENT_KINDS as readonly unknown[]).includes(l.kind)) fail('long.kind must be a kind');
    if (typeof l.type !== 'string' || !names.has(l.type)) fail('long.type must name one of the types');
    if (typeof l.minWords !== 'number' || l.minWords <= 0) fail('long.minWords must be a positive number');
    long = { kind: l.kind as DocumentKind, type: l.type as string, minWords: l.minWords as number };
  }
  const edgesRaw = (p.edges && typeof p.edges === 'object' ? p.edges : fail('edges is missing')) as Record<
    string,
    unknown
  >;
  const edges = {} as Record<EdgeRule, boolean>;
  for (const r of EDGE_RULES) edges[r] = edgesRaw[r] === true;
  for (const k of Object.keys(edgesRaw))
    if (!(EDGE_RULES as readonly string[]).includes(k)) fail(`edges.${k} is not an edge rule`);
  return { id, name, description, types, kinds, cues, bands: bands as string[], edges, long };
}

/** Every *.json in dir, sorted by file name; a broken file is an error, not skipped. */
export function loadProfiles(dir: string): Profile[] {
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort();
  const out = files.map((f) => checkProfile(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), f));
  const ids = new Set(out.map((p) => p.id));
  if (ids.size !== out.length) throw new Error(`${dir}: two profiles share an id`);
  return out;
}

/** The library's profile, or the default when the stored id is unknown (a profile was removed). */
export function profileFor(profiles: Profile[], id: string | null | undefined): Profile {
  return (
    profiles.find((p) => p.id === id) ??
    profiles.find((p) => p.id === DEFAULT_PROFILE_ID) ??
    profiles[0] ??
    (() => {
      throw new Error('no profiles');
    })()
  );
}

const CJK = /[㐀-䶿一-鿿豈-﫿]/;

/** File name without extension, separators as spaces, NFKC, lower case. */
export function titleWords(title: string): string {
  return title
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_\-.()[\]{}+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The cue in title that names a type (see Profile.cues); null when none matches. */
export function cueType(profile: Profile, title: string): string | null {
  const t = ` ${titleWords(title)} `;
  let best: { type: string; end: number; len: number } | null = null;
  for (const [type, words] of Object.entries(profile.cues)) {
    for (const w of words) {
      const cue = w.normalize('NFKC').toLowerCase();
      const re = CJK.test(cue)
        ? new RegExp(escape(cue), 'gu')
        : new RegExp(`(?<=[^\\p{L}\\p{N}])${escape(cue)}s?(?=[^\\p{L}\\p{N}])`, 'gu');
      for (const m of t.matchAll(re)) {
        const end = m.index + m[0].length;
        if (!best || end > best.end || (end === best.end && cue.length > best.len))
          best = { type, end, len: cue.length };
      }
    }
  }
  return best?.type ?? null;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SPREADSHEET = /\.(xlsx|xlsm|xls|csv)$/i;

/**
 * The detected type: a spreadsheet is always the data kind's type; otherwise a title cue first,
 * then the long rule, then the type of the structural kind.
 */
export function detectedType(profile: Profile, title: string, kind: DocumentKind, words = 0): string {
  if (SPREADSHEET.test(title)) return profile.kinds.data;
  const cue = cueType(profile, title);
  if (cue) return cue;
  if (profile.long && kind === profile.long.kind && words >= profile.long.minWords) return profile.long.type;
  return profile.kinds[kind];
}

export function profileInfo(p: Profile): ProfileInfo {
  return { id: p.id, name: p.name, description: p.description };
}
