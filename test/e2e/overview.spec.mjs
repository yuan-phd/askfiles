// Overview page, summaries and the Ask lockout (Session N, docs/graph.md, docs/summaries.md): the
// overview graph built by the real graph code (dist/main/graph) from the browse index seeded with
// corpus S and L, served through a stub of the preload bridge; the summary controls and the Ask
// page's lockout against stubbed events.
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { buildGraph, loadProfiles, profileFor } from '../../dist/main/graph/index.js';
import { seedBrowse, stubBrowseBridge } from './browse-seed.mjs';
import { folderSource, library, stubLibraries } from './libraries-stub.mjs';
import { mockLibrary, pageUrl, watcherStatus } from './mocks.js';

const PROFILES = path.resolve(import.meta.dirname, '../../config/profiles');
let seed;
let overview;

test.beforeAll(async () => {
  seed = await seedBrowse();
  const docs = seed.index.allDocuments();
  const graph = buildGraph(docs, { profile: profileFor(loadProfiles(PROFILES), 'legal-finance') });
  const byTitle = (t) => docs.find((d) => d.title === t);
  const handbook = byTitle('it-handbook.pdf');
  const manual = byTitle('operations-manual.docx');
  // A reference edge with its passage, so the click on it can be checked whatever the fixtures cite.
  graph.edges.push({
    id: `reference:${handbook.id}:${manual.id}`,
    source: handbook.id,
    target: manual.id,
    kind: 'reference',
    weight: 1,
    passages: [{ documentId: handbook.id, sectionIndex: 3, sectionTitle: '2.1 Lost devices', snippet: 'lost laptop' }],
  });
  const summaries = Object.fromEntries(
    graph.nodes.map((n) => [
      n.id,
      n.title === 'leave-policy-v2.md'
        ? { state: 'ok', text: 'Version 2 of the Northwind leave policy for permanent employees.' }
        : { state: 'pending', text: null },
    ]),
  );
  overview = { ...graph, libraryId: 'all-files', summaries };
});

test.afterAll(() => seed?.cleanup());

const browseUrl = () => `${process.env.ASKFILES_PAGE_URL}/browse/index.html`;
const idOf = (title) => overview.nodes.find((n) => n.title === title).id;

/** window.askfiles.graph and .summaries over the overview built above; calls in window.__overviewCalls. */
async function stubOverview(page, { summaryView = null, status = null } = {}) {
  await page.addInitScript(
    ({ data, summaryView, status }) => {
      const calls = [];
      window.__overviewCalls = calls;
      const listeners = [];
      window.__summariesEvent = (e) => listeners.forEach((l) => l(e));
      window.askfiles = {
        ...(window.askfiles || {}),
        graph: {
          data: async () => data,
          onChange: () => () => {},
          profiles: async () => [
            { id: 'legal-finance', name: 'Legal and finance', description: '' },
            { id: 'team-work', name: 'Team work', description: '' },
            { id: 'general', name: 'General', description: '' },
          ],
          setType: async (id, type) => {
            calls.push(['setType', id, type]);
            // As the main process does: a chosen type overrides detection, none goes back to it.
            const n = data.nodes.find((x) => x.id === id);
            if (n) Object.assign(n, type ? { type, overridden: true } : { type: n.detectedType, overridden: false });
            return data;
          },
          answerFamily: async (...a) => {
            calls.push(['answerFamily', ...a]);
            return data;
          },
        },
        summaries: {
          status: async () => status,
          onEvent: (cb) => {
            listeners.push(cb);
            return () => {};
          },
          pause: async () => {
            calls.push(['pause']);
            return { ...status, userPaused: true, state: 'paused', reason: 'user' };
          },
          resume: async () => status,
          document: async (id) => (summaryView ? { ...summaryView, documentId: id } : null),
          requestSections: async (id) => {
            calls.push(['requestSections', id]);
            return { ...summaryView, documentId: id, sectionsWanted: true, sectionsPending: 3 };
          },
          setLibrary: async (on) => {
            calls.push(['setLibrary', on]);
            return null;
          },
          openExport: async () => true,
        },
      };
    },
    { data: overview, summaryView, status },
  );
}

async function openOverview(page, opts) {
  await stubBrowseBridge(page, seed.index);
  await stubOverview(page, opts);
  await page.goto(browseUrl());
  await expect(page.getByTestId('library-item')).toHaveCount(6);
  await page.getByTestId('browse-tab-overview').click();
  await expect(page.getByTestId('overview-node')).toHaveCount(6);
  await expect(page.getByTestId('overview-root')).toHaveAttribute('data-settled', 'true', { timeout: 20_000 });
}

const node = (page, title) => page.locator(`[data-testid="overview-node"][data-id="${idOf(title)}"]`);
const opacity = (loc) => loc.getAttribute('opacity');

test.describe('overview page', () => {
  test('draws both layouts with the profile colours, bands from the height, the legend outside the zoom', async ({
    page,
  }) => {
    await openOverview(page);
    await expect(page.getByTestId('overview-root')).toHaveAttribute('data-layout', 'organic');
    // d3 came from the app's own files.
    expect(await page.evaluate(() => [...document.scripts].map((s) => s.src).find((s) => s.includes('d3')))).toMatch(
      /\/vendor\/d3\.min\.js$/,
    );
    const colors = Object.fromEntries(overview.profile.types.map((t) => [t.name, t.color]));
    const budget = node(page, 'budget-2026.xlsx');
    await expect(budget).toHaveAttribute('data-type', 'data');
    await expect(budget).toHaveAttribute('fill', colors.data);
    // The legend hangs off the svg, not the zoom group.
    expect(await page.locator('.legend').evaluate((g) => g.closest('.zoom-layer') === null)).toBe(true);
    // One entry per type in use, in the profile's band order.
    const used = overview.profile.bands.filter((b) => overview.nodes.some((n) => n.type === b));
    await expect(page.locator('.legend .legend-label')).toHaveText(
      used.map((b) => overview.profile.types.find((t) => t.name === b).label),
    );

    await page.getByTestId('overview-layered').click();
    await expect(page.getByTestId('overview-root')).toHaveAttribute('data-layout', 'layered');
    await expect(page.getByTestId('overview-root')).toHaveAttribute('data-settled', 'true', { timeout: 20_000 });
    const meanY = (type) =>
      page.$$eval(
        `[data-testid="overview-node"][data-type="${type}"]`,
        (els) => els.reduce((s, e) => s + Number(e.getAttribute('cy')), 0) / els.length,
      );
    // Bands in the profile's order: regulation above data.
    expect(await meanY('regulation')).toBeLessThan(await meanY('data'));
    // A shorter window moves the bands: they follow the current height.
    const before = await meanY('data');
    const draws = Number(await page.getByTestId('overview-root').getAttribute('data-rendered'));
    await page.setViewportSize({ width: 1200, height: 560 });
    await expect(page.getByTestId('overview-root')).toHaveAttribute('data-rendered', String(draws + 1), {
      timeout: 5000,
    });
    await expect(page.getByTestId('overview-root')).toHaveAttribute('data-settled', 'true', { timeout: 20_000 });
    expect(await meanY('data')).toBeLessThan(before);
  });

  test('hover lights a node and its neighbours; search lights matches and neighbours and outlasts hover and redraws', async ({
    page,
  }) => {
    await openOverview(page);
    const v1 = node(page, 'leave-policy-v1.md');
    const v2 = node(page, 'leave-policy-v2.md');
    const budget = node(page, 'budget-2026.xlsx');
    await v1.hover({ force: true });
    await expect(page.getByTestId('overview-tooltip')).toBeVisible();
    await expect(page.getByTestId('overview-tooltip')).toContainText('leave-policy-v1.md');
    await expect(page.getByTestId('overview-tooltip-summary')).toHaveText('Summary pending');
    expect(await opacity(v1)).toBe('1');
    expect(await opacity(v2)).toBe('1');
    expect(await opacity(budget)).toBe('0.1');
    await page.mouse.move(5, 5);
    expect(await opacity(budget)).toBe('1');
    await v2.hover({ force: true });
    await expect(page.getByTestId('overview-tooltip-summary')).toHaveText(
      'Version 2 of the Northwind leave policy for permanent employees.',
    );
    await page.mouse.move(5, 5);

    await page.getByTestId('overview-search').fill('leave-policy-v1');
    expect(await opacity(v1)).toBe('1');
    expect(await opacity(v2)).toBe('1');
    expect(await opacity(budget)).toBe('0.05');
    // The legend is never touched by the search (the old code threw here).
    expect(await page.locator('.legend .legend-dot').first().getAttribute('opacity')).toBeNull();
    await budget.hover({ force: true });
    await page.mouse.move(5, 5);
    expect(await opacity(budget)).toBe('0.05');
    await page.getByTestId('overview-layered').click();
    await expect(page.getByTestId('overview-root')).toHaveAttribute('data-layout', 'layered');
    expect(await opacity(node(page, 'budget-2026.xlsx'))).toBe('0.05');
    expect(await opacity(node(page, 'leave-policy-v2.md'))).toBe('1');
    await page.getByTestId('overview-search').fill('');
    expect(await opacity(node(page, 'budget-2026.xlsx'))).toBe('1');
  });

  test('a node opens its Document page; edges open the Headings comparison or the referencing passage', async ({
    page,
  }) => {
    await openOverview(page);
    const headings = overview.edges.find((e) => e.kind === 'headings');
    expect(headings, 'the two leave policies share headings').toBeTruthy();
    await page
      .locator(`[data-testid="overview-edge"][data-kind="headings"][data-source="${headings.source}"]`)
      .dispatchEvent('click');
    if (headings.headings.length > 1) {
      await expect(page.getByTestId('overview-chooser')).toBeVisible();
      await page.getByTestId('overview-chooser-heading').first().click();
    }
    await expect(page.getByTestId('headings')).toBeVisible();
    await expect(page.getByTestId('headings-title')).toHaveText(headings.headings[0].label);
    await expect(page.getByTestId('compare-card')).toHaveCount(2);

    await page.getByTestId('browse-tab-overview').click();
    await expect(page.getByTestId('overview-root')).toHaveAttribute('data-settled', 'true', { timeout: 20_000 });
    await page.locator('[data-testid="overview-edge"][data-kind="reference"]').dispatchEvent('click');
    await expect(page.getByTestId('document')).toBeVisible();
    await expect(page.getByTestId('doc-title')).toHaveText('it-handbook.pdf');
    await expect(page.locator('.doc-section.target')).toHaveAttribute('data-section', '3');

    await page.getByTestId('browse-tab-overview').click();
    await expect(page.getByTestId('overview-root')).toHaveAttribute('data-settled', 'true', { timeout: 20_000 });
    await node(page, 'budget-2026.xlsx').click({ force: true });
    await expect(page.getByTestId('doc-title')).toHaveText('budget-2026.xlsx');
  });

  test('a document opened from the Overview scrolls, and the graph leaves no zoom listeners behind', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 520 });
    await openOverview(page);
    await node(page, 'it-handbook.pdf').click({ force: true });
    await expect(page.getByTestId('doc-title')).toHaveText('it-handbook.pdf');
    const content = page.getByTestId('browse-content');
    await expect(content).not.toHaveClass(/overview-on/);
    expect(await content.evaluate((c) => window.getComputedStyle(c).overflowY)).toBe('auto');
    const { scrollHeight, clientHeight } = await content.evaluate((c) => ({
      scrollHeight: c.scrollHeight,
      clientHeight: c.clientHeight,
    }));
    expect(scrollHeight, 'the handbook is longer than the window').toBeGreaterThan(clientHeight);
    // The wheel scrolls the document, which it cannot do while the graph's zoom still holds it.
    await content.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => content.evaluate((c) => c.scrollTop)).toBeGreaterThan(0);
    expect(await page.locator('.overview-svg *').count()).toBe(0);
    expect(await page.locator('.overview-svg').evaluate((s) => '__zoom' in s && s.__on?.length > 0)).toBe(false);
  });

  test('a document without links settles at the edge of the cluster, inside the panel, without zooming out', async ({
    page,
  }) => {
    const isolated = overview.nodes.find((n) => !overview.edges.some((e) => e.source === n.id || e.target === n.id));
    expect(isolated, 'corpus S and L have a document without links').toBeTruthy();
    await openOverview(page);
    const box = await page.getByTestId('overview-svg').evaluate((s) => ({ w: s.clientWidth, h: s.clientHeight }));
    const pos = await page.$$eval('[data-testid="overview-node"]', (els) =>
      els.map((e) => ({ id: e.dataset.id, x: Number(e.getAttribute('cx')), y: Number(e.getAttribute('cy')) })),
    );
    for (const p of pos) {
      expect(p.x, p.id).toBeGreaterThan(0);
      expect(p.x, p.id).toBeLessThan(box.w);
      expect(p.y, p.id).toBeGreaterThan(0);
      expect(p.y, p.id).toBeLessThan(box.h);
    }
    // The centering pull alone kept it in: the zoom-out fallback did not have to act.
    expect(await page.locator('.zoom-layer').getAttribute('transform')).toBeNull();
    const others = pos.filter((p) => p.id !== isolated.id);
    const cx = others.reduce((s, p) => s + p.x, 0) / others.length;
    const cy = others.reduce((s, p) => s + p.y, 0) / others.length;
    const me = pos.find((p) => p.id === isolated.id);
    // Within the panel's reach of the cluster, not flung to a far corner.
    expect(Math.hypot(me.x - cx, me.y - cy)).toBeLessThan(Math.min(box.w, box.h) * 0.6);
  });
});

test.describe('summaries and types on the browse pages', () => {
  const view = {
    state: 'ok',
    text: 'The handbook sets the rules for accounts, laptops and printing.',
    sectionIndex: 1,
    sections: { 1: 'Every employee gets one account; passwords change every 90 days.' },
    sectionsWanted: false,
    sectionsPending: 0,
    sectionsMissing: 3,
    estimateMinutes: 1,
  };

  test('the Library page shows types and summaries; the Document page its summary and the section button with its tooltip', async ({
    page,
  }) => {
    await openOverview(page, { summaryView: view });
    await page.getByTestId('browse-tab-library').click();
    const v2 = page.getByTestId('library-item').filter({ hasText: 'leave-policy-v2.md' });
    await expect(v2.getByTestId('library-summary')).toHaveText(
      'Version 2 of the Northwind leave policy for permanent employees.',
    );
    await expect(
      page.getByTestId('library-item').filter({ hasText: 'budget-2026.xlsx' }).getByTestId('library-summary'),
    ).toHaveText('Summary pending');
    const type = page.getByTestId('library-item').filter({ hasText: 'budget-2026.xlsx' }).getByTestId('library-type');
    const budgetRow = page.getByTestId('library-item').filter({ hasText: 'budget-2026.xlsx' });
    await expect(type).toHaveValue('');
    await expect(budgetRow.getByTestId('library-type-label')).toHaveText('Data (detected)');
    await expect(type.locator('option').first()).toHaveText('Detected: Data');
    // A click on the label lands on the dropdown lying over it.
    expect(
      await budgetRow.getByTestId('library-type-label').evaluate((l) => {
        const r = l.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.dataset.testid;
      }),
    ).toBe('library-type');
    await type.selectOption('template');
    expect(await page.evaluate(() => window.__overviewCalls)).toContainEqual([
      'setType',
      idOf('budget-2026.xlsx'),
      'template',
    ]);
    // A type the owner set shows alone; back to detection shows (detected) again.
    await expect(budgetRow.getByTestId('library-type-label')).toHaveText('Template');
    await budgetRow.getByTestId('library-type').selectOption('');
    await expect(budgetRow.getByTestId('library-type-label')).toHaveText('Data (detected)');

    await page.getByTestId('library-item').filter({ hasText: 'it-handbook.pdf' }).getByTestId('library-open').click();
    await expect(page.getByTestId('doc-summary')).toContainText(view.text);
    await expect(page.locator('.doc-section[data-section="1"] [data-testid="doc-section-summary"]')).toHaveText(
      view.sections[1],
    );
    const b = page.getByTestId('doc-summarize-sections');
    await expect(b).toHaveText('Summarize each section (about 1 minute)');
    await expect(page.getByTestId('doc-summarize-tip')).toBeHidden();
    await b.hover();
    await expect(page.getByTestId('doc-summarize-tip')).toBeVisible();
    await expect(page.getByTestId('doc-summarize-tip')).toHaveText(
      'Uses the model on this computer. Ask is slower while it runs. You can pause it in the top bar.',
    );
    await b.click();
    await expect(page.getByTestId('doc-summary-state')).toHaveText('Summarizing sections, 3 left');
    expect(await page.evaluate(() => window.__overviewCalls)).toContainEqual([
      'requestSections',
      idOf('it-handbook.pdf'),
    ]);
  });

  test('family questions on the Library page are answered with one click', async ({ page }) => {
    const v1 = idOf('leave-policy-v1.md');
    const v2 = idOf('budget-2026.xlsx');
    const saved = overview.questions;
    overview.questions = [{ a: v1, b: v2 }];
    try {
      await openOverview(page);
      await page.getByTestId('browse-tab-library').click();
      await expect(page.getByTestId('family-questions')).toBeVisible();
      await expect(page.getByTestId('family-item')).toContainText('leave-policy-v1.md and budget-2026.xlsx');
      await page.getByTestId('family-different').click();
      expect(await page.evaluate(() => window.__overviewCalls)).toContainEqual(['answerFamily', v1, v2, false]);
    } finally {
      overview.questions = saved;
    }
  });
});

test.describe('Ask page: lockout and the summary controls in the top bar', () => {
  const libs = {
    current: 'all-files',
    libraries: [
      library({
        sources: [folderSource('/Users/anna/Documents')],
        indexed: 6,
        profile: 'legal-finance',
        sectionSummaries: false,
      }),
    ],
  };
  const status = { state: 'running', reason: null, done: 2, total: 9, current: null, enabled: true, userPaused: false };

  test('the question box is off while the library indexes and comes back when it is done', async ({ page }) => {
    await mockLibrary(page);
    await stubOverview(page, { status });
    await stubLibraries(page, { libraries: libs, status: watcherStatus({ state: 'working', pending: 3, indexed: 6 }) });
    await page.goto(pageUrl());
    await expect(page.getByTestId('ask-locked')).toHaveText('Reading new files, 3 left.');
    await expect(page.getByTestId('query')).toBeDisabled();
    await expect(page.getByTestId('submit')).toBeDisabled();
    await page.evaluate((s) => window.__watcher(s), watcherStatus({ state: 'working', pending: 1, indexed: 8 }));
    await expect(page.getByTestId('ask-locked')).toHaveText('Reading new files, 1 left.');
    await page.evaluate((s) => window.__watcher(s), watcherStatus({ state: 'idle', pending: 0, indexed: 9 }));
    await expect(page.getByTestId('ask-locked')).toBeHidden();
    await expect(page.getByTestId('query')).toBeEnabled();
    await expect(page.getByTestId('submit')).toBeEnabled();
  });

  test('the top bar shows Summaries n of m with Pause; the library menu has the profile and the switch with its tooltip', async ({
    page,
  }) => {
    await mockLibrary(page);
    await stubOverview(page, { status });
    await stubLibraries(page, { libraries: libs, status: watcherStatus({ state: 'idle', indexed: 6 }) });
    await page.goto(pageUrl());
    await expect(page.getByTestId('summaries-text')).toHaveText('Summaries 3 of 9');
    await page.getByTestId('summaries-pause').click();
    await expect(page.getByTestId('summaries-text')).toHaveText('Summaries 3 of 9, paused');
    await expect(page.getByTestId('summaries-pause')).toHaveText('Resume');
    await page.evaluate(() =>
      window.__summariesEvent({
        type: 'status',
        status: {
          state: 'paused',
          reason: 'indexing',
          done: 4,
          total: 9,
          current: null,
          enabled: true,
          userPaused: false,
        },
      }),
    );
    await expect(page.getByTestId('summaries-text')).toHaveText(
      'Summaries paused until indexing finishes (4 of 9 done)',
    );

    await page.getByTestId('library-switcher').click();
    await expect(page.getByTestId('library-profile')).toHaveValue('legal-finance');
    await expect(page.getByTestId('library-new-profile')).toBeVisible();
    const tip = page.getByTestId('library-section-summaries-tip');
    await expect(tip).toBeHidden();
    await page.getByTestId('library-section-summaries').hover();
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText(
      'Uses the model on this computer. Ask is slower while it runs. You can pause it in the top bar.',
    );
    await page.getByTestId('library-section-summaries').check();
    expect(await page.evaluate(() => window.__overviewCalls)).toContainEqual(['setLibrary', true]);
  });
});
