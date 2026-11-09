/**
 * Large libraries (docs/graph.md, Large libraries). Past LARGE_LIBRARY documents a graph with every
 * edge the small-library rules find turns into a hairball, so the rules get stricter: more shared
 * headings for a headings edge, and a cap on the edges each document keeps. Libraries of
 * LARGE_LIBRARY or fewer keep the rules they had.
 */
import type { GraphEdge } from './edges.js';

/** More documents than this make a large library. */
export const LARGE_LIBRARY = 50;
/** Shared headings a headings edge needs in a large library (MIN_SHARED_HEADINGS in a small one). */
export const LARGE_MIN_SHARED_HEADINGS = 3;
/** The most edges one document keeps in a large library. */
export const MAX_EDGES_PER_DOCUMENT = 5;

export function isLargeLibrary(documentCount: number): boolean {
  return documentCount > LARGE_LIBRARY;
}

/**
 * Keeps at most max edges per document, the strongest first. Edges are taken in order of weight,
 * heaviest first, ties by edge id (kind:a:b, so the result never depends on input order); an edge
 * is kept when both its documents still have room. Each document thus keeps at most max, and no
 * edge is dropped while both its ends could still take it. Returned in edge id order, as buildEdges
 * returns them.
 */
export function capEdges(edges: GraphEdge[], max = MAX_EDGES_PER_DOCUMENT): GraphEdge[] {
  const ranked = [...edges].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const count = new Map<string, number>();
  const kept: GraphEdge[] = [];
  for (const e of ranked) {
    const s = count.get(e.source) ?? 0;
    const t = count.get(e.target) ?? 0;
    if (s >= max || t >= max) continue;
    count.set(e.source, s + 1);
    count.set(e.target, t + 1);
    kept.push(e);
  }
  return kept.sort((a, b) => a.id.localeCompare(b.id));
}
