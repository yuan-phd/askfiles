/**
 * Initial node positions for the graph (docs/graph.md, Layout): computed from the node ids and
 * types only, so a graph opens in the same place every time and the force layout on the page
 * (d3-force, deterministic from given positions) settles the same way. Coordinates are in -1 to 1
 * on both axes; the page scales them to its width and height.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Positions {
  organic: Point;
  layered: Point;
}

/** FNV-1a of a string, as an unsigned 32-bit seed. */
export function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small seeded generator, values in [0, 1). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const round = (v: number) => Math.round(v * 10000) / 10000;

/**
 * organic: a sunflower spiral, nodes grouped by type band so a type starts out together, each
 * nudged by its own seed. layered: one row per band in band order, nodes spread across the row in
 * id order, with a small seeded vertical offset so labels do not sit on one line.
 */
export function initialPositions(nodes: { id: string; type: string }[], bands: string[]): Map<string, Positions> {
  const bandOf = (t: string) => {
    const i = bands.indexOf(t);
    return i < 0 ? bands.length : i;
  };
  const bandCount = Math.max(1, new Set(nodes.map((n) => bandOf(n.type))).size);
  const usedBands = [...new Set(nodes.map((n) => bandOf(n.type)))].sort((a, b) => a - b);
  const ordered = [...nodes].sort((a, b) => bandOf(a.type) - bandOf(b.type) || a.id.localeCompare(b.id));
  const out = new Map<string, Positions>();
  const n = ordered.length;
  const rows = new Map<number, string[]>();
  for (const node of ordered) rows.set(bandOf(node.type), [...(rows.get(bandOf(node.type)) ?? []), node.id]);
  ordered.forEach((node, i) => {
    const rand = seeded(seedOf(node.id));
    const r = Math.sqrt((i + 0.5) / Math.max(1, n));
    const theta = i * GOLDEN + rand() * 0.3;
    const row = usedBands.indexOf(bandOf(node.type));
    const members = rows.get(bandOf(node.type))!;
    const k = members.indexOf(node.id);
    out.set(node.id, {
      organic: { x: round(r * Math.cos(theta)), y: round(r * Math.sin(theta)) },
      layered: {
        x: round(members.length === 1 ? 0 : -0.9 + (1.8 * k) / (members.length - 1)),
        y: round(-1 + (2 * (row + 0.5)) / bandCount + (rand() - 0.5) * (0.5 / bandCount)),
      },
    });
  });
  return out;
}
