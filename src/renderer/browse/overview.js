// Overview page of the Browse view (docs/graph.md): the library's documents as a graph, ported from
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
 * A weak pull of every node toward the middle. forceCenter only moves the whole graph's centre of
 * mass, so a document without links was pushed off screen by the charge; with this pull it rests at
 * the outer edge of the cluster. Weak enough that linked documents keep the original shape.
 */
export const CENTERING = 0.04;
const OPACITY = { link: 0.6, linkLit: 0.8, linkFaded: 0.05, faded: 0.1, searchFaded: 0.05, searchLinkFaded: 0.02 };

/** Node radius from its link count, as in the original: count * 1.2 + 4, clamped 5 to 14. */
export function nodeRadius(count) {
  return Math.max(5, Math.min(14, count * 1.2 + 4));
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * Mounts the overview into root. getData() resolves to the bridge's overview (nodes, edges,
 * profile, summaries) or null; onOpenDocument(id, target) and onOpenHeading(key) open the other
 * Browse pages. Returns { show(), hide(), reload(), setLayout(name), search(query), state }.
 */
export function createOverview(root, { getData, onOpenDocument, onOpenHeading }) {
  root.classList.add('overview');
  root.innerHTML = `
    <div class="overview-tools">
      <label class="visually-hidden" for="overview-search">Search documents</label>
      <input id="overview-search" type="search" data-testid="overview-search" placeholder="Search documents..." spellcheck="false" />
      <div class="overview-layout" role="group" aria-label="Layout">
        <button type="button" data-layout="organic" data-testid="overview-organic" aria-pressed="true">Organic</button>
        <button type="button" data-layout="layered" data-testid="overview-layered" aria-pressed="false">Layered</button>
      </div>
    </div>
    <svg class="overview-svg" data-testid="overview-svg" role="img" aria-label="Documents and how they connect"></svg>
    <div class="overview-tooltip" data-testid="overview-tooltip" role="tooltip" hidden></div>
    <div class="overview-chooser" data-testid="overview-chooser" hidden></div>
    <p class="browse-empty overview-empty" data-testid="overview-empty" hidden></p>`;
  const q = (id) => root.querySelector(`[data-testid="${id}"]`);
  const svgEl = q('overview-svg');
  const tooltip = q('overview-tooltip');
  const chooser = q('overview-chooser');
  const state = {
    data: null,
    layout: 'organic',
    query: '',
    simulation: null,
    visible: false,
    rendered: 0,
    width: 0,
    height: 0,
  };
  let selections = null;

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
    q('overview-empty').textContent = text;
    q('overview-empty').hidden = !text;
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

  function showNodeTooltip(event, d, typeLabel) {
    tooltip.replaceChildren();
    tooltip.append(el('strong', 'tip-title', d.title));
    const meta = [typeLabel, d.sectionCount === 1 ? '1 section' : `${d.sectionCount} sections`];
    if (d.date) meta.push(d.date.value);
    tooltip.append(el('span', 'tip-meta', meta.join(' · ')));
    const s = summaryLine(d);
    if (s) {
      const p = el('span', `tip-summary${s.pending ? ' pending' : ''}`, s.text);
      p.dataset.testid = 'overview-tooltip-summary';
      tooltip.append(p);
    }
    tooltip.hidden = false;
    placeFloating(tooltip, event);
  }

  function showEdgeTooltip(event, e) {
    tooltip.replaceChildren();
    tooltip.append(el('strong', 'tip-title', `${EDGE_LABEL[e.kind] || e.kind}${e.weight > 1 ? `: ${e.weight}` : ''}`));
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
    tooltip.hidden = false;
    placeFloating(tooltip, event);
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
        b.dataset.testid = 'overview-chooser-heading';
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

  /** filterGraph, selecting by class so the legend is never touched. */
  function applySearch() {
    if (!selections || !state.data) return;
    const { node, label, link, hit } = selections;
    const query = state.query.toLowerCase().trim();
    if (!query) {
      node.attr('opacity', 1);
      label.attr('opacity', 1);
      link.attr('stroke-opacity', OPACITY.link);
      hit.classed('dim', false);
      root.dataset.searching = 'false';
      return;
    }
    const matched = new Set();
    for (const n of state.data.nodes)
      if (n.title.toLowerCase().includes(query) || n.relPath.toLowerCase().includes(query)) matched.add(n.id);
    const connected = new Set(matched);
    for (const e of state.data.edges) {
      if (matched.has(idOf(e.source))) connected.add(idOf(e.target));
      if (matched.has(idOf(e.target))) connected.add(idOf(e.source));
    }
    node
      .attr('opacity', (d) => (connected.has(d.id) ? 1 : OPACITY.searchFaded))
      .classed('match', (d) => matched.has(d.id));
    label.attr('opacity', (d) => (connected.has(d.id) ? 1 : OPACITY.searchFaded));
    link.attr('stroke-opacity', (e) =>
      connected.has(idOf(e.source)) && connected.has(idOf(e.target)) ? OPACITY.linkLit : OPACITY.searchLinkFaded,
    );
    root.dataset.searching = 'true';
  }

  async function render() {
    if (!state.visible) return;
    const data = state.data;
    // Taken before the awaits, so the size observer sees this draw's size and does not draw again.
    state.width = svgEl.clientWidth || root.clientWidth || 800;
    state.height = svgEl.clientHeight || root.clientHeight || 600;
    stopSimulation();
    hideTooltip();
    closeChooser();
    let d3;
    try {
      d3 = await loadD3();
    } catch (e) {
      showEmpty(`The overview could not be drawn: ${e.message}`);
      return;
    }
    // The page may have been left while d3 loaded.
    if (!state.visible) return;
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    selections = null;
    if (!data || !data.nodes.length) {
      showEmpty(
        data
          ? 'No documents yet. They appear here once they are indexed.'
          : 'The overview is available in the AskFiles app.',
      );
      return;
    }
    showEmpty('');
    const width = state.width;
    const height = state.height;
    svg.attr('viewBox', [0, 0, width, height]);

    const colors = new Map(data.profile.types.map((t) => [t.name, t.color]));
    const labels = new Map(data.profile.types.map((t) => [t.name, t.label]));
    const fallback = '#8a8f9e';
    // Deep copy: d3 mutates nodes and edges (as loadGraph did).
    const nodes = data.nodes.map((n) => ({ ...n }));
    const edges = data.edges.map((e) => ({ ...e }));
    const linkCount = {};
    for (const e of edges) {
      linkCount[e.source] = (linkCount[e.source] || 0) + 1;
      linkCount[e.target] = (linkCount[e.target] || 0) + 1;
    }
    const bands = bandsOf(nodes, data.profile.bands);
    const layered = state.layout === 'layered';
    // Seeded positions from the main process, so the graph opens in the same place every time.
    for (const n of nodes) {
      const p = layered ? n.positions.layered : n.positions.organic;
      n.x = width / 2 + p.x * width * (layered ? 0.45 : 0.35);
      n.y = layered ? bandY(bands.get(n.type), bands.size, height) + p.y * 20 : height / 2 + p.y * height * 0.35;
    }

    const g = svg.append('g').attr('class', 'zoom-layer');
    let userZoomed = false;
    const zoom = d3
      .zoom()
      .scaleExtent([0.2, 5])
      .on('zoom', (event) => {
        // A zoom from the wheel, a drag or a pinch has a source event; the fit below has none.
        if (event.sourceEvent) userZoomed = true;
        g.attr('transform', event.transform);
      });
    svg.call(zoom);

    const simulation = d3
      .forceSimulation(nodes)
      .force(
        'link',
        d3
          .forceLink(edges)
          .id((d) => d.id)
          .distance(FORCES.linkDistance),
      )
      .force('charge', d3.forceManyBody().strength(FORCES.charge))
      .force('collision', d3.forceCollide().radius(FORCES.collide));
    if (layered) {
      simulation
        .force('centerX', d3.forceX(width / 2).strength(CENTERING))
        .force('band', d3.forceY((d) => bandY(bands.get(d.type), bands.size, height)).strength(0.4));
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
      .data(edges)
      .join('line')
      .attr('class', (e) => `link kind-${e.kind}`)
      .attr('data-kind', (e) => e.kind)
      .attr('stroke-width', (e) => Math.min(4, 1 + Math.log2(e.weight || 1) * 0.5))
      .attr('stroke-opacity', OPACITY.link);
    // Wide invisible lines over the edges, so a thin edge can still be clicked.
    const hit = g
      .append('g')
      .attr('class', 'link-hits')
      .selectAll('line.link-hit')
      .data(edges)
      .join('line')
      .attr('class', 'link-hit')
      .attr('data-testid', 'overview-edge')
      .attr('data-kind', (e) => e.kind)
      .attr('data-source', (e) => idOf(e.source))
      .attr('data-target', (e) => idOf(e.target))
      .on('mouseover', (event, e) => showEdgeTooltip(event, e))
      .on('mouseout', hideTooltip)
      .on('click', (event, e) => {
        event.stopPropagation();
        openEdge(event, e);
      });

    const node = g
      .append('g')
      .attr('class', 'nodes')
      .selectAll('circle.node')
      .data(nodes)
      .join('circle')
      .attr('class', (d) => `node${summaryLine(d)?.pending ? ' pending' : ''}`)
      .attr('data-testid', 'overview-node')
      .attr('data-id', (d) => d.id)
      .attr('data-type', (d) => d.type)
      .attr('r', (d) => nodeRadius(linkCount[d.id] || 0))
      .attr('fill', (d) => colors.get(d.type) || fallback)
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
      .attr('class', 'label')
      .text((d) => d.title)
      .attr('font-size', 11)
      .attr('dx', (d) => labelOffset(linkCount[d.id] || 0))
      .attr('dy', 4);

    node.on('mouseover', function (event, d) {
      const connected = new Set([d.id]);
      for (const e of edges) {
        if (idOf(e.source) === d.id) connected.add(idOf(e.target));
        if (idOf(e.target) === d.id) connected.add(idOf(e.source));
      }
      node.attr('opacity', (n) => (connected.has(n.id) ? 1 : OPACITY.faded));
      link.attr('stroke-opacity', (e) =>
        idOf(e.source) === d.id || idOf(e.target) === d.id ? OPACITY.linkLit : OPACITY.linkFaded,
      );
      label.attr('opacity', (n) => (connected.has(n.id) ? 1 : OPACITY.faded));
      root.dataset.hover = d.id;
      showNodeTooltip(event, d, labels.get(d.type) || d.type);
    });
    node.on('mousemove', (event) => placeFloating(tooltip, event));
    node.on('mouseout', () => {
      delete root.dataset.hover;
      hideTooltip();
      // Back to the search state rather than to full opacity, so hover never clears a search.
      if (state.query.trim()) applySearch();
      else {
        node.attr('opacity', 1);
        link.attr('stroke-opacity', OPACITY.link);
        label.attr('opacity', 1);
      }
    });
    node.on('click', (event, d) => {
      if (event.defaultPrevented) return;
      hideTooltip();
      onOpenDocument(d.id, {});
    });

    // The legend is appended to the svg, not the zoom group, so it stays put while zooming.
    const legendTypes = [...bands.keys()];
    const legend = svg
      .append('g')
      .attr('class', 'legend')
      .attr('data-testid', 'overview-legend')
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
        .text(labels.get(t) || t);
    });

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
    });

    /**
     * Fallback for the centering pull: should a node still rest past the edge of the panel (a
     * small window, long labels), the view zooms out just enough to show every node and its label
     * once the layout rests; it never zooms in and never overrides a zoom the user made.
     */
    function fitIfOutside() {
      if (userZoomed || !nodes.length) return;
      const pad = 24;
      const x0 = Math.min(...nodes.map((n) => n.x - 14)) - pad;
      const x1 = Math.max(...nodes.map((n) => n.x + 14 + Math.min(200, n.title.length * 6.5))) + pad;
      const y0 = Math.min(...nodes.map((n) => n.y - 14)) - pad;
      const y1 = Math.max(...nodes.map((n) => n.y + 14)) + pad;
      if (x0 >= 0 && y0 >= 0 && x1 <= width && y1 <= height) return;
      const k = Math.max(0.2, Math.min(1, width / (x1 - x0), height / (y1 - y0)));
      const tx = (width - k * (x0 + x1)) / 2;
      const ty = (height - k * (y0 + y1)) / 2;
      svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
    }

    // For tests and screenshots: the layout has come to rest.
    root.dataset.settled = 'false';
    simulation.on('end', () => {
      fitIfOutside();
      root.dataset.settled = 'true';
    });

    selections = { node, label, link, hit };
    state.rendered++;
    root.dataset.layout = state.layout;
    root.dataset.rendered = String(state.rendered);
    applySearch();
  }

  async function reload() {
    try {
      state.data = await getData();
    } catch (e) {
      state.data = null;
      showEmpty(`The overview could not be read: ${e.message}`);
      return;
    }
    await render();
  }

  function setLayout(name) {
    state.layout = name === 'layered' ? 'layered' : 'organic';
    for (const b of root.querySelectorAll('.overview-layout button'))
      b.setAttribute('aria-pressed', String(b.dataset.layout === state.layout));
    void render();
  }

  for (const b of root.querySelectorAll('.overview-layout button'))
    b.addEventListener('click', () => setLayout(b.dataset.layout));
  q('overview-search').addEventListener('input', (e) => {
    state.query = e.target.value;
    applySearch();
  });
  svgEl.addEventListener('click', closeChooser);

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
    },
    reload,
    setLayout,
    search(query) {
      q('overview-search').value = query;
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
      selections?.node.classed('pending', (d) => !!summaryLine(d)?.pending);
    },
  };
}
