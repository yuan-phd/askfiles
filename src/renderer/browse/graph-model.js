// What the Graph page draws for each view (docs/graph.md, Large libraries), as plain data: which
// nodes and links a view holds, which labels show, what a search lights. No DOM and no d3 here, so
// the rules are unit tested (graph-model.test.js) and the page (graph.js) only draws.

/** More documents than this make a large library; mirrors LARGE_LIBRARY in src/main/graph/scale.ts. */
export const LARGE_LIBRARY = 50;
/** Neighbours Local shows around its centre before the rest go into one "+N more" node. */
export const LOCAL_LIMIT = 30;
/** Documents of the All view whose labels show without hover, search or zoom. */
export const TOP_LABELS = 10;
/** From this zoom on (the d3 zoom scale), every label of the All and Folders views shows. */
export const LABEL_ZOOM = 1.6;
/** Label width before the ellipsis, in pixels at the label's 11 px font. */
export const LABEL_WIDTH = 150;

/** The view switch, in this order. */
export const VIEWS = ['all', 'folders', 'local'];

const idOf = (end) => (typeof end === 'object' && end ? end.id : end);

/** The graph data came from a large library: the build says so; older graph files by their size. */
export function isLarge(data) {
  if (!data) return false;
  return typeof data.large === 'boolean' ? data.large : data.nodes.length > LARGE_LIBRARY;
}

/** The view a library opens on: Folders for a large one, All for a small one. */
export function defaultView(data) {
  return isLarge(data) ? 'folders' : 'all';
}

/** The name a node's label and tooltip use: the display name, the file name for older graph files. */
export function nameOf(node) {
  return node.displayName || node.title;
}

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
/** Estimated width of one character at 11 px: CJK and full-width characters are square. */
function charWidth(ch) {
  if (WIDE.test(ch)) return 11;
  if (/[iljtf.,:;'|!\s]/.test(ch)) return 3.5;
  if (/[mwMW]/.test(ch)) return 9;
  if (/[A-Z]/.test(ch)) return 7.2;
  return 6.2;
}

/**
 * The label shown: the name cut with an ellipsis once it passes maxWidth. Estimated from the
 * characters rather than measured, so thousands of labels cost nothing to lay out.
 */
export function truncateLabel(name, maxWidth = LABEL_WIDTH) {
  const chars = [...String(name ?? '')];
  let w = 0;
  for (let i = 0; i < chars.length; i++) {
    w += charWidth(chars[i]);
    if (w > maxWidth) {
      // Room for the ellipsis: drop characters until it fits.
      let cut = i;
      let width = w - charWidth(chars[i]);
      while (cut > 0 && width + 6.5 > maxWidth) width -= charWidth(chars[--cut]);
      return `${chars.slice(0, cut).join('').trimEnd()}…`;
    }
  }
  return chars.join('');
}

/** Estimated width of a label as shown, for fitting the view. */
export function labelWidth(text) {
  let w = 0;
  for (const ch of String(text ?? '')) w += charWidth(ch);
  return w;
}

/** Neighbours per document: [{ id, weight, edge }], strongest first, ties by id. */
export function adjacency(edges) {
  const out = new Map();
  const add = (a, b, e) => {
    if (!out.has(a)) out.set(a, []);
    out.get(a).push({ id: b, weight: e.weight || 1, edge: e });
  };
  for (const e of edges) {
    const s = idOf(e.source);
    const t = idOf(e.target);
    add(s, t, e);
    add(t, s, e);
  }
  // Two edges of different kinds between one pair: one neighbour, weights summed.
  for (const [k, list] of out) {
    const merged = new Map();
    for (const n of list) {
      const m = merged.get(n.id);
      if (m) m.weight += n.weight;
      else merged.set(n.id, { ...n });
    }
    out.set(
      k,
      [...merged.values()].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
  }
  return out;
}

/**
 * Local view: the centre and its directly linked documents, with secondHop the documents linked to
 * those as well. Past limit neighbours only the strongest are drawn: the direct ones by the weight
 * of their link to the centre, then the second step by their strongest link into the first; the
 * rest are listed in more, in the same order. Links are every edge between two drawn documents.
 */
export function localScene(data, centerId, { secondHop = false, limit = LOCAL_LIMIT } = {}) {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  if (!byId.has(centerId)) return { center: null, nodes: [], edges: [], more: [] };
  const adj = adjacency(data.edges);
  const first = (adj.get(centerId) ?? []).map((n) => ({ id: n.id, hop: 1, weight: n.weight }));
  const ranked = [...first];
  if (secondHop) {
    const seen = new Set([centerId, ...first.map((n) => n.id)]);
    const best = new Map();
    for (const f of first)
      for (const n of adj.get(f.id) ?? []) {
        if (seen.has(n.id)) continue;
        best.set(n.id, Math.max(best.get(n.id) ?? 0, n.weight));
      }
    const second = [...best.entries()]
      .map(([id, weight]) => ({ id, hop: 2, weight }))
      .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    ranked.push(...second);
  }
  const shown = ranked.slice(0, limit);
  const more = ranked.slice(limit);
  const ids = new Set([centerId, ...shown.map((n) => n.id)]);
  const nodes = [
    { ...byId.get(centerId), hop: 0 },
    ...shown.filter((n) => byId.has(n.id)).map((n) => ({ ...byId.get(n.id), hop: n.hop })),
  ];
  const edges = data.edges.filter((e) => ids.has(idOf(e.source)) && ids.has(idOf(e.target)));
  return {
    center: centerId,
    nodes,
    edges,
    more: more.filter((n) => byId.has(n.id)).map((n) => ({ ...byId.get(n.id), hop: n.hop })),
  };
}

/**
 * The folder group of a document by its relPath (the linked folder's name, then the path inside it;
 * a file added to the library has its file name only). Grouped by the first folder inside a linked
 * folder; the files right at the top of a linked folder form a group named after it, and the files
 * added to the library one of their own.
 */
export function folderOf(relPath) {
  const parts = String(relPath || '')
    .split(/[\\/]+/)
    .filter(Boolean);
  if (parts.length <= 1) return { key: 'added:', label: 'Added files', sub: false };
  if (parts.length === 2) return { key: `top:${parts[0]}`, label: parts[0], sub: false };
  return { key: `sub:${parts[0]}/${parts[1]}`, label: parts[1], parent: parts[0], sub: true };
}

/**
 * The groups of the Folders view: one per first-level subfolder (folderOf), or, when no document
 * lies in a subfolder, one per document type. Groups come in label order; members in name order.
 * Two linked folders with a subfolder of one name keep two groups, labelled with their parent.
 */
export function folderGroups(nodes, typeLabels = new Map()) {
  const bySub = nodes.some((n) => folderOf(n.relPath).sub);
  const groups = new Map();
  const groupOf = new Map();
  for (const n of nodes) {
    const g = bySub
      ? folderOf(n.relPath)
      : { key: `type:${n.type}`, label: typeLabels.get(n.type) || n.type || 'Other', sub: false };
    if (!groups.has(g.key)) groups.set(g.key, { ...g, id: `group:${g.key}`, members: [] });
    groups.get(g.key).members.push(n.id);
    groupOf.set(n.id, g.key);
  }
  const labelCount = new Map();
  for (const g of groups.values()) labelCount.set(g.label, (labelCount.get(g.label) ?? 0) + 1);
  for (const g of groups.values()) if (labelCount.get(g.label) > 1 && g.parent) g.label = `${g.parent} › ${g.label}`;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const g of groups.values()) g.members.sort((a, b) => cmpName(byId.get(a), byId.get(b)));
  const list = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return { by: bySub ? 'folder' : 'type', groups: list, groupOf };
}

function cmpName(a, b) {
  return nameOf(a).localeCompare(nameOf(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Folders view: a node per collapsed group and the documents of every expanded group. Each edge
 * between two documents goes to the nodes standing for them: the document when its group is
 * expanded, else its group. Edges inside one collapsed group are not drawn. Edges that land on one
 * pair of nodes merge into one link whose count is the number of document links it stands for;
 * a link between two documents keeps its edge (kind, headings, passages) for the click.
 */
export function folderScene(data, expanded = new Set(), grouping = folderGroups(data.nodes)) {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const nodes = [];
  const standFor = new Map();
  for (const g of grouping.groups) {
    if (expanded.has(g.key)) {
      for (const id of g.members) {
        nodes.push({ ...byId.get(id), role: 'doc', group: g.key });
        standFor.set(id, id);
      }
    } else {
      nodes.push({ role: 'group', id: g.id, key: g.key, label: g.label, count: g.members.length, members: g.members });
      for (const id of g.members) standFor.set(id, g.id);
    }
  }
  const links = new Map();
  for (const e of data.edges) {
    const a = standFor.get(idOf(e.source));
    const b = standFor.get(idOf(e.target));
    if (!a || !b || a === b) continue;
    const docLink = (a === idOf(e.source) && b === idOf(e.target)) || (a === idOf(e.target) && b === idOf(e.source));
    const [s, t] = a < b ? [a, b] : [b, a];
    // A pair of documents linked by two rules keeps two links (one per kind), as All draws them.
    const key = docLink ? `doc:${e.id}` : `agg:${s}|${t}`;
    const old = links.get(key);
    if (old) {
      old.count += 1;
      old.weight += e.weight || 1;
    } else
      links.set(key, {
        id: key,
        source: s,
        target: t,
        count: 1,
        weight: e.weight || 1,
        kind: docLink ? e.kind : 'aggregate',
        edge: docLink ? e : null,
      });
  }
  return {
    by: grouping.by,
    nodes,
    links: [...links.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
  };
}

/**
 * The documents whose labels the All view shows from the start: the n with the most links, ties
 * by name and then id so the choice never changes between two draws. Documents without links
 * never count.
 */
export function topLinked(nodes, edges, n = TOP_LABELS) {
  const count = new Map();
  for (const e of edges) {
    count.set(idOf(e.source), (count.get(idOf(e.source)) ?? 0) + 1);
    count.set(idOf(e.target), (count.get(idOf(e.target)) ?? 0) + 1);
  }
  return new Set(
    nodes
      .filter((x) => (count.get(x.id) ?? 0) > 0)
      .sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0) || cmpName(a, b))
      .slice(0, n)
      .map((x) => x.id),
  );
}

/** Documents whose display name, file name or path holds the query, any case; none for an empty query. */
export function searchMatches(nodes, query) {
  const q = String(query ?? '')
    .toLowerCase()
    .trim();
  if (!q) return [];
  return nodes.filter(
    (n) =>
      nameOf(n).toLowerCase().includes(q) || n.title?.toLowerCase().includes(q) || n.relPath?.toLowerCase().includes(q),
  );
}

/** The ids given and every node linked to one of them by the links given. */
export function withNeighbours(ids, links) {
  const out = new Set(ids);
  for (const e of links) {
    const s = idOf(e.source);
    const t = idOf(e.target);
    if (ids.has(s)) out.add(t);
    if (ids.has(t)) out.add(s);
  }
  return out;
}
