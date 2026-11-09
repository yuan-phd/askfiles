import { describe, expect, it } from 'vitest';
import {
  adjacency,
  defaultView,
  folderGroups,
  folderOf,
  folderScene,
  isLarge,
  LOCAL_LIMIT,
  localScene,
  searchMatches,
  topLinked,
  truncateLabel,
  withNeighbours,
} from './graph-model.js';

// Invented documents only (CLAUDE.md rule 10).
const node = (id, relPath, o = {}) => ({
  id,
  relPath,
  title: relPath.split('/').pop(),
  displayName:
    o.name ??
    relPath
      .split('/')
      .pop()
      .replace(/\.\w+$/, ''),
  type: o.type ?? 'guidance',
});
const edge = (a, b, weight = 1, kind = 'headings') => {
  const [s, t] = a < b ? [a, b] : [b, a];
  return { id: `${kind}:${s}:${t}`, source: s, target: t, kind, weight };
};
const ids = (list) => list.map((n) => n.id);

describe('threshold and default view', () => {
  it('uses the build flag, and the size for graph files from before it', () => {
    const many = Array.from({ length: 51 }, (_, i) => node(`d${i}`, `F/d${i}.md`));
    expect(isLarge({ large: true, nodes: [] })).toBe(true);
    expect(isLarge({ large: false, nodes: many })).toBe(false);
    expect(isLarge({ nodes: many })).toBe(true);
    expect(isLarge({ nodes: many.slice(0, 50) })).toBe(false);
    expect(defaultView({ large: true, nodes: many })).toBe('folders');
    expect(defaultView({ large: false, nodes: many.slice(0, 50) })).toBe('all');
  });
});

describe('labels', () => {
  it('cuts a long name with an ellipsis and keeps a short one', () => {
    expect(truncateLabel('Pump Station Procedure')).toBe('Pump Station Procedure');
    const long = 'Guidance on the Inspection and Cleaning of Service Reservoirs and Treated Water Storage Tanks';
    const cut = truncateLabel(long);
    expect(cut.endsWith('…')).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(cut.length).toBeLessThan(long.length);
    // CJK characters are wider: fewer fit.
    const cjk = truncateLabel('水务合作社泵站维护与检修操作规程及安全管理制度汇编');
    expect(cjk.endsWith('…')).toBe(true);
    expect([...cjk].length).toBeLessThanOrEqual(14);
  });

  it('the ten documents with the most links, ties by name then id, never one without links', () => {
    const nodes = Array.from({ length: 14 }, (_, i) =>
      node(`n${String(i).padStart(2, '0')}`, `F/Doc ${String.fromCharCode(65 + i)}.md`),
    );
    const edges = [];
    // n00 has 6 links, n01 5, ... n05 1; n06 to n13 one link each to n13 (n13: 7).
    for (let i = 0; i < 6; i++) for (let k = 0; k < 6 - i; k++) edges.push(edge(`n0${i}`, `x${i}-${k}`));
    for (let i = 6; i < 13; i++) edges.push(edge(`n${String(i).padStart(2, '0')}`, 'n13'));
    const top = topLinked(nodes, edges, 10);
    expect(top.size).toBe(10);
    expect(top.has('n13')).toBe(true);
    expect(top.has('n00')).toBe(true);
    // n05 (1 link) ties with n06 to n12 (1 link each); names Doc F, Doc G ... decide: F, G, H, I wins over later.
    const ones = ['n05', 'n06', 'n07', 'n08', 'n09', 'n10', 'n11', 'n12'].filter((id) => top.has(id));
    expect(ones).toEqual(['n05', 'n06', 'n07', 'n08']);
    expect(topLinked([...nodes].reverse(), [...edges].reverse(), 10)).toEqual(top);
    expect(topLinked([node('lonely', 'F/Lonely.md')], [], 10).size).toBe(0);
  });
});

describe('folders', () => {
  it('groups by the first folder inside a linked folder; top files by their linked folder; added files apart', () => {
    expect(folderOf('Records/Finance/2024/Budget.pdf')).toMatchObject({
      key: 'sub:Records/Finance',
      label: 'Finance',
      sub: true,
    });
    expect(folderOf('Records/Charter.pdf')).toMatchObject({ key: 'top:Records', label: 'Records', sub: false });
    expect(folderOf('Loose Note.md')).toMatchObject({ key: 'added:', label: 'Added files', sub: false });
    expect(folderOf('Records\\Finance\\Budget.pdf').key).toBe('sub:Records/Finance');
  });

  it('lists one group per subfolder with its documents; same names under two linked folders stay apart', () => {
    const nodes = [
      node('a', 'Records/Finance/2024/Budget.pdf'),
      node('b', 'Records/Finance/Audit.pdf'),
      node('c', 'Records/Operations/Pumps.pdf'),
      node('d', 'Projects/Finance/Costs.xlsx'),
      node('e', 'Records/Charter.pdf'),
      node('f', 'Loose Note.md'),
    ];
    const g = folderGroups(nodes);
    expect(g.by).toBe('folder');
    expect(g.groups.map((x) => [x.label, x.members])).toEqual([
      ['Added files', ['f']],
      ['Operations', ['c']],
      ['Projects › Finance', ['d']],
      ['Records', ['e']],
      ['Records › Finance', ['b', 'a']],
    ]);
  });

  it('groups by type when no document lies in a subfolder', () => {
    const nodes = [
      node('a', 'Records/One.pdf', { type: 'regulation' }),
      node('b', 'Records/Two.pdf', { type: 'guidance' }),
      node('c', 'Three.pdf', { type: 'regulation' }),
    ];
    const g = folderGroups(
      nodes,
      new Map([
        ['regulation', 'Regulation'],
        ['guidance', 'Guidance'],
      ]),
    );
    expect(g.by).toBe('type');
    expect(g.groups.map((x) => [x.label, x.members.sort()])).toEqual([
      ['Guidance', ['b']],
      ['Regulation', ['a', 'c']],
    ]);
  });

  const lib = {
    nodes: [
      node('a1', 'R/Alpha/one.md'),
      node('a2', 'R/Alpha/two.md'),
      node('b1', 'R/Beta/one.md'),
      node('b2', 'R/Beta/two.md'),
      node('c1', 'R/Gamma/one.md'),
    ],
    edges: [
      edge('a1', 'b1', 3),
      edge('a1', 'b2', 4),
      edge('a2', 'b1', 3),
      edge('a1', 'a2', 5),
      edge('b2', 'c1', 3),
      edge('a1', 'b1', 1, 'reference'),
    ],
  };

  it('collapsed: one node per folder, links counting the document links between them, none inside one', () => {
    const s = folderScene(lib, new Set());
    expect(s.nodes.map((n) => [n.role, n.label, n.count])).toEqual([
      ['group', 'Alpha', 2],
      ['group', 'Beta', 2],
      ['group', 'Gamma', 1],
    ]);
    expect(s.links.map((l) => [l.source, l.target, l.count, l.kind])).toEqual([
      ['group:sub:R/Alpha', 'group:sub:R/Beta', 4, 'aggregate'],
      ['group:sub:R/Beta', 'group:sub:R/Gamma', 1, 'aggregate'],
    ]);
  });

  it('one folder expanded: its documents link to the folders still collapsed; two expanded: document to document', () => {
    const one = folderScene(lib, new Set(['sub:R/Alpha']));
    expect(one.nodes.map((n) => n.id)).toEqual(['a1', 'a2', 'group:sub:R/Beta', 'group:sub:R/Gamma']);
    const pairs = one.links.map((l) => [l.source, l.target, l.count, l.kind]);
    expect(pairs).toContainEqual(['a1', 'a2', 1, 'headings']);
    expect(pairs).toContainEqual(['a1', 'group:sub:R/Beta', 3, 'aggregate']);
    expect(pairs).toContainEqual(['a2', 'group:sub:R/Beta', 1, 'aggregate']);
    expect(pairs).toContainEqual(['group:sub:R/Beta', 'group:sub:R/Gamma', 1, 'aggregate']);
    expect(pairs).toHaveLength(4);

    const two = folderScene(lib, new Set(['sub:R/Alpha', 'sub:R/Beta']));
    const p2 = two.links.map((l) => [l.source, l.target, l.kind]);
    expect(p2).toContainEqual(['a1', 'b1', 'headings']);
    expect(p2).toContainEqual(['a1', 'b1', 'reference']);
    expect(p2).toContainEqual(['a1', 'b2', 'headings']);
    expect(p2).toContainEqual(['a2', 'b1', 'headings']);
    expect(p2).toContainEqual(['b2', 'group:sub:R/Gamma', 'aggregate']);
    // A document-to-document link keeps its edge for the click.
    expect(two.links.find((l) => l.kind === 'reference').edge.id).toBe('reference:a1:b1');
  });
});

describe('local view', () => {
  const star = (n) => {
    const nodes = [
      node('hub', 'R/F/hub.md'),
      ...Array.from({ length: n }, (_, i) => node(`s${String(i).padStart(2, '0')}`, `R/F/s${i}.md`)),
    ];
    // s00 is the strongest neighbour, then s01, ...
    const edges = nodes.slice(1).map((x, i) => edge('hub', x.id, 100 - i));
    return { nodes, edges };
  };

  it('the centre and its direct neighbours, strongest first', () => {
    const data = star(3);
    data.edges.push(edge('s00', 'far', 9));
    data.nodes.push(node('far', 'R/F/far.md'));
    const s = localScene(data, 'hub');
    expect(ids(s.nodes)).toEqual(['hub', 's00', 's01', 's02']);
    expect(s.more).toEqual([]);
    expect(s.edges.every((e) => e.source !== 'far' && e.target !== 'far')).toBe(true);
  });

  it('past 30 neighbours: the 30 strongest drawn, the rest listed in order', () => {
    const s = localScene(star(42), 'hub');
    expect(LOCAL_LIMIT).toBe(30);
    expect(s.nodes).toHaveLength(31);
    expect(ids(s.more)).toEqual(Array.from({ length: 12 }, (_, i) => `s${30 + i}`));
  });

  it('the second step adds what the neighbours link to, and recentring moves the centre', () => {
    const data = {
      nodes: ['a', 'b', 'c', 'd', 'e'].map((x) => node(x, `R/F/${x}.md`)),
      edges: [edge('a', 'b', 3), edge('b', 'c', 2), edge('c', 'd', 2), edge('d', 'e', 1)],
    };
    expect(ids(localScene(data, 'a').nodes)).toEqual(['a', 'b']);
    const two = localScene(data, 'a', { secondHop: true });
    expect(two.nodes.map((n) => [n.id, n.hop])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
    expect(ids(localScene(data, 'c').nodes)).toEqual(['c', 'b', 'd']);
    expect(localScene(data, 'missing').nodes).toEqual([]);
  });
});

describe('search', () => {
  it('matches the display name, file name or path; neighbours come with the matches', () => {
    const nodes = [
      node('a', 'R/Ops/03_Pump_Check.pdf', { name: 'Pump Check' }),
      node('b', 'R/Ops/Valve.pdf'),
      node('c', 'R/Fin/Budget.pdf'),
    ];
    expect(ids(searchMatches(nodes, 'pump check'))).toEqual(['a']);
    expect(ids(searchMatches(nodes, '03_pump'))).toEqual(['a']);
    expect(ids(searchMatches(nodes, 'r/ops'))).toEqual(['a', 'b']);
    expect(searchMatches(nodes, '  ')).toEqual([]);
    expect([...withNeighbours(new Set(['a']), [edge('a', 'c')])].sort()).toEqual(['a', 'c']);
  });

  it('adjacency merges two kinds between one pair', () => {
    const adj = adjacency([edge('a', 'b', 2), edge('a', 'b', 1, 'reference'), edge('a', 'c', 2)]);
    expect(adj.get('a')).toMatchObject([
      { id: 'b', weight: 3 },
      { id: 'c', weight: 2 },
    ]);
  });
});
