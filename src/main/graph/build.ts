/**
 * The library graph of one library (docs/graph.md): documents as nodes, typed by the library's
 * profile, linked by the profile's edge rules, with families and the questions about them, and
 * seeded initial positions. Built from the browse index alone, no model, in well under a second
 * for a few hundred documents.
 */
import type { BrowseDocument } from '../browse/types.js';
import { detectKind, type DocumentKind, type KindScores } from './kinds.js';
import { documentDate, type FoundDate } from './dates.js';
import { libraryDisplayNames } from '../browse/identifiers.js';
import { buildEdges, MIN_SHARED_HEADINGS, type GraphEdge } from './edges.js';
import { isLargeLibrary, LARGE_MIN_SHARED_HEADINGS, MAX_EDGES_PER_DOCUMENT } from './scale.js';
import { detectFamilies, type FamilyQuestion } from './families.js';
import { initialPositions, type Positions } from './layout.js';
import { detectedType, EDGE_RULES, type EdgeRule, type Profile, type ProfileType } from './profiles.js';

export interface GraphNode {
  id: string;
  title: string;
  relPath: string;
  /** The name the labels show: the file's display name (browse/identifiers.ts libraryDisplayNames). */
  displayName: string;
  /** The type shown: the user's choice when overridden, else detected. */
  type: string;
  detectedType: string;
  overridden: boolean;
  kind: DocumentKind;
  kindScores: KindScores;
  sectionCount: number;
  familyId: string | null;
  /** From the title or front matter; null when neither has one. */
  date: FoundDate | null;
  positions: Positions;
}

export interface GraphData {
  version: 1;
  profile: { id: string; name: string; types: ProfileType[]; bands: string[]; edges: EdgeRule[] };
  /** More than LARGE_LIBRARY documents: the stricter edge rules ran and the page opens on Local. */
  large: boolean;
  /** The edge rules this build used (scale.ts). maxEdgesPerDocument is null when there is no cap. */
  rules: { minSharedHeadings: number; maxEdgesPerDocument: number | null };
  nodes: GraphNode[];
  edges: GraphEdge[];
  families: { id: string; members: string[] }[];
  /** Pairs of close titles the user may confirm as one document or not (Library page). */
  questions: FamilyQuestion[];
  builtAt: string;
  buildMs: number;
}

export interface GraphOptions {
  profile: Profile;
  /** The user's types for this profile, by document id; never replaced by detection. */
  overrides?: Record<string, string>;
  /** The user's family answers, by pairKey (families.ts). */
  familyDecisions?: Record<string, boolean>;
  now?: () => Date;
}

export function buildGraph(docs: BrowseDocument[], o: GraphOptions): GraphData {
  const t0 = performance.now();
  const { profile } = o;
  const typeNames = new Set(profile.types.map((t) => t.name));
  const sorted = [...docs].sort((a, b) => a.relPath.localeCompare(b.relPath) || a.id.localeCompare(b.id));
  const large = isLargeLibrary(sorted.length);
  const names = libraryDisplayNames(sorted.map((d) => d.title));
  const families = detectFamilies(sorted, o.familyDecisions ?? {});
  const typeOf = new Map<string, string>();
  const base = sorted.map((d) => {
    const k = d.kind ?? detectKind(d);
    const detected = detectedType(profile, d.title, k.kind, k.words);
    const chosen = o.overrides?.[d.id];
    const overridden = !!chosen && typeNames.has(chosen);
    const type = overridden ? chosen! : detected;
    typeOf.set(d.id, type);
    return { d, k, detected, type, overridden };
  });
  const positions = initialPositions(
    base.map((b) => ({ id: b.d.id, type: b.type })),
    profile.bands,
  );
  const nodes: GraphNode[] = base.map(({ d, k, detected, type, overridden }) => ({
    id: d.id,
    title: d.title,
    relPath: d.relPath,
    displayName: names.get(d.title) ?? d.title,
    type,
    detectedType: detected,
    overridden,
    kind: k.kind,
    kindScores: k.scores,
    sectionCount: d.sections.length,
    familyId: families.familyOf.get(d.id) ?? null,
    date: documentDate(d),
    positions: positions.get(d.id)!,
  }));
  const edges = buildEdges(sorted, { profile, families, typeOf, large });
  return {
    version: 1,
    profile: {
      id: profile.id,
      name: profile.name,
      types: profile.types,
      bands: profile.bands,
      edges: EDGE_RULES.filter((r) => profile.edges[r]),
    },
    large,
    rules: {
      minSharedHeadings: large ? LARGE_MIN_SHARED_HEADINGS : MIN_SHARED_HEADINGS,
      maxEdgesPerDocument: large ? MAX_EDGES_PER_DOCUMENT : null,
    },
    nodes,
    edges,
    families: families.families.map((f) => ({ id: f.id, members: f.members })),
    questions: families.questions,
    builtAt: (o.now ?? (() => new Date()))().toISOString(),
    buildMs: Math.round(performance.now() - t0),
  };
}
