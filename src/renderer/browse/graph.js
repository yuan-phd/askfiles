// Graph page of the Browse view (docs/graph.md; called Overview before 2026-11-04): the library's documents as a graph, ported from
// the owner's earlier wiki graph (docs/reference/old-graph-code.txt, renderGraph and filterGraph)
// with its feel kept: link distance 100, charge -300, collide 30, node radius from the link count
// clamped 5 to 14, labels always shown, hover lights the node and its neighbours and fades the rest
// to 0.1, drag pins a node while it is dragged, search lights matches and their neighbours, the
// legend stays fixed outside the zoom group. Changes, as the brief asks: d3 v7 from the app's own
// files, a layered layout (bands by type, forceY from the current height) in place of the people
// ring, resize handling, the previous simulation stopped before a new one, search selecting only
// the node, label and link groups (the old code also picked up the legend's circles and threw),
// the active search applied again after a re-render and after hover, colours from the profile,
// edge styles by kind, and edge clicks that open a shared heading on Compare or the referencing passage.
//
// Three views (docs/graph.md, Large libraries): Local (one document and what it links to), Folders
// (one node per first-level subfolder, expanded in place) and All. A library of LARGE_LIBRARY or
// fewer documents opens on All, which draws exactly the graph above; a larger one opens on Local,
// and its All view shows only the labels of the most linked documents until hovered, searched or
// zoomed in. What each view holds comes from graph-model.js; this file only draws it.

import {
  defaultView,
  folderGroups,
  folderScene,
  LABEL_ZOOM,
  LARGE_LIBRARY,
  labelWidth,
  localScene,
  nameOf,
  searchMatches,
  topLinked,
  truncateLabel,
  VIEWS,
  withNeighbours,
} from './graph-model.js';

const D3_URL = new URL('../vendor/d3.min.js', import.meta.url).href;
let d3Loading = null;

/** d3 v7, loaded once from the app bundle (never a CDN). */
export function loadD3() {
  if (window.d3) return Promise.resolve(window.d3);
  if (!d3Loading) {
    d3Loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = D3_URL;
      s.onload = () => (window.d3 ? resolve(window.d3) : reject(new Error('d3 did not load')));
      s.onerror = () => {
        d3Loading = null;
        reject(new Error('d3 could not be loaded'));
      };
      document.head.append(s);
    });
  }
  return d3Loading;
}

/** The original's forces and opacities, kept as they were. */
export const FORCES = { linkDistance: 100, charge: -300, collide: 30 };
/**
 * Forces for a drawing of more than LARGE_LIBRARY nodes: the original's would spread 900 documents
 * over many screens. Tighter, and the layout cools faster, so it settles in about a third of the
 * ticks.
 */
export const LARGE_FORCES = { linkDistance: 40, charge: -45, collide: 4, alphaDecay: 0.06 };
/**
 * Folders: a folder pushes harder and keeps room for its label below it; the link standing for
 * many document links pulls only weakly, so busy folders do not pile onto each other.
 */
export const FOLDER_FORCES = {
  linkDistance: 40,
  groupDistance: 90,
  charge: -45,
  groupCharge: -600,
  collide: 4,
  groupCollide: 34,
  groupLinkStrength: 0.08,
  alphaDecay: 0.05,
};
/**
 * A weak pull of every node toward the middle. forceCenter only moves the whole graph's centre of
 * mass, so a document without links was pushed off screen by the charge; with this pull it rests at
 * the outer edge of the cluster. Weak enough that linked documents keep the original shape.
 */
export const CENTERING = 0.04;
/** Local: the original's forces with the large views' cooling. */
export const LOCAL_FORCES = { ...FORCES, alphaDecay: LARGE_FORCES.alphaDecay };
const OPACITY = { link: 0.6, linkLit: 0.8, linkFaded: 0.05, faded: 0.1, searchFaded: 0.05, searchLinkFaded: 0.02 };
/** Height of the tools and the bar over the graph's top edge. */
const TOOLS_HEIGHT = 84;
/** Search results listed under the search box. */
const RESULTS = 8;

/** Node radius from its link count, as in the original: count * 1.2 + 4, clamped 5 to 14. */
export function nodeRadius(count) {
  return Math.max(5, Math.min(14, count * 1.2 + 4));
}

/** Smaller nodes for a drawing of many documents: count + 3, clamped 3 to 9. */
function smallRadius(count) {
  return Math.max(3, Math.min(9, count + 3));
}

/** A folder node grows with the documents it holds: 8 + 2.2 * sqrt(count), at most 36. */
export function groupRadius(count) {
  return Math.min(36, 8 + 2.2 * Math.sqrt(count));
}

/** Label offset, as in the original: count * 2 + 4 clamped 6 to 20, plus 4. */
function labelOffset(count) {
  return Math.max(6, Math.min(20, count * 2 + 4)) + 4;
}

/** Band per type in the profile's band order; types not listed go last. Only bands in use count. */
export function bandsOf(nodes, order) {
  const rank = (t) => {
    const i = order.indexOf(t);
    return i < 0 ? order.length : i;
  };
  const used = [...new Set(nodes.map((n) => n.type))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return new Map(used.map((t, i) => [t, i]));
}

/** The y of band i of n, from the current height: evenly spaced, centred in its share. */
export function bandY(i, n, height) {
  return (height * (i + 0.5)) / Math.max(1, n);
}

const idOf = (end) => (typeof end === 'object' ? end.id : end);

const EDGE_LABEL = {
  headings: 'Shared headings',
  reference: 'Reference',
  version: 'Versions',
  related: 'Related',
  project: 'Same project',
  ticket: 'Same ticket',
  date: 'Days apart',
};

const VIEW_LABEL = { local: 'Local', folders: 'Folders', all: 'All' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** A seeded offset in -1 to 1 from a string, so a document opened out of its folder lands the same way each time. */
function jitter(s, salt) {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

/**
 * Mounts the graph page into root. getData() resolves to the bridge's graph data (nodes, edges,
 * profile, summaries) or null; onOpenDocument(id, target) and onOpenHeading(key) open the other
 * Browse pages; onPlace(place) hears when the user changed the view or Local's centre, for the
 * page history. Returns { show(), hide(), reload(), setLayout(name), setView(name), showDocument(id),
 * place(), setPlace(place), search(query), state }.
 */
export function createGraphPage(root, { getData, onOpenDocument, onOpenHeading, onPlace = () => {} }) {
  root.classList.add('graph');
  root.innerHTML = `
    <div class="graph-tools">
      <div class="graph-views" role="group" aria-label="View" data-testid="graph-views">
        ${VIEWS.map(
          (v) =>
            `<button type="button" data-view="${v}" data-testid="graph-view-${v}" aria-pressed="false">${VIEW_LABEL[v]}</button>`,
        ).join('')}
      </div>
      <div class="graph-search-box">
        <label class="visually-hidden" for="graph-search">Search documents</label>
        <input id="graph-search" type="search" data-testid="graph-search" placeholder="Search documents..." spellcheck="false" autocomplete="off" role="combobox" aria-controls="graph-results" aria-expanded="false" />
        <ul class="graph-results" id="graph-results" data-testid="graph-results" role="listbox" hidden></ul>
      </div>
      <div class="graph-layout" role="group" aria-label="Layout">
        <button type="button" data-layout="organic" data-testid="graph-organic" aria-pressed="true">Organic</button>
        <button type="button" data-layout="layered" data-testid="graph-layered" aria-pressed="false">Layered</button>
      </div>
    </div>
    <div class="graph-bar" data-testid="graph-bar" hidden></div>
    <svg class="graph-svg" data-testid="graph-svg" role="img" aria-label="Documents and how they connect"></svg>
    <div class="graph-tooltip" data-testid="graph-tooltip" role="tooltip" hidden></div>
    <div class="graph-chooser" data-testid="graph-chooser" hidden></div>
    <div class="graph-card" data-testid="graph-card" role="region" aria-label="Selected document" hidden></div>
    <p class="browse-empty graph-empty" data-testid="graph-empty" hidden></p>
    <p class="browse-empty graph-pick" data-testid="graph-pick" hidden>Search for a document above and choose it to see the documents it links to.</p>`;
  const q = (id) => root.querySelector(`[data-testid="${id}"]`);
  const svgEl = q('graph-svg');
  const tooltip = q('graph-tooltip');
  const chooser = q('graph-chooser');
  const searchInput = q('graph-search');
  const results = q('graph-results');
  const bar = q('graph-bar');
  const card = q('graph-card');
  const state = {
    data: null,
    layout: 'organic',
    /** local, folders or all; null until the first data says which a library opens on. */
    view: null,
    /** Local's centre, a document id. */
    center: null,
    secondHop: false,
    /** The selected document: lit with its links, its card pinned. Kept across redraws while drawn. */
    selected: null,
    /** Folders view: the keys of the groups shown as their documents. */
    expanded: new Set(),
    query: '',
    simulation: null,
    visible: false,
    rendered: 0,
    width: 0,
    height: 0,
    zoomK: 1,
  };
  let selections = null;
  /** Where the nodes of the last Folders drawing rested, so expanding a folder moves nothing else. */
  let folderPositions = new Map();

  function stopSimulation() {
    state.simulation?.stop();
    state.simulation = null;
  }

  /**
   * Leaving the page: the zoom's wheel, touch and pointer listeners and the drawing go, so nothing
   * of the graph is left catching events on the page that replaces it.
   */
  function teardown() {
    stopSimulation();
    if (window.d3) window.d3.select(svgEl).on('.zoom', null).selectAll('*').remove();
    selections = null;
    delete root.dataset.settled;
  }

  function showEmpty(text) {
    q('graph-empty').textContent = text;
    q('graph-empty').hidden = !text;
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  function placeFloating(node, event) {
    const box = root.getBoundingClientRect();
    // A click from the keyboard or a script has no position: the middle of the page.
    const x = Number.isFinite(event?.clientX) && event.clientX ? event.clientX - box.left : box.width / 2;
    const y = Number.isFinite(event?.clientY) && event.clientY ? event.clientY - box.top : box.height / 3;
    node.style.left = `${Math.max(8, Math.min(box.width - 308, x + 14))}px`;
    node.style.top = `${Math.max(8, Math.min(box.height - 60, y + 14))}px`;
  }

  function summaryLine(d) {
    const s = state.data?.summaries?.[d.id];
    if (!s || s.state === 'off') return null;
    if (s.state === 'ok') return { text: s.text, pending: false };
    if (s.state === 'pending') return { text: 'Summary pending', pending: true };
    return null;
  }

  function typeLabelOf(type) {
    return state.data?.profile.types.find((t) => t.name === type)?.label || type;
  }

  function showNodeTooltip(event, d) {
    tooltip.replaceChildren();
    if (d.role === 'group') {
      tooltip.append(el('strong', 'tip-title', d.label));
      tooltip.append(
        el('span', 'tip-meta', `${d.count === 1 ? '1 document' : `${d.count} documents`} · click to open it`),
      );
    } else if (d.role === 'more') {
      tooltip.append(el('strong', 'tip-title', d.label));
      tooltip.append(el('span', 'tip-meta', 'Click to list them'));
    } else docFacts(tooltip, d);
    tooltip.hidden = false;
    placeFloating(tooltip, event);
  }

  function showEdgeTooltip(event, l) {
    tooltip.replaceChildren();
    const e = l.edge;
    if (!e) {
      tooltip.append(el('strong', 'tip-title', l.count === 1 ? '1 link' : `${l.count} links`));
      tooltip.append(el('span', 'tip-meta', 'between documents of these two groups'));
    } else {
      tooltip.append(
        el('strong', 'tip-title', `${EDGE_LABEL[e.kind] || e.kind}${e.weight > 1 ? `: ${e.weight}` : ''}`),
      );
      if (e.headings?.length)
        tooltip.append(
          el(
            'span',
            'tip-meta',
            e.headings
              .slice(0, 5)
              .map((h) => h.label)
              .join(', '),
          ),
        );
      else if (e.passages?.length) tooltip.append(el('span', 'tip-meta', e.passages[0].sectionTitle));
      else if (e.terms?.length) tooltip.append(el('span', 'tip-meta', e.terms.slice(0, 6).join(', ')));
    }
    tooltip.hidden = false;
    placeFloating(tooltip, event);
  }

  /** The facts of a document, for the hover tooltip and the pinned card alike. */
  function docFacts(box, d) {
    // The full name; the label may be cut.
    box.append(el('strong', 'tip-title', nameOf(d)));
    const meta = [typeLabelOf(d.type), d.sectionCount === 1 ? '1 section' : `${d.sectionCount} sections`];
    if (d.date) meta.push(d.date.value);
    box.append(el('span', 'tip-meta', d.title));
    box.append(el('span', 'tip-meta', meta.join(' · ')));
    const s = summaryLine(d);
    if (s) {
      const p = el('span', `tip-summary${s.pending ? ' pending' : ''}`, s.text);
      p.dataset.testid = box === card ? 'graph-card-summary' : 'graph-tooltip-summary';
      box.append(p);
    }
  }

  /** The selected document's card, pinned at the top right: its facts, Open document and Show in Local. */
  function renderCard() {
    const d = state.selected && state.data?.nodes.find((n) => n.id === state.selected);
    if (!d) {
      card.hidden = true;
      card.replaceChildren();
      return;
    }
    card.replaceChildren();
    docFacts(card, d);
    const actions = el('div', 'graph-card-actions');
    const open = el('button', 'link', 'Open document');
    open.type = 'button';
    open.dataset.testid = 'graph-card-open';
    open.addEventListener('click', () => onOpenDocument(d.id, {}));
    const local = el('button', 'link', 'Show in Local');
    local.type = 'button';
    local.dataset.testid = 'graph-card-local';
    local.addEventListener('click', () => setCenter(d.id, { user: true }));
    actions.append(open, local);
    card.append(actions);
    card.hidden = false;
  }

  /** Selects a document: it and its links lit, the rest dimmed, its card pinned. No redraw. */
  function select(id) {
    hideTooltip();
    closeChooser();
    state.selected = id;
    renderCard();
    applySearch();
  }

  function clearSelection() {
    if (!state.selected) return;
    state.selected = null;
    renderCard();
    applySearch();
  }

  function closeChooser() {
    chooser.hidden = true;
    chooser.replaceChildren();
  }

  /** A shared-headings edge opens that heading on the Compare page; with several headings, the user picks one. */
  function openEdge(event, e) {
    hideTooltip();
    if (e.kind === 'headings' && e.headings?.length) {
      if (e.headings.length === 1) return onOpenHeading(e.headings[0].key);
      chooser.replaceChildren(el('p', 'chooser-title', 'Compare a shared heading'));
      const list = el('ul', 'chooser-list');
      for (const h of e.headings) {
        const li = el('li');
        const b = el('button', 'link', h.label);
        b.type = 'button';
        b.dataset.testid = 'graph-chooser-heading';
        b.addEventListener('click', () => {
          closeChooser();
          onOpenHeading(h.key);
        });
        li.append(b);
        list.append(li);
      }
      chooser.append(list);
      chooser.hidden = false;
      placeFloating(chooser, event);
      return;
    }
    if (e.kind === 'reference' && e.passages?.length) {
      const p = e.passages[0];
      onOpenDocument(p.documentId, { sectionIndex: p.sectionIndex });
    }
  }

  /** "+N more": the neighbours Local leaves out, each a button that recentres on it. */
  function openMore(event, d) {
    hideTooltip();
    chooser.replaceChildren(el('p', 'chooser-title', d.label));
    const list = el('ul', 'chooser-list graph-more-list');
    list.dataset.testid = 'graph-more-list';
    for (const n of d.items) {
      const li = el('li');
      const b = el('button', 'link', nameOf(n));
      b.type = 'button';
      b.title = n.relPath;
      b.dataset.testid = 'graph-more-item';
      b.dataset.id = n.id;
      b.addEventListener('click', () => {
        closeChooser();
        setCenter(n.id, { user: true });
      });
      li.append(b);
      list.append(li);
    }
    chooser.append(list);
    chooser.hidden = false;
    placeFloating(chooser, event);
  }

  // --- what each view draws ----------------------------------------------------------------------

  /**
   * The scene of the current view: nodes ({ role: doc, group or more, ... }), links (each with the
   * original edge when it joins two documents), and how labels show. Positions are set here, in
   * the svg's coordinates, before the forces run.
   */
  function sceneOf(data, width, height) {
    const layered = state.layout === 'layered' && state.view !== 'folders';
    const bands = bandsOf(data.nodes, data.profile.bands);
    const place = (n, scale = 1) => {
      const p = layered ? n.positions.layered : n.positions.organic;
      n.x = width / 2 + p.x * width * (layered ? 0.45 : 0.35) * scale;
      n.y = layered
        ? bandY(bands.get(n.type), bands.size, height) + p.y * 20
        : height / 2 + p.y * height * 0.35 * scale;
    };
    if (state.view === 'local') {
      const s = localScene(data, state.center, { secondHop: state.secondHop });
      const nodes = s.nodes.map((n) => ({ ...n, role: 'doc' }));
      for (const n of nodes) place(n);
      const centre = nodes[0];
      if (centre && !layered) {
        centre.x = width / 2;
        centre.y = height / 2;
      }
      const links = s.edges.map((e) => ({ ...e, edge: e, count: 1 }));
      if (s.more.length) {
        const more = {
          role: 'more',
          id: 'more',
          label: `+${s.more.length} more`,
          items: s.more,
          type: centre?.type,
          x: width / 2 + 60,
          y: height / 2 + 60,
        };
        nodes.push(more);
        links.push({
          id: 'more-link',
          source: centre.id,
          target: 'more',
          kind: 'more',
          weight: 1,
          count: 1,
          edge: null,
        });
      }
      return { nodes, links, labelsAlways: true, top: new Set(), layered, bands, large: nodes.length > LARGE_LIBRARY };
    }
    if (state.view === 'folders') {
      const grouping = folderGroups(data.nodes, new Map(data.profile.types.map((t) => [t.name, t.label])));
      // Expanded groups that are gone (a folder emptied) are forgotten.
      for (const k of state.expanded) if (!grouping.groups.some((g) => g.key === k)) state.expanded.delete(k);
      // A selected document is drawn: its folder is open.
      const selectedGroup = state.selected && grouping.groupOf.get(state.selected);
      if (selectedGroup) state.expanded.add(selectedGroup);
      const s = folderScene(data, state.expanded, grouping);
      const count = s.nodes.length;
      const golden = Math.PI * (3 - Math.sqrt(5));
      let i = 0;
      const groupPos = new Map();
      for (const n of s.nodes) {
        if (n.role !== 'group') continue;
        const r = Math.sqrt((i + 0.5) / Math.max(1, grouping.groups.length));
        const theta = i * golden;
        n.x = width / 2 + r * Math.cos(theta) * width * 0.38;
        n.y = height / 2 + r * Math.sin(theta) * height * 0.38;
        i++;
      }
      for (const g of grouping.groups) {
        const was = folderPositions.get(`group:${g.key}`);
        if (was) groupPos.set(g.key, was);
        else {
          const n = s.nodes.find((x) => x.id === `group:${g.key}`);
          if (n) groupPos.set(g.key, { x: n.x, y: n.y });
        }
      }
      for (const n of s.nodes) {
        const was = folderPositions.get(n.id);
        if (was) {
          n.x = was.x;
          n.y = was.y;
        } else if (n.role === 'doc') {
          // A document coming out of its folder starts where the folder was.
          const g = groupPos.get(n.group) ?? { x: width / 2, y: height / 2 };
          n.x = g.x + jitter(n.id, 1) * 30;
          n.y = g.y + jitter(n.id, 2) * 30;
        }
      }
      const docs = s.nodes.filter((n) => n.role === 'doc');
      const docLinks = s.links.filter((l) => l.edge);
      return {
        nodes: s.nodes,
        links: s.links,
        labelsAlways: docs.length <= LARGE_LIBRARY,
        top: topLinked(docs, docLinks),
        layered: false,
        bands,
        large: count > LARGE_LIBRARY,
        by: s.by,
        groups: grouping.groups,
      };
    }
    const nodes = data.nodes.map((n) => ({ ...n, role: 'doc' }));
    for (const n of nodes) place(n);
    const links = data.edges.map((e) => ({ ...e, edge: e, count: 1 }));
    const small = nodes.length <= LARGE_LIBRARY;
    return {
      nodes,
      links,
      labelsAlways: small,
      top: small ? new Set() : topLinked(nodes, links),
      layered,
      bands,
      large: !small,
    };
  }

  // --- search --------------------------------------------------------------------------------

  /** The scene node ids a search lights (matches, a folder holding one), and with them their neighbours. */
  function searchSets() {
    const query = state.query.trim();
    if (!query || !selections) return null;
    const { scene } = selections;
    const docMatches = new Set(searchMatches(state.data.nodes, query).map((n) => n.id));
    const matched = new Set();
    for (const n of scene.nodes) {
      if (n.role === 'doc' && docMatches.has(n.id)) matched.add(n.id);
      if (n.role === 'group' && n.members.some((m) => docMatches.has(m))) matched.add(n.id);
    }
    return { matched, connected: withNeighbours(matched, scene.links) };
  }

  /** The selected document when it is drawn in this view, else null. */
  function selectedShown() {
    const id = state.selected;
    return id && selections?.scene.nodes.some((n) => n.id === id && n.role === 'doc') ? id : null;
  }

  /**
   * What is lit, strongest first: a selected document and its links; else the node under the
   * mouse and its neighbours; else a search's matches and their neighbours (filterGraph, by class
   * so the legend is never touched); else everything.
   */
  function applySearch() {
    if (!selections || !state.data) return;
    const { node, label, link, scene } = selections;
    const sets = searchSets();
    selections.searchLit = sets?.connected ?? null;
    root.dataset.searching = sets ? 'true' : 'false';
    node.classed('match', (d) => !!sets?.matched.has(d.id));
    const sel = selectedShown();
    node.classed('selected', (d) => d.id === sel);
    if (sel) root.dataset.selected = sel;
    else delete root.dataset.selected;
    const touches = (e, id) => idOf(e.source) === id || idOf(e.target) === id;
    const focus = sel ?? selections.hoverId;
    selections.selLit = sel ? withNeighbours(new Set([sel]), scene.links) : null;
    if (focus) {
      const lit = sel ? selections.selLit : selections.hoverLit;
      node.attr('opacity', (n) => (lit.has(n.id) ? 1 : OPACITY.faded));
      label.attr('opacity', (n) => (lit.has(n.id) ? 1 : OPACITY.faded));
      link
        .attr('stroke-opacity', (e) => (touches(e, focus) ? OPACITY.linkLit : OPACITY.linkFaded))
        .classed('lit', (e) => !!sel && touches(e, sel));
    } else if (sets) {
      const { connected } = sets;
      node.attr('opacity', (d) => (connected.has(d.id) ? 1 : OPACITY.searchFaded));
      label.attr('opacity', (d) => (connected.has(d.id) ? 1 : OPACITY.searchFaded));
      link
        .attr('stroke-opacity', (e) =>
          connected.has(idOf(e.source)) && connected.has(idOf(e.target)) ? OPACITY.linkLit : OPACITY.searchLinkFaded,
        )
        .classed('lit', false);
    } else {
      node.attr('opacity', 1);
      label.attr('opacity', 1);
      link.attr('stroke-opacity', OPACITY.link).classed('lit', false);
    }
    updateLabels();
  }

  /** Which labels show: always in Local and small drawings; else the top ten, hover, search and zoom. */
  function updateLabels() {
    if (!selections) return;
    const { scene, label } = selections;
    const all = scene.labelsAlways || state.zoomK >= LABEL_ZOOM;
    const hover = selections.selLit ? null : selections.hoverLit;
    const lit = selections.searchLit;
    const sel = selections.selLit;
    label.classed(
      'off',
      (d) => !(all || d.role !== 'doc' || scene.top.has(d.id) || hover?.has(d.id) || lit?.has(d.id) || sel?.has(d.id)),
    );
    selections.placeLabels();
    root.dataset.labels = String(label.filter(':not(.off):not(.crowded)').size());
  }

  /** The results list under the search box: documents of the whole library, by name. */
  function renderResults() {
    const matches = searchMatches(state.data?.nodes ?? [], state.query)
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
      .slice(0, RESULTS);
    results.replaceChildren(
      ...matches.map((n, i) => {
        const li = el('li');
        const b = el('button', 'graph-result');
        b.type = 'button';
        b.dataset.testid = 'graph-result';
        b.dataset.id = n.id;
        b.setAttribute('role', 'option');
        if (i === 0) b.classList.add('first');
        b.append(el('span', 'graph-result-name', nameOf(n)), el('span', 'graph-result-path', n.relPath));
        // mousedown, so the list does not close on the input's blur first.
        b.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(n.id);
        });
        li.append(b);
        return li;
      }),
    );
    const open = matches.length > 0 && document.activeElement === searchInput;
    results.hidden = !open;
    searchInput.setAttribute('aria-expanded', String(open));
  }

  function closeResults() {
    results.hidden = true;
    searchInput.setAttribute('aria-expanded', 'false');
  }

  /**
   * A search result chosen: Local recentres on it; Folders opens its folder; All lights it. In
   * Folders and All the search stays, so the document and its neighbours stay lit.
   */
  function choose(id) {
    closeResults();
    const n = state.data?.nodes.find((x) => x.id === id);
    if (!n) return;
    if (state.view === 'local') {
      searchInput.value = '';
      state.query = '';
      setCenter(id, { user: true });
      return;
    }
    searchInput.value = nameOf(n);
    state.query = nameOf(n);
    if (state.view === 'folders') {
      const g = folderGroups(state.data.nodes).groupOf.get(id);
      if (g && !state.expanded.has(g)) {
        state.expanded.add(g);
        void render();
        return;
      }
    }
    applySearch();
  }

  // --- the bar under the tools: Local's centre, Folders' open folders ------------------------------

  function renderBar() {
    bar.replaceChildren();
    const data = state.data;
    if (!data || !data.nodes.length) {
      bar.hidden = true;
      return;
    }
    if (state.view === 'local') {
      const centre = data.nodes.find((n) => n.id === state.center);
      if (!centre) {
        bar.hidden = true;
        return;
      }
      const name = el('span', 'graph-center-name', nameOf(centre));
      name.title = centre.relPath;
      name.dataset.testid = 'graph-center';
      const open = el('button', 'link', 'Open document');
      open.type = 'button';
      open.dataset.testid = 'graph-open-center';
      open.addEventListener('click', () => onOpenDocument(centre.id, {}));
      const hop = el('label', 'graph-hop');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.secondHop;
      box.dataset.testid = 'graph-second-hop';
      box.addEventListener('change', () => {
        state.secondHop = box.checked;
        void render();
      });
      hop.append(box, document.createTextNode(' Also show what those link to'));
      bar.append(el('span', 'graph-bar-label', 'Centred on'), name, open, hop);
      bar.hidden = false;
      return;
    }
    if (state.view === 'folders') {
      const grouping = selections?.scene.groups ?? folderGroups(data.nodes);
      const hint = el(
        'span',
        'graph-bar-label',
        selections?.scene.by === 'type'
          ? 'No subfolders: grouped by type. Click a group to show its documents.'
          : 'Click a folder to show its documents.',
      );
      bar.append(hint);
      for (const g of grouping) {
        if (!state.expanded.has(g.key)) continue;
        const chip = el('button', 'graph-chip', `${g.label} ×`);
        chip.type = 'button';
        chip.title = `Close ${g.label}`;
        chip.dataset.testid = 'graph-collapse';
        chip.dataset.key = g.key;
        chip.addEventListener('click', () => {
          state.expanded.delete(g.key);
          if (state.selected && g.members.includes(state.selected)) {
            state.selected = null;
            renderCard();
          }
          void render();
        });
        bar.append(chip);
      }
      bar.hidden = false;
      return;
    }
    bar.hidden = true;
  }

  function renderControls() {
    for (const b of root.querySelectorAll('.graph-views button'))
      b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
    root.querySelector('.graph-layout').hidden = state.view === 'folders';
    root.dataset.view = state.view || '';
    if (state.center) root.dataset.center = state.center;
    else delete root.dataset.center;
  }

  // --- drawing -------------------------------------------------------------------------------

  async function render() {
    if (!state.visible) return;
    const data = state.data;
    const t0 = window.performance.now();
    // Taken before the awaits, so the size observer sees this draw's size and does not draw again.
    state.width = svgEl.clientWidth || root.clientWidth || 800;
    state.height = svgEl.clientHeight || root.clientHeight || 600;
    stopSimulation();
    hideTooltip();
    closeChooser();
    if (data && !state.view) state.view = defaultView(data);
    if (state.center && !data?.nodes.some((n) => n.id === state.center)) state.center = null;
    renderControls();
    let d3;
    try {
      d3 = await loadD3();
    } catch (e) {
      showEmpty(`The graph could not be drawn: ${e.message}`);
      return;
    }
    // The page may have been left while d3 loaded.
    if (!state.visible) return;
    const svg = d3.select(svgEl);
    svg.on('.zoom', null).selectAll('*').remove();
    selections = null;
    q('graph-pick').hidden = true;
    if (!data || !data.nodes.length) {
      renderBar();
      showEmpty(
        data
          ? 'No documents yet. They appear here once they are indexed.'
          : 'The graph is available in the AskFiles app.',
      );
      return;
    }
    showEmpty('');
    if (state.view === 'local' && !state.center) {
      renderBar();
      q('graph-pick').hidden = false;
      root.dataset.settled = 'true';
      root.dataset.rendered = String(++state.rendered);
      return;
    }
    const width = state.width;
    const height = state.height;
    svg.attr('viewBox', [0, 0, width, height]);

    const colors = new Map(data.profile.types.map((t) => [t.name, t.color]));
    const fallback = '#8a8f9e';
    const scene = sceneOf(data, width, height);
    const { nodes, links, layered, bands } = scene;
    const folders = state.view === 'folders';
    const local = state.view === 'local';
    // Local keeps the original's forces but cools as fast as the large views, so it rests in about 2 s.
    const forces = folders ? FOLDER_FORCES : scene.large ? LARGE_FORCES : local ? LOCAL_FORCES : FORCES;
    // Labels of a large drawing keep their size on screen when the view is zoomed out to fit it.
    const scaleLabels = scene.large || folders;
    const linkCount = {};
    for (const e of links) {
      linkCount[idOf(e.source)] = (linkCount[idOf(e.source)] || 0) + 1;
      linkCount[idOf(e.target)] = (linkCount[idOf(e.target)] || 0) + 1;
    }
    for (const n of nodes) {
      n.name = n.role === 'doc' ? nameOf(n) : n.role === 'group' ? `${n.label} (${n.count})` : n.label;
      n.short = truncateLabel(n.name);
      n.r =
        n.role === 'group'
          ? groupRadius(n.count)
          : n.role === 'more'
            ? 11
            : scene.large
              ? smallRadius(linkCount[n.id] || 0)
              : nodeRadius(linkCount[n.id] || 0);
    }

    const g = svg.append('g').attr('class', 'zoom-layer');
    let userZoomed = false;
    state.zoomK = 1;
    const zoom = d3
      .zoom()
      .scaleExtent(scene.large ? [0.08, 8] : [0.2, 5])
      .on('zoom', (event) => {
        // A zoom from the wheel, a drag or a pinch has a source event; the fit below has none.
        if (event.sourceEvent) userZoomed = true;
        g.attr('transform', event.transform);
        const before = state.zoomK >= LABEL_ZOOM;
        state.zoomK = event.transform.k;
        root.dataset.zoom = state.zoomK.toFixed(2);
        if (scaleLabels) sizeLabels(state.zoomK);
        if (before !== state.zoomK >= LABEL_ZOOM) updateLabels();
        else if (scaleLabels) placeSoon();
      });
    svg.call(zoom);

    const simulation = d3
      .forceSimulation(nodes)
      .force(
        'link',
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance(
            folders
              ? (l) =>
                  (l.kind === 'aggregate' ? forces.groupDistance : forces.linkDistance) +
                  (l.source.r || 0) +
                  (l.target.r || 0)
              : forces.linkDistance,
          ),
      )
      .force(
        'charge',
        d3
          .forceManyBody()
          .strength(folders ? (d) => (d.role === 'group' ? forces.groupCharge : forces.charge) : forces.charge),
      )
      .force(
        'collision',
        d3
          .forceCollide()
          .radius(
            !folders && !scene.large
              ? forces.collide
              : (d) => d.r + (folders && d.role === 'group' ? forces.groupCollide : forces.collide),
          ),
      );
    if (folders) {
      // d3's default strength for the links between documents; a weak pull for the group links.
      simulation
        .force('link')
        .strength((l) =>
          l.kind === 'aggregate'
            ? forces.groupLinkStrength
            : 1 / Math.max(1, Math.min(linkCount[idOf(l.source)] || 1, linkCount[idOf(l.target)] || 1)),
        );
    }
    if (forces.alphaDecay) simulation.alphaDecay(forces.alphaDecay);
    if (layered) {
      simulation
        .force('centerX', d3.forceX(width / 2).strength(CENTERING))
        .force('band', d3.forceY((d) => bandY(bands.get(d.type) ?? 0, bands.size, height)).strength(0.4));
    } else {
      simulation
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('pullX', d3.forceX(width / 2).strength(CENTERING))
        .force('pullY', d3.forceY(height / 2).strength(CENTERING));
    }
    state.simulation = simulation;

    const linkGroup = g.append('g').attr('class', 'links');
    const link = linkGroup
      .selectAll('line.link')
      .data(links)
      .join('line')
      .attr('class', (e) => `link kind-${e.kind}`)
      .attr('data-kind', (e) => e.kind)
      .attr('data-testid', (e) => (e.kind === 'aggregate' ? 'graph-group-link' : null))
      .attr('data-count', (e) => (e.kind === 'aggregate' ? e.count : null))
      .attr('stroke-width', (e) =>
        e.kind === 'aggregate'
          ? Math.min(10, 1 + Math.log2(e.count) * 1.5)
          : Math.min(4, 1 + Math.log2(e.weight || 1) * 0.5),
      )
      .attr('stroke-opacity', OPACITY.link);
    // Wide invisible lines over the edges, so a thin edge can still be clicked.
    const hit = g
      .append('g')
      .attr('class', 'link-hits')
      .selectAll('line.link-hit')
      .data(links.filter((l) => l.kind !== 'more'))
      .join('line')
      .attr('class', 'link-hit')
      .attr('data-testid', (e) => (e.edge ? 'graph-edge' : null))
      .attr('data-kind', (e) => e.kind)
      .attr('data-source', (e) => idOf(e.source))
      .attr('data-target', (e) => idOf(e.target))
      .on('mouseover', (event, e) => showEdgeTooltip(event, e))
      .on('mouseout', hideTooltip)
      .on('click', (event, e) => {
        event.stopPropagation();
        if (e.edge) openEdge(event, e.edge);
      });

    const testidOf = (d) => (d.role === 'group' ? 'graph-group' : d.role === 'more' ? 'graph-more' : 'graph-node');
    const node = g
      .append('g')
      .attr('class', 'nodes')
      .selectAll('circle.node')
      .data(nodes)
      .join('circle')
      .attr(
        'class',
        (d) =>
          `node role-${d.role}${d.role === 'doc' && summaryLine(d)?.pending ? ' pending' : ''}${
            state.view === 'local' && d.id === state.center ? ' center' : ''
          }`,
      )
      .attr('data-testid', testidOf)
      .attr('data-id', (d) => d.id)
      .attr('data-type', (d) => (d.role === 'doc' ? d.type : null))
      .attr('data-key', (d) => (d.role === 'group' ? d.key : null))
      .attr('data-count', (d) => (d.role === 'group' ? d.count : null))
      .attr('data-hop', (d) => (d.role === 'doc' && state.view === 'local' ? d.hop : null))
      .attr('r', (d) => d.r)
      .attr('fill', (d) => (d.role === 'doc' ? colors.get(d.type) || fallback : null))
      .call(
        d3
          .drag()
          .on('start', (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }),
      );

    const label = g
      .append('g')
      .attr('class', 'labels')
      .selectAll('text.label')
      .data(nodes)
      .join('text')
      .attr('class', (d) => `label role-${d.role}`)
      .attr('data-testid', 'graph-label')
      .attr('data-id', (d) => d.id)
      .text((d) => d.short)
      .attr('font-size', 11);

    /** The label's font scale: 1, or 1 / zoom below zoom 1 in a large drawing, so it keeps 11 px on screen. */
    const labelScale = () => (scaleLabels ? 1 / Math.min(1, state.zoomK) : 1);

    function sizeLabels() {
      label.attr('font-size', 11 * labelScale());
    }

    /**
     * Where each label goes beside its node, in order of preference: right (the original's offset),
     * left, below, above, then right and left a line higher or lower. A folder's label goes below
     * it first. dy is the baseline.
     */
    function spots(d, s) {
      if (d.role === 'more') return [{ dx: 0, dy: 4 * s, anchor: 'middle' }];
      const r = d.r;
      const gap = 4 * s;
      const line = 13 * s;
      const right = d.role === 'doc' && !scaleLabels ? labelOffset(linkCount[d.id] || 0) : r + gap;
      const side = [
        { dx: right, dy: 4 * s, anchor: 'start' },
        { dx: -(r + gap), dy: 4 * s, anchor: 'end' },
      ];
      const below = { dx: 0, dy: r + 11 * s, anchor: 'middle' };
      const above = { dx: 0, dy: -(r + 4 * s), anchor: 'middle' };
      const shifted = [
        { dx: right, dy: 4 * s - line, anchor: 'start' },
        { dx: right, dy: 4 * s + line, anchor: 'start' },
        { dx: -(r + gap), dy: 4 * s - line, anchor: 'end' },
        { dx: -(r + gap), dy: 4 * s + line, anchor: 'end' },
      ];
      if (d.role === 'group') return [{ dx: 0, dy: r + 14 * s, anchor: 'middle' }, above, ...side, ...shifted];
      return [...side, below, above, ...shifted];
    }

    /**
     * Places the labels shown so that none runs into another or into a folder's circle. The most
     * important go first (the selected document, what it links to, folders, search matches, the
     * most linked); each takes the first spot that is free. A label with no free spot is held back
     * (class crowded) until there is room: after a zoom, a move or a new selection.
     */
    function placeLabels() {
      const s = labelScale();
      const fs = 11 * s;
      const els = label.nodes();
      const items = [];
      label.classed('crowded', false);
      els.forEach((elmt, i) => {
        const d = elmt.__data__;
        if (elmt.classList.contains('off')) return;
        items.push({ elmt, d, i });
      });
      // Read every width first, then write: no layout between the writes.
      for (const it of items) {
        if (it.d.w11 == null) {
          const size = parseFloat(it.elmt.getAttribute('font-size')) || 11;
          const w = it.elmt.getComputedTextLength();
          if (w > 0) it.d.w11 = (w * 11) / size;
        }
      }
      const sel = selections?.selLit;
      const lit = selections?.searchLit;
      const rank = (d) =>
        d.id === state.selected
          ? 0
          : sel?.has(d.id)
            ? 1
            : d.role !== 'doc'
              ? 2
              : lit?.has(d.id)
                ? 3
                : scene.top.has(d.id)
                  ? 4
                  : 5;
      items.sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i);
      const pad = 1.5 * s;
      const boxes = [];
      for (const n of nodes)
        if (n.role === 'group') boxes.push({ x0: n.x - n.r, x1: n.x + n.r, y0: n.y - n.r, y1: n.y + n.r, id: n.id });
      const hits = (b, own) =>
        boxes.some((o) => o.id !== own && b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
      for (const it of items) {
        const { d } = it;
        const w = (d.w11 ?? labelWidth(d.short)) * s;
        let chosen = null;
        let box = null;
        for (const p of spots(d, s)) {
          const x0 = d.x + p.dx - (p.anchor === 'end' ? w : p.anchor === 'middle' ? w / 2 : 0);
          const y0 = d.y + p.dy - 0.95 * fs;
          const b = { x0: x0 - pad, x1: x0 + w + pad, y0: y0 - pad, y1: d.y + p.dy + 0.3 * fs + pad, id: d.id };
          if (d.role === 'more' || !hits(b, d.id)) {
            chosen = p;
            box = b;
            break;
          }
        }
        if (!chosen) {
          it.elmt.classList.add('crowded');
          continue;
        }
        boxes.push({ ...box, id: `label:${d.id}` });
        it.elmt.setAttribute('dx', String(chosen.dx));
        it.elmt.setAttribute('dy', String(chosen.dy));
        it.elmt.setAttribute('text-anchor', chosen.anchor);
      }
      root.dataset.crowded = String(label.filter('.crowded').size());
    }

    let placeFrame = 0;
    /** Places the labels again at the next frame, once however many zoom events come before it. */
    function placeSoon() {
      if (placeFrame) return;
      placeFrame = window.requestAnimationFrame(() => {
        placeFrame = 0;
        if (selections?.label === label) placeLabels();
      });
    }

    const neighbours = (id) => withNeighbours(new Set([id]), links);
    node.on('mouseover', function (event, d) {
      // A selection outlasts hover: the tooltip shows, the lighting stays the selection's.
      selections.hoverId = d.id;
      selections.hoverLit = neighbours(d.id);
      if (!selectedShown()) applySearch();
      root.dataset.hover = d.id;
      if (d.id !== state.selected) showNodeTooltip(event, d);
    });
    node.on('mousemove', (event) => {
      if (!tooltip.hidden) placeFloating(tooltip, event);
    });
    node.on('mouseout', () => {
      delete root.dataset.hover;
      hideTooltip();
      selections.hoverId = null;
      selections.hoverLit = null;
      // Back to the selection or the search rather than to full opacity.
      if (!selectedShown()) applySearch();
    });
    // One click selects a document (or opens a folder, or lists the "+N more"); two open it.
    node.on('click', (event, d) => {
      event.stopPropagation();
      if (event.defaultPrevented) return;
      hideTooltip();
      if (d.role === 'group') {
        state.expanded.add(d.key);
        void render();
      } else if (d.role === 'more') openMore(event, d);
      else select(d.id);
    });
    node.on('dblclick', (event, d) => {
      // Not the zoom's double-click zoom on the svg.
      event.stopPropagation();
      event.preventDefault();
      if (d.role !== 'doc') return;
      if (state.view === 'local' && d.id !== state.center) setCenter(d.id, { user: true });
      else onOpenDocument(d.id, {});
    });

    // The legend is appended to the svg, not the zoom group, so it stays put while zooming.
    const legendTypes = [
      ...bandsOf(
        nodes.filter((n) => n.role === 'doc'),
        data.profile.bands,
      ).keys(),
    ];
    if (legendTypes.length) {
      const legend = svg
        .append('g')
        .attr('class', 'legend')
        .attr('data-testid', 'graph-legend')
        // pointer-events none comes from the stylesheet: the page's CSP refuses style attributes.
        .attr('transform', `translate(20,${height - legendTypes.length * 22 - 30})`);
      legend
        .append('rect')
        .attr('class', 'legend-box')
        .attr('x', -10)
        .attr('y', -10)
        .attr('width', 160)
        .attr('height', legendTypes.length * 22 + 12)
        .attr('rx', 6);
      legendTypes.forEach((t, i) => {
        legend
          .append('circle')
          .attr('class', 'legend-dot')
          .attr('cx', 8)
          .attr('cy', i * 22 + 8)
          .attr('r', 5)
          .attr('fill', colors.get(t) || fallback);
        legend
          .append('text')
          .attr('class', 'legend-label')
          .attr('x', 20)
          .attr('y', i * 22 + 12)
          .attr('font-size', 12)
          .text(typeLabelOf(t));
      });
    }

    simulation.on('tick', () => {
      link
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);
      hit
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);
      node.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
      label.attr('x', (d) => d.x).attr('y', (d) => d.y);
      // While the layout moves, labels are placed again every few ticks; all of them at the end.
      if (++ticks % 4 === 0 && Number(root.dataset.labels || 0) <= 150) placeLabels();
    });
    let ticks = 0;

    /**
     * Fallback for the centering pull: should a node still rest past the edge of the panel (a
     * small window, long labels), the view zooms out just enough to show every node and its label
     * once the layout rests; it never zooms in and never overrides a zoom the user made. A label
     * that is hidden takes no room.
     */
    function fitIfOutside() {
      if (userZoomed || !nodes.length) return;
      const pad = 24;
      const shown = new Set(
        label
          .filter(':not(.off)')
          .data()
          .map((d) => d.id),
      );
      const right = (n) =>
        n.role === 'doc' && shown.has(n.id) ? n.x + n.r + 14 + Math.min(200, labelWidth(n.short)) : n.x + n.r;
      const x0 = Math.min(...nodes.map((n) => n.x - Math.max(14, n.r))) - pad;
      const x1 = Math.max(...nodes.map((n) => Math.max(right(n), n.x + 14))) + pad;
      const y0 = Math.min(...nodes.map((n) => n.y - Math.max(14, n.r))) - pad;
      const y1 = Math.max(...nodes.map((n) => n.y + Math.max(14, n.r) + (n.role === 'group' ? 18 : 0))) + pad;
      // A large drawing also keeps clear of the tools and the bar over its top edge.
      const top = scaleLabels ? TOOLS_HEIGHT : 0;
      if (x0 >= 0 && y0 >= top && x1 <= width && y1 <= height) return;
      const [minK] = zoom.scaleExtent();
      const k = Math.max(minK, Math.min(1, width / (x1 - x0), (height - top) / (y1 - y0)));
      const tx = (width - k * (x0 + x1)) / 2;
      const ty = top + (height - top - k * (y0 + y1)) / 2;
      svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
    }

    // For tests and screenshots: the layout has come to rest, and how long it took from the draw.
    root.dataset.settled = 'false';
    simulation.on('end', () => {
      fitIfOutside();
      placeLabels();
      if (state.view === 'folders') folderPositions = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
      root.dataset.settleMs = String(Math.round(window.performance.now() - t0));
      root.dataset.settled = 'true';
    });

    selections = {
      node,
      label,
      link,
      hit,
      scene,
      hoverId: null,
      hoverLit: null,
      searchLit: null,
      selLit: null,
      placeLabels,
    };
    if (scaleLabels) sizeLabels();
    renderCard();
    state.rendered++;
    root.dataset.layout = state.layout;
    root.dataset.rendered = String(state.rendered);
    renderBar();
    applySearch();
  }

  async function reload() {
    try {
      state.data = await getData();
    } catch (e) {
      state.data = null;
      showEmpty(`The graph could not be read: ${e.message}`);
      return;
    }
    await render();
  }

  function place() {
    return { view: state.view, center: state.center, secondHop: state.secondHop };
  }

  /** Local's centre; user marks a move the page history should hear about. */
  function setCenter(id, { user = false } = {}) {
    state.view = 'local';
    state.center = id;
    state.selected = null;
    renderCard();
    if (user) onPlace(place());
    void render();
  }

  function setView(name, { user = false } = {}) {
    state.view = VIEWS.includes(name) ? name : 'all';
    if (user) onPlace(place());
    void render();
  }

  function setLayout(name) {
    state.layout = name === 'layered' ? 'layered' : 'organic';
    for (const b of root.querySelectorAll('.graph-layout button'))
      b.setAttribute('aria-pressed', String(b.dataset.layout === state.layout));
    void render();
  }

  for (const b of root.querySelectorAll('.graph-layout button'))
    b.addEventListener('click', () => setLayout(b.dataset.layout));
  for (const b of root.querySelectorAll('.graph-views button'))
    b.addEventListener('click', () => setView(b.dataset.view, { user: true }));
  searchInput.addEventListener('input', (e) => {
    state.query = e.target.value;
    renderResults();
    applySearch();
  });
  searchInput.addEventListener('focus', renderResults);
  searchInput.addEventListener('blur', closeResults);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = results.querySelector('[data-testid="graph-result"]');
      if (first && !results.hidden) {
        e.preventDefault();
        choose(first.dataset.id);
      }
    } else if (e.key === 'Escape') closeResults();
  });
  // A click on empty space (nodes and edges stop their own clicks) or Esc clears the selection.
  svgEl.addEventListener('click', () => {
    closeChooser();
    clearSelection();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !state.visible) return;
    closeChooser();
    clearSelection();
  });

  // A new size draws again, with the bands from the new height.
  let resizeTimer = null;
  const observer = new window.ResizeObserver(() => {
    if (!state.visible) return;
    const w = svgEl.clientWidth;
    const h = svgEl.clientHeight;
    if (!w || !h || (w === state.width && h === state.height)) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => void render(), 150);
  });
  observer.observe(root);

  return {
    state,
    async show() {
      state.visible = true;
      await reload();
    },
    hide() {
      if (!state.visible) return;
      state.visible = false;
      clearTimeout(resizeTimer);
      teardown();
      hideTooltip();
      closeChooser();
      closeResults();
    },
    reload,
    setLayout,
    setView: (name) => setView(name),
    /** Show in graph: Local, centred on the document; drawn when the page is next shown. */
    showDocument(id) {
      state.view = 'local';
      state.center = id;
    },
    place,
    /** Back to a place from the page history, without telling onPlace. */
    setPlace(p) {
      if (!p) return;
      if (VIEWS.includes(p.view)) state.view = p.view;
      state.center = p.center ?? null;
      state.secondHop = !!p.secondHop;
    },
    search(query) {
      searchInput.value = query;
      state.query = query;
      applySearch();
    },
    /** The graph changed (files, a type, the profile): redraw only when it is on screen. */
    async refresh() {
      if (state.visible) await reload();
    },
    /** Summaries changed: new tooltips and pending marks, without moving any node. */
    updateSummaries(summaries) {
      if (!state.data) return;
      state.data.summaries = summaries;
      selections?.node.classed('pending', (d) => d.role === 'doc' && !!summaryLine(d)?.pending);
    },
  };
}
