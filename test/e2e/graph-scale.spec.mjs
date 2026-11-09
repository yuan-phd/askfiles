// The graph of a large library (docs/graph.md, Large libraries): the Local, Folders and All views,
// recentring, search, "+N more", Show in graph from the Document page and the Library, on graphs
// built by the real graph code (dist/main/graph) from invented libraries only (CLAUDE.md rule 10):
// the 900-document water cooperative of test/fixtures/make-graph-library.mjs, and a small hub
// library made here. Also measures build and settle times and takes the screenshots of each view
// (docs/screenshots/graph).
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test, expect } from '@playwright/test';
import { documentId } from '../../dist/main/browse/build.js';
import { normalizeHeading } from '../../dist/main/browse/normalize.js';
import { buildGraph, loadProfiles, profileFor } from '../../dist/main/graph/index.js';
import { inventLibrary } from '../fixtures/make-graph-library.mjs';
import { stubBrowseBridge } from './browse-seed.mjs';

const PROFILES = path.resolve(import.meta.dirname, '../../config/profiles');
const SHOTS = path.resolve(import.meta.dirname, '../../docs/screenshots/graph');
const profile = () => profileFor(loadProfiles(PROFILES), 'legal-finance');
const browseUrl = () => `${process.env.ASKFILES_PAGE_URL}/browse/index.html`;
const SETTLE = { timeout: 30_000 };

/** The browse index calls the page makes, over documents held in memory. */
function memoryIndex(docs) {
  return {
    listDocuments: () =>
      docs.map((d) => {
        const rest = { ...d, sectionCount: d.sections.length };
        for (const k of ['version', 'sections', 'hash', 'splitKey']) delete rest[k];
        return rest;
      }),
    getDocument: (ref) => docs.find((d) => d.id === ref.id) ?? null,
    headings: () => [],
    search: () => ({ results: [], total: 0 }),
  };
}

/** A small library: a hub and 39 notes that all share two headings with it and each other. */
function hubLibrary() {
  const mk = (title, extra) => {
    const p = `/invented/Hub Library/${title}`;
    const heads = ['Shared Opening', 'Shared Closing', extra];
    const sections = heads.map((h, i) => ({
      index: i + 1,
      title: h,
      level: 1,
      lead: [],
      heading: normalizeHeading(h),
      path: [h],
      pageStart: null,
      pageEnd: null,
      pageLabelStart: null,
      pageLabelEnd: null,
      text: 'Invented text for the hub library test.',
      parts: ['Invented text for the hub library test.'],
    }));
    return {
      version: 3,
      id: documentId(p),
      path: p,
      url: `file://${encodeURI(p)}`,
      relPath: `Hub Library/${title}`,
      title,
      size: 100,
      mtimeMs: Date.parse('2026-01-01T00:00:00Z'),
      hash: `h-${title}`,
      splitKey: 'k',
      indexedAt: '2026-01-01T00:00:00Z',
      outline: [],
      sections,
    };
  };
  return [
    mk('Hub Overview.md', 'Hub Only'),
    ...Array.from({ length: 39 }, (_, i) => mk(`Note ${String(i + 1).padStart(2, '0')}.md`, `Own ${i}`)),
  ];
}

let large;
let small;
const timings = {};

test.beforeAll(() => {
  const docs = inventLibrary({ normalizeHeading, documentId });
  const runs = [];
  let graph;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    graph = buildGraph(docs, { profile: profile() });
    runs.push(performance.now() - t);
  }
  timings.buildMs = runs.map(Math.round);
  large = { docs, data: { ...graph, libraryId: 'invented-900', summaries: {} } };
  const hub = hubLibrary();
  small = { docs: hub, data: { ...buildGraph(hub, { profile: profile() }), libraryId: 'invented-hub', summaries: {} } };
});

test.afterAll(() => {
  if (Object.keys(timings).length > 1) console.log(`[graph-scale] timings ${JSON.stringify(timings)}`);
});

async function stubGraph(page, data) {
  await page.addInitScript((data) => {
    window.askfiles = {
      ...(window.askfiles || {}),
      graph: {
        data: async () => data,
        onChange: () => () => {},
        profiles: async () => [{ id: 'legal-finance', name: 'Legal and finance', description: '' }],
        setType: async () => data,
        answerFamily: async () => data,
      },
    };
  }, data);
}

async function openLibrary(page, lib) {
  await stubBrowseBridge(page, memoryIndex(lib.docs));
  await stubGraph(page, lib.data);
  await page.goto(browseUrl());
  await expect(page.getByTestId('library-item')).toHaveCount(lib.docs.length, { timeout: 20_000 });
}

async function openGraph(page, lib) {
  await openLibrary(page, lib);
  await page.getByTestId('browse-tab-graph').click();
}

const root = (page) => page.getByTestId('graph-root');
const settled = (page) => expect(root(page)).toHaveAttribute('data-settled', 'true', SETTLE);
const byName = (lib, name) => lib.data.nodes.find((n) => n.displayName === name);
const neighboursOf = (lib, id) =>
  new Set(lib.data.edges.flatMap((e) => (e.source === id ? [e.target] : e.target === id ? [e.source] : [])));
/** The best-linked document of the large library, so Local has five neighbours to show. */
function hubOf(lib) {
  const degree = new Map();
  for (const e of lib.data.edges) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  return lib.data.nodes
    .filter((n) => degree.get(n.id) === 5)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))[0];
}

/** Pairs of labels on screen whose boxes overlap (more than half a pixel), as [id, id]. */
function overlaps(page) {
  return page.evaluate(() => {
    const boxes = [...document.querySelectorAll('[data-testid="graph-label"]')]
      .filter((t) => window.getComputedStyle(t).display !== 'none')
      .map((t) => ({ id: t.dataset.id, r: t.getBoundingClientRect() }))
      .filter((b) => b.r.width > 0);
    const out = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r;
        const b = boxes[j].r;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 0.5 && h > 0.5) out.push([boxes[i].id, boxes[j].id]);
      }
    return out;
  });
}

/** Labels are placed again a frame after a zoom; waits two frames. */
async function settledLabels(page) {
  await page.evaluate(() => new Promise((r) => window.requestAnimationFrame(() => window.requestAnimationFrame(r))));
}

const opacityOf = (page, id) => page.locator(`[data-testid="graph-node"][data-id="${id}"]`).getAttribute('opacity');

/** Zooms in with the wheel over the middle of the graph until the zoom passes k. */
async function zoomPast(page, k) {
  const box = await page.getByTestId('graph-svg').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) {
    const z = Number(await root(page).getAttribute('data-zoom'));
    if (z >= k) return z;
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(60);
  }
  return Number(await root(page).getAttribute('data-zoom'));
}

test.describe('large library graph', () => {
  test('opens on Folders; Local asks for a document, choosing a result centres on it; a double click recentres', async ({
    page,
  }) => {
    await openGraph(page, large);
    // More than 50 documents: Folders first; the other views stay a click away.
    await expect(root(page)).toHaveAttribute('data-view', 'folders');
    await expect(page.getByTestId('graph-view-folders')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('graph-group')).toHaveCount(16);
    await page.getByTestId('graph-view-local').click();
    await expect(root(page)).toHaveAttribute('data-view', 'local');
    await expect(page.getByTestId('graph-view-local')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('graph-pick')).toBeVisible();
    await expect(page.getByTestId('graph-node')).toHaveCount(0);

    const hub = hubOf(large);
    await page.getByTestId('graph-search').fill(hub.displayName);
    await expect(page.getByTestId('graph-results')).toBeVisible();
    await page.locator(`[data-testid="graph-result"][data-id="${hub.id}"]`).click();
    await expect(root(page)).toHaveAttribute('data-center', hub.id);
    await settled(page);
    timings.localSettleMs = Number(await root(page).getAttribute('data-settle-ms'));
    await expect(page.getByTestId('graph-center')).toHaveText(hub.displayName);
    const near = neighboursOf(large, hub.id);
    await expect(page.getByTestId('graph-node')).toHaveCount(1 + near.size);
    // Every label shows in Local.
    await expect(page.locator('[data-testid="graph-label"]:not(.off)')).toHaveCount(1 + near.size);

    // Second step: what the neighbours link to as well.
    await page.getByTestId('graph-second-hop').check();
    await settled(page);
    expect(await page.getByTestId('graph-node').count()).toBeGreaterThan(1 + near.size);
    expect(await page.locator('[data-testid="graph-node"][data-hop="2"]').count()).toBeGreaterThan(0);
    await page.getByTestId('graph-second-hop').uncheck();
    await settled(page);

    // A double click on a neighbour recentres on it.
    const next = [...near].sort()[0];
    await page.locator(`[data-testid="graph-node"][data-id="${next}"]`).dblclick({ force: true });
    await expect(root(page)).toHaveAttribute('data-center', next);
    await settled(page);
    await expect(page.locator(`[data-testid="graph-node"][data-id="${hub.id}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-testid="graph-node"][data-id="${next}"]`)).toHaveClass(/center/);

    // Open document goes to the Document page; Back returns to Local on the same centre.
    await page.getByTestId('graph-open-center').click();
    await expect(page.getByTestId('document')).toBeVisible();
    await page.getByTestId('browse-back').click();
    await expect(root(page)).toHaveAttribute('data-center', next);
    await expect(root(page)).toHaveAttribute('data-view', 'local');
  });

  test('Folders: one node per first-level subfolder; a folder opens in place, its links go to folders still closed', async ({
    page,
  }) => {
    await openGraph(page, large);
    await page.getByTestId('graph-view-folders').click();
    await settled(page);
    timings.foldersSettleMs = Number(await root(page).getAttribute('data-settle-ms'));
    // Ten departments and four projects, the files at the top of the linked folder, the added files.
    await expect(page.getByTestId('graph-group')).toHaveCount(16);
    await expect(page.getByTestId('graph-node')).toHaveCount(0);
    const keyOf = (rel) => {
      const p = rel.split('/');
      return p.length === 1 ? 'added:' : p.length === 2 ? `top:${p[0]}` : `sub:${p[0]}/${p[1]}`;
    };
    const count = (key) => large.data.nodes.filter((n) => keyOf(n.relPath) === key).length;
    const ops = page.locator('[data-testid="graph-group"][data-key="sub:Cooperative Records/Operations"]');
    await expect(ops).toHaveAttribute('data-count', String(count('sub:Cooperative Records/Operations')));
    // Bigger folders draw bigger.
    const r = async (key) =>
      Number(await page.locator(`[data-testid="graph-group"][data-key="${key}"]`).getAttribute('r'));
    expect(await r('sub:Cooperative Records/Operations')).toBeGreaterThan(await r('added:'));
    // Thickness by the links between the folders.
    const counts = await page.$$eval('[data-testid="graph-group-link"]', (els) =>
      els.map((e) => Number(e.dataset.count)),
    );
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(counts.length);

    await ops.click({ force: true });
    await settled(page);
    const opsDocs = large.data.nodes.filter((n) => keyOf(n.relPath) === 'sub:Cooperative Records/Operations');
    await expect(page.getByTestId('graph-node')).toHaveCount(opsDocs.length);
    await expect(page.getByTestId('graph-group')).toHaveCount(15);
    await expect(page.getByTestId('graph-collapse')).toHaveText(['Operations ×']);
    // A link from an Operations document to a document in a closed folder ends at that folder.
    const opsIds = new Set(opsDocs.map((n) => n.id));
    const cross = large.data.edges.find((e) => opsIds.has(e.source) !== opsIds.has(e.target));
    expect(cross, 'Operations links to another folder').toBeTruthy();
    const inside = opsIds.has(cross.source) ? cross.source : cross.target;
    const outside = inside === cross.source ? cross.target : cross.source;
    const outsideKey = keyOf(large.data.nodes.find((n) => n.id === outside).relPath);
    const ends = (a, b) => page.locator(`.link-hit[data-source="${a < b ? a : b}"][data-target="${a < b ? b : a}"]`);
    await expect(ends(inside, `group:${outsideKey}`)).toHaveCount(1);

    // Opening that folder too turns it into a link between the two documents.
    await page.locator(`[data-testid="graph-group"][data-key="${outsideKey}"]`).click({ force: true });
    await settled(page);
    await expect(ends(inside, outside).first()).toHaveAttribute('data-testid', 'graph-edge');
    await expect(ends(inside, `group:${outsideKey}`)).toHaveCount(0);

    // Closing a folder from its chip.
    await page.locator(`[data-testid="graph-collapse"][data-key="${outsideKey}"]`).click();
    await settled(page);
    await expect(page.getByTestId('graph-collapse')).toHaveCount(1);
  });

  test('All: every document, ten labels; hover, search and zooming in show more', async ({ page }) => {
    await openGraph(page, large);
    await page.getByTestId('graph-view-all').click();
    await expect(page.getByTestId('graph-node')).toHaveCount(900);
    await settled(page);
    timings.allSettleMs = Number(await root(page).getAttribute('data-settle-ms'));
    const shown = page.locator('[data-testid="graph-label"]:not(.off)');
    await expect(shown).toHaveCount(10);

    // Hover a document whose label is hidden: its label (and its neighbours') appear.
    const hiddenId = await page.locator('[data-testid="graph-label"].off').first().getAttribute('data-id');
    await page.locator(`[data-testid="graph-node"][data-id="${hiddenId}"]`).hover({ force: true });
    await expect(page.locator(`[data-testid="graph-label"][data-id="${hiddenId}"]`)).not.toHaveClass(/off/);
    await expect(page.getByTestId('graph-tooltip')).toBeVisible();
    await page.mouse.move(2, 2);
    await expect(page.locator(`[data-testid="graph-label"][data-id="${hiddenId}"]`)).toHaveClass(/off/);

    // Search: the matches and their neighbours light up and show their labels.
    const target = large.data.nodes.find((n) => n.id === hiddenId);
    await page.getByTestId('graph-search').fill(target.displayName);
    await expect(root(page)).toHaveAttribute('data-searching', 'true');
    const lit = new Set([...neighboursOf(large, hiddenId), hiddenId]);
    for (const id of lit)
      await expect(page.locator(`[data-testid="graph-label"][data-id="${id}"]`)).not.toHaveClass(/off/);
    await expect(page.locator(`[data-testid="graph-node"][data-id="${hiddenId}"]`)).toHaveClass(/match/);
    await page.getByTestId('graph-search').fill('');
    await expect(shown).toHaveCount(10);

    // Zoomed in past the set level, every label shows.
    expect(await zoomPast(page, 1.6)).toBeGreaterThanOrEqual(1.6);
    await expect(shown).toHaveCount(900);
    await settledLabels(page);
    expect(await overlaps(page)).toEqual([]);
  });

  test('labels use the display name, cut with an ellipsis, the full name on hover', async ({ page }) => {
    const long = large.data.nodes.find((n) => n.displayName.length > 60);
    expect(long, 'the invented library has a long name').toBeTruthy();
    await openLibrary(page, large);
    await page.locator(`[data-testid="library-item"][data-id="${long.id}"] [data-testid="library-show-graph"]`).click();
    await settled(page);
    const label = page.locator(`[data-testid="graph-label"][data-id="${long.id}"]`);
    const text = await label.textContent();
    expect(text.endsWith('…')).toBe(true);
    expect(long.displayName.startsWith(text.slice(0, -1))).toBe(true);
    await page.locator(`[data-testid="graph-node"][data-id="${long.id}"]`).hover({ force: true });
    await expect(page.getByTestId('graph-tooltip').locator('.tip-title')).toHaveText(long.displayName);
  });

  test('Show in graph on the Document page and on a Library row opens Local centred on the document', async ({
    page,
  }) => {
    await openLibrary(page, large);
    const pick = large.data.nodes[100];
    await page.locator(`[data-testid="library-item"][data-id="${pick.id}"] [data-testid="library-show-graph"]`).click();
    await expect(page.getByTestId('graph')).toBeVisible();
    await expect(root(page)).toHaveAttribute('data-view', 'local');
    await expect(root(page)).toHaveAttribute('data-center', pick.id);
    await settled(page);

    const other = large.data.nodes[400];
    await page.getByTestId('browse-tab-library').click();
    await page.locator(`[data-testid="library-item"][data-id="${other.id}"] [data-testid="library-open"]`).click();
    await expect(page.getByTestId('doc-title')).toHaveText(other.title);
    await page.getByTestId('doc-show-graph').click();
    await expect(root(page)).toHaveAttribute('data-center', other.id);
    await expect(page.getByTestId('graph-center')).toHaveText(other.displayName);
    // Back returns to the document.
    await page.getByTestId('browse-back').click();
    await expect(page.getByTestId('doc-title')).toHaveText(other.title);
  });
});

test.describe('selection', () => {
  test('a click selects a document: it and its links lit, the rest dimmed, its card pinned; Esc and empty space clear', async ({
    page,
  }) => {
    await openGraph(page, large);
    await page.getByTestId('graph-view-all').click();
    await settled(page);
    const hub = hubOf(large);
    const near = neighboursOf(large, hub.id);
    const far = large.data.nodes.find((n) => n.id !== hub.id && !near.has(n.id)).id;
    await page.locator(`[data-testid="graph-node"][data-id="${hub.id}"]`).click({ force: true });
    // Selecting does not leave the graph.
    await expect(page.getByTestId('graph')).toBeVisible();
    await expect(root(page)).toHaveAttribute('data-selected', hub.id);
    await expect(page.locator(`[data-testid="graph-node"][data-id="${hub.id}"]`)).toHaveClass(/selected/);
    expect(await opacityOf(page, hub.id)).toBe('1');
    for (const id of near) expect(await opacityOf(page, id)).toBe('1');
    expect(await opacityOf(page, far)).toBe('0.1');
    // Its links are lit, and only its links.
    expect(await page.locator('line.link.lit').count()).toBe(near.size);
    // The labels of the selected document and what it links to show.
    for (const id of [hub.id, ...near])
      await expect(page.locator(`[data-testid="graph-label"][data-id="${id}"]`)).not.toHaveClass(/off/);
    // The card is pinned: it stays where it is when the mouse moves on.
    const card = page.getByTestId('graph-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.tip-title')).toHaveText(hub.displayName);
    const at = await card.boundingBox();
    await page.locator(`[data-testid="graph-node"][data-id="${far}"]`).hover({ force: true });
    expect(await card.boundingBox()).toEqual(at);
    // Hover does not take the selection's lighting away.
    expect(await opacityOf(page, far)).toBe('0.1');
    await page.mouse.move(2, 2);

    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await expect(root(page)).not.toHaveAttribute('data-selected', /./);
    expect(await opacityOf(page, far)).toBe('1');

    await page.locator(`[data-testid="graph-node"][data-id="${hub.id}"]`).click({ force: true });
    await expect(card).toBeVisible();
    // Empty space: the bottom right corner of the graph.
    const box = await page.getByTestId('graph-svg').boundingBox();
    await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4);
    await expect(card).toBeHidden();
  });

  test('the card opens the document or shows it in Local; a double click opens the document', async ({ page }) => {
    await openGraph(page, large);
    await page.getByTestId('graph-view-all').click();
    await settled(page);
    const hub = hubOf(large);
    const nodeOf = (id) => page.locator(`[data-testid="graph-node"][data-id="${id}"]`);
    await nodeOf(hub.id).click({ force: true });
    await page.getByTestId('graph-card-local').click();
    await expect(root(page)).toHaveAttribute('data-view', 'local');
    await expect(root(page)).toHaveAttribute('data-center', hub.id);
    await settled(page);

    await page.getByTestId('graph-view-all').click();
    await settled(page);
    await nodeOf(hub.id).click({ force: true });
    await page.getByTestId('graph-card-open').click();
    await expect(page.getByTestId('doc-title')).toHaveText(hub.title);

    await page.getByTestId('browse-tab-graph').click();
    await settled(page);
    await nodeOf(hub.id).dblclick({ force: true });
    await expect(page.getByTestId('doc-title')).toHaveText(hub.title);
  });

  test('in Local a click selects; Show in Local or a double click recentres; a double click on the centre opens it; settles in about 2 s', async ({
    page,
  }) => {
    const hub = hubOf(large);
    await openLibrary(page, large);
    await page.locator(`[data-testid="library-item"][data-id="${hub.id}"] [data-testid="library-show-graph"]`).click();
    await settled(page);
    const ms = Number(await root(page).getAttribute('data-settle-ms'));
    timings.localSettleMs = ms;
    expect(ms, 'Local settles within about 2 s').toBeLessThan(2500);
    const [a, b] = [...neighboursOf(large, hub.id)].sort();
    const nodeOf = (id) => page.locator(`[data-testid="graph-node"][data-id="${id}"]`);

    await nodeOf(a).click({ force: true });
    await expect(root(page)).toHaveAttribute('data-center', hub.id);
    await expect(root(page)).toHaveAttribute('data-selected', a);
    await page.getByTestId('graph-card-local').click();
    await expect(root(page)).toHaveAttribute('data-center', a);
    await expect(page.getByTestId('graph-card')).toBeHidden();
    await settled(page);

    await nodeOf(hub.id).dblclick({ force: true });
    await expect(root(page)).toHaveAttribute('data-center', hub.id);
    await settled(page);
    await nodeOf(b).dblclick({ force: true });
    await expect(root(page)).toHaveAttribute('data-center', b);
    await settled(page);
    await nodeOf(b).dblclick({ force: true });
    await expect(page.getByTestId('doc-title')).toHaveText(large.data.nodes.find((n) => n.id === b).title);
  });

  test('Folders: with a document selected, opening a folder lights only its documents linked to it', async ({
    page,
  }) => {
    await openGraph(page, large);
    await page.getByTestId('graph-view-folders').click();
    await settled(page);
    const keyOf = (rel) => {
      const p = rel.split('/');
      return p.length === 1 ? 'added:' : p.length === 2 ? `top:${p[0]}` : `sub:${p[0]}/${p[1]}`;
    };
    const groupOf = new Map(large.data.nodes.map((n) => [n.id, keyOf(n.relPath)]));
    // A document with a link into another folder.
    const cross = large.data.edges.find((e) => groupOf.get(e.source) !== groupOf.get(e.target));
    const [x, y] = [cross.source, cross.target];
    const other = groupOf.get(y);
    await page.locator(`[data-testid="graph-group"][data-key="${groupOf.get(x)}"]`).click({ force: true });
    await settled(page);
    await page.locator(`[data-testid="graph-node"][data-id="${x}"]`).click({ force: true });
    await expect(root(page)).toHaveAttribute('data-selected', x);
    // Before: the link ends at the folder.
    const hitBetween = (a, b) =>
      page.locator(`.link-hit[data-source="${a < b ? a : b}"][data-target="${a < b ? b : a}"]`);
    await expect(hitBetween(x, `group:${other}`)).toHaveCount(1);

    await page.locator(`[data-testid="graph-group"][data-key="${other}"]`).click({ force: true });
    await settled(page);
    await expect(root(page)).toHaveAttribute('data-selected', x);
    await expect(page.getByTestId('graph-card')).toBeVisible();
    const inOther = large.data.nodes.filter((n) => groupOf.get(n.id) === other).map((n) => n.id);
    const linked = new Set(
      large.data.edges.flatMap((e) => (e.source === x ? [e.target] : e.target === x ? [e.source] : [])),
    );
    const opacities = await page.$$eval(
      '[data-testid="graph-node"]',
      (els, ids) => els.filter((e) => ids.includes(e.dataset.id)).map((e) => [e.dataset.id, e.getAttribute('opacity')]),
      inOther,
    );
    expect(opacities).toHaveLength(inOther.length);
    for (const [id, o] of opacities) expect(o, id).toBe(linked.has(id) ? '1' : '0.1');
    expect(opacities.filter(([, o]) => o === '0.1').length).toBeGreaterThan(0);
    // After: the selected document's links run to those documents, not to the folder.
    await expect(hitBetween(x, `group:${other}`)).toHaveCount(0);
    await expect(hitBetween(x, y).first()).toHaveAttribute('data-testid', 'graph-edge');
    expect(await page.locator('line.link.lit').count()).toBeGreaterThan(0);
  });

  test('labels never run into each other: a dense small library', async ({ page }) => {
    // 40 documents all linked to each other, every label shown.
    await openGraph(page, small);
    await settled(page);
    expect(await overlaps(page)).toEqual([]);
    expect(Number(await root(page).getAttribute('data-labels'))).toBeGreaterThan(10);
  });

  test('labels never run into each other: Folders with an open folder and a selection', async ({ page }) => {
    await openGraph(page, large);
    await page.getByTestId('graph-view-folders').click();
    await settled(page);
    expect(await overlaps(page)).toEqual([]);
    await page
      .locator('[data-testid="graph-group"][data-key="sub:Cooperative Records/Governance"]')
      .click({ force: true });
    await settled(page);
    expect(await overlaps(page)).toEqual([]);
    // Every folder label still shows next to the documents' labels.
    expect(await page.locator('[data-testid="graph-label"].role-group.crowded').count()).toBe(0);
    const doc = await page.locator('[data-testid="graph-node"]').first().getAttribute('data-id');
    await page.locator(`[data-testid="graph-node"][data-id="${doc}"]`).click({ force: true });
    await settledLabels(page);
    expect(await overlaps(page)).toEqual([]);
    await expect(page.locator(`[data-testid="graph-label"][data-id="${doc}"]`)).not.toHaveClass(/off|crowded/);
  });
});

test.describe('small library graph', () => {
  test('opens on All with every label and can switch to Local', async ({ page }) => {
    await openGraph(page, small);
    await expect(root(page)).toHaveAttribute('data-view', 'all');
    await expect(page.getByTestId('graph-node')).toHaveCount(40);
    await expect(page.locator('[data-testid="graph-label"]:not(.off)')).toHaveCount(40);
    await page.getByTestId('graph-view-local').click();
    await expect(page.getByTestId('graph-pick')).toBeVisible();
  });

  test('a centre with more than 30 neighbours shows the 30 strongest and "+N more", which lists the rest', async ({
    page,
  }) => {
    const hub = byName(small, 'Hub Overview');
    await openLibrary(page, small);
    await page.locator(`[data-testid="library-item"][data-id="${hub.id}"] [data-testid="library-show-graph"]`).click();
    await settled(page);
    await expect(page.getByTestId('graph-node')).toHaveCount(31);
    const more = page.getByTestId('graph-more');
    await expect(more).toHaveCount(1);
    await expect(page.locator('[data-testid="graph-label"][data-id="more"]')).toHaveText('+9 more');
    await more.click({ force: true });
    const items = page.getByTestId('graph-more-item');
    await expect(items).toHaveCount(9);
    const id = await items.first().getAttribute('data-id');
    await items.first().click();
    await expect(root(page)).toHaveAttribute('data-center', id);
    await settled(page);
  });
});

test.describe('screenshots of the 900-document library', () => {
  for (const scheme of ['light', 'dark']) {
    test(`local, folders and all, ${scheme}`, async ({ page }) => {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.setViewportSize({ width: 1280, height: 820 });
      await page.emulateMedia({ colorScheme: scheme });
      await openLibrary(page, large);
      const hub = hubOf(large);
      await page
        .locator(`[data-testid="library-item"][data-id="${hub.id}"] [data-testid="library-show-graph"]`)
        .click();
      await page.getByTestId('graph-second-hop').check();
      await settled(page);
      await page.mouse.move(2, 2);
      await page.screenshot({ path: `${SHOTS}/local-${scheme}.png` });

      await page.getByTestId('graph-view-folders').click();
      await settled(page);
      await page.screenshot({ path: `${SHOTS}/folders-${scheme}.png` });
      await page
        .locator('[data-testid="graph-group"][data-key="sub:Cooperative Records/Governance"]')
        .click({ force: true });
      await settled(page);
      await page.mouse.move(2, 2);
      await page.screenshot({ path: `${SHOTS}/folders-expanded-${scheme}.png` });
      // A document with a link into another folder, selected, and that folder opened.
      const keyOf = (id) => {
        const p = large.data.nodes.find((n) => n.id === id).relPath.split('/');
        return p.length === 1 ? 'added:' : p.length === 2 ? `top:${p[0]}` : `sub:${p[0]}/${p[1]}`;
      };
      const cross = large.data.edges.find(
        (e) =>
          keyOf(e.source) !== keyOf(e.target) &&
          keyOf(e.source).startsWith('sub:') &&
          keyOf(e.target).startsWith('sub:'),
      );
      expect(cross, 'two subfolders are linked').toBeTruthy();
      await page.locator('[data-testid="graph-collapse"]').click();
      await settled(page);
      await page.locator(`[data-testid="graph-group"][data-key="${keyOf(cross.source)}"]`).click({ force: true });
      await settled(page);
      await page.locator(`[data-testid="graph-node"][data-id="${cross.source}"]`).click({ force: true });
      await page.locator(`[data-testid="graph-group"][data-key="${keyOf(cross.target)}"]`).click({ force: true });
      await settled(page);
      await page.mouse.move(2, 2);
      await page.screenshot({ path: `${SHOTS}/folders-selected-${scheme}.png` });
      await page.keyboard.press('Escape');

      await page.getByTestId('graph-view-all').click();
      await settled(page);
      await page.screenshot({ path: `${SHOTS}/all-${scheme}.png` });
      await page.getByTestId('graph-search').fill('Pressure Management');
      await page.getByTestId('graph-search').blur();
      await page.screenshot({ path: `${SHOTS}/all-search-${scheme}.png` });
      await page.getByTestId('graph-search').fill('');
      await page.locator(`[data-testid="graph-node"][data-id="${hub.id}"]`).click({ force: true });
      await page.mouse.move(2, 2);
      await settledLabels(page);
      await page.screenshot({ path: `${SHOTS}/all-selected-${scheme}.png` });
    });
  }
});
