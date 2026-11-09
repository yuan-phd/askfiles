import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { documentId } from '../browse/build.js';
import { normalizeHeading } from '../browse/normalize.js';
import { inventLibrary } from '../../../test/fixtures/make-graph-library.mjs';
import { buildGraph } from './build.js';
import type { GraphEdge } from './edges.js';
import { loadProfiles, profileFor } from './profiles.js';
import { capEdges, isLargeLibrary, LARGE_LIBRARY, MAX_EDGES_PER_DOCUMENT } from './scale.js';
import { doc } from './__fixtures__/docs.js';

const legal = profileFor(loadProfiles(path.resolve(import.meta.dirname, '../../../config/profiles')), 'legal-finance');

/**
 * n invented documents: a hub sharing two headings (Alpha, Beta) with every other one, and the
 * first `three` of the others sharing a third (Gamma) with it as well. Each has a heading of its
 * own, so no other pair reaches two shared headings.
 */
function hubLibrary(n: number, three: number) {
  const hub = doc('Hub Notes.md', [
    ['Alpha', 'a'],
    ['Beta', 'b'],
    ['Gamma', 'c'],
  ]);
  const others = Array.from({ length: n - 1 }, (_, i) =>
    doc(`Leaf ${String(i).padStart(3, '0')}.md`, [
      ['Alpha', 'a'],
      ...(i % 2 ? [['Beta', 'b'] as [string, string]] : []),
      ...(i < three ? [['Gamma', 'c'] as [string, string]] : []),
      [`Own Heading ${i}`, 'x'],
    ]),
  );
  return { hub, docs: [hub, ...others] };
}

const edge = (source: string, target: string, weight: number): GraphEdge => {
  const [a, b] = source < target ? [source, target] : [target, source];
  return { id: `headings:${a}:${b}`, source: a, target: b, kind: 'headings', weight };
};

describe('large library threshold', () => {
  it('is more than 50 documents', () => {
    expect(LARGE_LIBRARY).toBe(50);
    expect(isLargeLibrary(50)).toBe(false);
    expect(isLargeLibrary(51)).toBe(true);
  });

  it('a library of 50 keeps the small rules: two shared headings, no cap', () => {
    // Every odd leaf shares Alpha and Beta with the hub; the first 10 share Gamma too.
    const { hub, docs } = hubLibrary(50, 10);
    const g = buildGraph(docs, { profile: legal });
    expect(g.large).toBe(false);
    expect(g.rules).toEqual({ minSharedHeadings: 2, maxEdgesPerDocument: null });
    const hubEdges = g.edges.filter((e) => e.source === hub.id || e.target === hub.id);
    // 24 odd leaves with Alpha and Beta, and the 5 even leaves among the first 10 with Alpha and Gamma.
    expect(hubEdges).toHaveLength(24 + 5);
  });

  it('a library of 51 needs three shared headings and keeps at most five edges per document', () => {
    const { hub, docs } = hubLibrary(51, 10);
    const g = buildGraph(docs, { profile: legal });
    expect(g.large).toBe(true);
    expect(g.rules).toEqual({ minSharedHeadings: 3, maxEdgesPerDocument: 5 });
    const hubEdges = g.edges.filter((e) => e.source === hub.id || e.target === hub.id);
    // Only the odd leaves among the first 10 share three headings (Alpha, Beta, Gamma): 1, 3, 5, 7, 9.
    expect(hubEdges.map((e) => e.weight)).toEqual([3, 3, 3, 3, 3]);
    const names = new Map(g.nodes.map((n) => [n.id, n.title]));
    expect(hubEdges.map((e) => names.get(e.source === hub.id ? e.target : e.source)).sort()).toEqual([
      'Leaf 001.md',
      'Leaf 003.md',
      'Leaf 005.md',
      'Leaf 007.md',
      'Leaf 009.md',
    ]);
  });

  it('the 900-document invented library: every document has at most five edges', () => {
    const docs = inventLibrary({ normalizeHeading, documentId });
    expect(docs).toHaveLength(900);
    const g = buildGraph(docs, { profile: legal });
    expect(g.large).toBe(true);
    const degree = new Map<string, number>();
    for (const e of g.edges) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
    expect(Math.max(...degree.values())).toBeLessThanOrEqual(MAX_EDGES_PER_DOCUMENT);
    expect(g.edges.filter((e) => e.kind === 'headings').every((e) => e.weight >= 3)).toBe(true);
    // Labels use the display name: no extension, no leading number, underscores as spaces.
    expect(
      g.nodes.every((n) => n.displayName && !/\.\w{2,4}$/.test(n.displayName) && !n.displayName.includes('_')),
    ).toBe(true);
  });
});

describe('capEdges', () => {
  it('keeps the strongest edges of each document, at most max', () => {
    const edges = [edge('a', 'b', 5), edge('a', 'c', 4), edge('a', 'd', 3), edge('a', 'e', 2), edge('d', 'e', 1)];
    const kept = capEdges(edges, 2);
    expect(kept.map((e) => e.id)).toEqual(['headings:a:b', 'headings:a:c', 'headings:d:e']);
  });

  it('breaks ties by edge id, whatever the input order', () => {
    const edges = [edge('a', 'd', 2), edge('a', 'b', 2), edge('a', 'c', 2), edge('a', 'e', 2)];
    const one = capEdges(edges, 2).map((e) => e.id);
    const two = capEdges([...edges].reverse(), 2).map((e) => e.id);
    expect(one).toEqual(['headings:a:b', 'headings:a:c']);
    expect(two).toEqual(one);
  });

  it('an edge is dropped when either end is full, and a document below the cap keeps its others', () => {
    // b is full with its three heavier edges; c still gets its edge to d.
    const edges = [edge('b', 'x', 9), edge('b', 'y', 8), edge('b', 'z', 7), edge('b', 'c', 6), edge('c', 'd', 1)];
    const kept = capEdges(edges, 3).map((e) => e.id);
    expect(kept).not.toContain('headings:b:c');
    expect(kept).toContain('headings:c:d');
  });
});
