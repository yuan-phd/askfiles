// Browse view (plan phase 4): library, document, headings and find pages against a browse index
// seeded from corpus S with the real splitter, through a stub of the preload bridge; and the
// Search and Browse switch on the search page.
import { test, expect } from '@playwright/test';
import { seedBrowse, stubBrowseBridge } from './browse-seed.mjs';
import { mockLibrary, pageUrl, answerEvents, chunk, watcherStatus } from './mocks.js';

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
let seed;

test.beforeAll(async () => {
  seed = await seedBrowse({
    mtimes: {
      'budget-2026.xlsx': T0 + 5 * DAY,
      'it-handbook.pdf': T0 + 1 * DAY,
      'leave-policy-v1.md': T0,
      'leave-policy-v2.md': T0 + 9 * DAY,
      '报销制度.docx': T0 + 3 * DAY,
      'operations-manual.docx': T0 + 2 * DAY,
    },
  });
});

test.afterAll(() => seed?.cleanup());

const browseUrl = () => `${process.env.ASKFILES_PAGE_URL}/browse/index.html`;
const names = (page) => page.getByTestId('library-open').allTextContents();

async function openBrowse(page, opts) {
  await stubBrowseBridge(page, seed.index, opts);
  await page.goto(browseUrl());
  await expect(page.getByTestId('library-item')).toHaveCount(6);
}

test.describe('browse view', () => {
  test('library lists every document, sorts by name and date, expands outlines', async ({ page }) => {
    await openBrowse(page, { status: watcherStatus({ indexed: 6 }) });
    await expect(page.getByTestId('library-count')).toHaveText('6 documents');
    await expect(page.getByTestId('library-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('library-state')).toHaveText('Up to date');
    expect(await names(page)).toEqual([
      'budget-2026.xlsx',
      'it-handbook.pdf',
      'leave-policy-v1.md',
      'leave-policy-v2.md',
      'operations-manual.docx',
      '报销制度.docx',
    ]);

    await page.getByTestId('library-sort').selectOption('date');
    expect(await names(page)).toEqual([
      'leave-policy-v2.md',
      'budget-2026.xlsx',
      '报销制度.docx',
      'operations-manual.docx',
      'it-handbook.pdf',
      'leave-policy-v1.md',
    ]);

    const pdf = page.getByTestId('library-item').filter({ hasText: 'it-handbook.pdf' });
    await expect(pdf.getByTestId('library-meta')).toContainText('4 sections');
    const outline = pdf.getByTestId('library-outline');
    await expect(outline).toBeHidden();
    await pdf.getByTestId('library-toggle').click();
    await expect(outline).toBeVisible();
    // 2.1 sits under 2 Laptops: the outline nests by heading level.
    await expect(outline.locator(':scope > li')).toHaveCount(3);
    await expect(outline.locator(':scope > li').nth(1).locator('li')).toHaveText('2.1 Lost devices');

    // The indexing state follows the watcher, as the status bar does.
    await page.evaluate((s) => window.__watcher(s), watcherStatus({ state: 'working', pending: 2, indexed: 6 }));
    await expect(page.getByTestId('library-state')).toHaveText('Indexing, 2 left');
    await expect(page.getByTestId('library-state')).toHaveAttribute('data-state', 'indexing');
    // The list was reloaded and kept the sort and the open outline.
    await expect(outline).toBeVisible();
    expect((await names(page))[0]).toBe('leave-policy-v2.md');
  });

  test('document page renders sections with an outline rail and jumps to a section', async ({ page }) => {
    await openBrowse(page);
    await page.getByTestId('library-open').filter({ hasText: 'operations-manual.docx' }).click();
    const doc = page.getByTestId('document');
    await expect(doc).toBeVisible();
    await expect(page.getByTestId('library')).toBeHidden();
    await expect(page.getByTestId('doc-title')).toHaveText('operations-manual.docx');

    const sections = page.getByTestId('doc-section');
    await expect(sections).toHaveCount(7);
    await expect(sections.nth(1).getByTestId('doc-section-title')).toHaveText('1.1 Receiving goods');
    // A section split into three chunks for embedding reads as one, its title shown once.
    const receiving = sections.nth(1);
    await expect(receiving.locator('.doc-heading', { hasText: '1.1 Receiving goods' })).toHaveCount(1);
    expect((await receiving.locator('.doc-para').allTextContents()).join('\n').length).toBeGreaterThan(2500);

    const rail = page.getByTestId('doc-outline');
    await expect(rail.getByTestId('doc-outline-entry').first()).toHaveText('Operations manual 运营手册');
    const target = rail.getByTestId('doc-outline-entry').filter({ hasText: '3.2 急救' });
    await target.click();
    await expect(target).toHaveClass(/active/);
    const firstAid = page.locator('.doc-section[data-section="7"]');
    await expect(firstAid).toHaveClass(/target/);
    await expect(firstAid).toBeInViewport();
    await expect(firstAid.getByTestId('doc-section-title')).toHaveText('3.2 急救');

    await page.getByTestId('doc-open').click();
    await expect
      .poll(() => page.evaluate(() => window.__opened))
      .toEqual([
        { title: 'operations-manual.docx', url: expect.stringMatching(/^file:\/\/.*\/operations-manual\.docx$/) },
      ]);

    await page.getByTestId('doc-back').click();
    await expect(page.getByTestId('library')).toBeVisible();
  });

  test('a PDF section shows its page and an outline entry from the library opens at it', async ({ page }) => {
    await openBrowse(page);
    const pdf = page.getByTestId('library-item').filter({ hasText: 'it-handbook.pdf' });
    await pdf.getByTestId('library-toggle').click();
    await pdf.getByTestId('library-outline-entry').filter({ hasText: '2.1 Lost devices' }).click();
    const sec = page.locator('.doc-section[data-section="3"]');
    await expect(sec).toHaveClass(/target/);
    await expect(sec.getByTestId('doc-section-page')).toHaveText('Page 2');
    await expect(page.locator('.doc-section[data-section="1"]').getByTestId('doc-section-page')).toHaveText('Page 1');
  });

  test('headings index lines up near-duplicate files side by side', async ({ page }) => {
    await openBrowse(page);
    await page.getByTestId('browse-tab-headings').click();
    const items = page.getByTestId('heading-item');
    // Only headings found in two or more documents by default.
    await expect(items).toHaveCount(4);
    await expect(items.first()).toContainText('2 documents');
    await expect(items.filter({ hasText: '适用范围' })).toHaveCount(0);

    await items.filter({ hasText: 'Annual leave' }).click();
    await expect(page.getByTestId('headings-title')).toHaveText('Annual leave');
    const cards = page.getByTestId('compare-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.getByTestId('compare-file')).toHaveText(['leave-policy-v1.md', 'leave-policy-v2.md']);
    await expect(cards.nth(0).getByTestId('compare-text')).toContainText('25 days of paid annual leave');
    await expect(cards.nth(1).getByTestId('compare-text')).toContainText('27 days of paid annual leave');
    const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    expect(b.x).toBeGreaterThan(a.x + a.width - 1);

    await cards.nth(1).getByTestId('compare-open').click();
    await expect.poll(() => page.evaluate(() => window.__opened.map((o) => o.title))).toEqual(['leave-policy-v2.md']);

    await cards.nth(0).getByTestId('compare-read').click();
    await expect(page.getByTestId('doc-title')).toHaveText('leave-policy-v1.md');
    await expect(page.locator('.doc-section[data-section="2"]')).toHaveClass(/target/);
    await page.getByTestId('doc-back').click();
    await expect(page.getByTestId('headings')).toBeVisible();
    await expect(page.getByTestId('compare-card')).toHaveCount(2);

    await page.getByTestId('headings-all').check();
    await expect(items.filter({ hasText: '适用范围' })).toHaveCount(1);
    await expect(items.filter({ hasText: '适用范围' })).toContainText('1 document');
  });

  test('find groups hits by document and section, Chinese and English', async ({ page }) => {
    await openBrowse(page);
    await page.getByTestId('browse-tab-find').click();
    await expect(page.getByTestId('find-query')).toBeFocused();

    await page.getByTestId('find-query').fill('差旅');
    await page.getByTestId('find-query').press('Enter');
    await expect(page.getByTestId('find-group')).toHaveCount(1);
    await expect(page.getByTestId('find-file')).toHaveText('报销制度.docx');
    const hit = page.getByTestId('find-hit');
    await expect(hit).toHaveCount(1);
    await expect(hit).toContainText('2 差旅报销');
    // The term is in the heading only, so the heading is marked.
    await expect(hit.locator('.find-hit-title mark')).toHaveText('差旅');

    await page.getByTestId('find-query').fill('住宿 上海');
    await page.getByTestId('find-query').press('Enter');
    await expect(page.getByTestId('find-hit')).toHaveCount(1);
    await expect(page.getByTestId('find-snippet').locator('mark')).toHaveText(['住宿', '住宿', '上海']);

    await page.getByTestId('find-query').fill('annual LEAVE');
    await page.getByTestId('find-submit').click();
    await expect(page.getByTestId('find-file')).toHaveText(['leave-policy-v1.md', 'leave-policy-v2.md']);
    await expect(page.getByTestId('find-summary')).toHaveText('2 sections in 2 documents');
    const v2 = page.getByTestId('find-group').filter({ hasText: 'leave-policy-v2.md' });
    await expect(v2.getByTestId('find-snippet')).toContainText('27 days of paid annual leave');
    await expect(v2.getByTestId('find-snippet').locator('mark')).toHaveText(['annual', 'leave', 'Leave']);
    await expect(v2.locator('.find-hit-title mark')).toHaveText(['Annual', 'leave']);

    await v2.getByTestId('find-hit').click();
    await expect(page.getByTestId('doc-title')).toHaveText('leave-policy-v2.md');
    await expect(page.locator('.doc-section[data-section="2"]')).toHaveClass(/target/);
    await page.getByTestId('doc-back').click();
    // The find page kept its query and results.
    await expect(page.getByTestId('find-query')).toHaveValue('annual LEAVE');
    await expect(page.getByTestId('find-group')).toHaveCount(2);

    await page.getByTestId('find-query').fill('helicopter');
    await page.getByTestId('find-query').press('Enter');
    await expect(page.getByTestId('find-summary')).toHaveText('Nothing in your documents contains helicopter.');
    await expect(page.getByTestId('find-group')).toHaveCount(0);
  });
});

test.describe('search and browse in one window', () => {
  test('switches without a reload, keeps each view, and a source card opens its section', async ({ page }) => {
    const v2 = seed.index.listDocuments().find((d) => d.title === 'leave-policy-v2.md');
    const sources = [
      {
        ...chunk({
          id: 'a',
          file: 'leave-policy-v2.md',
          text: 'Each parent may take 16 weeks of paid parental leave.',
          sectionTitle: 'Parental leave',
          sectionIndex: 4,
        }),
        url: v2.url,
      },
    ];
    await mockLibrary(page, { stream: () => answerEvents('Sixteen weeks.', sources) });
    await stubBrowseBridge(page, seed.index, { status: watcherStatus({ indexed: 6 }) });
    await page.goto(pageUrl());
    await page.evaluate(() => {
      window.__sameDocument = true;
    });

    await page.getByTestId('query').fill('How long is parental leave?');
    await page.getByTestId('query').press('Enter');
    await expect(page.getByTestId('answer-text')).toHaveText('Sixteen weeks.');
    await expect(page.getByTestId('view-search')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('view-browse').click();
    await expect(page.getByTestId('search-view')).toBeHidden();
    await expect(page.getByTestId('browse-view')).toBeVisible();
    await expect(page.getByTestId('view-browse')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('library-item')).toHaveCount(6);
    await page.getByTestId('browse-tab-find').click();
    await page.getByTestId('find-query').fill('medical certificate');
    await page.getByTestId('find-query').press('Enter');
    await expect(page.getByTestId('find-group')).toHaveCount(2);

    await page.getByTestId('view-search').click();
    await expect(page.getByTestId('search-view')).toBeVisible();
    await expect(page.getByTestId('answer-text')).toHaveText('Sixteen weeks.');
    await expect(page.getByTestId('query')).toHaveValue('How long is parental leave?');
    await page.getByTestId('view-browse').click();
    await expect(page.getByTestId('find-group')).toHaveCount(2);
    await expect(page.getByTestId('find-query')).toHaveValue('medical certificate');
    expect(await page.evaluate(() => window.__sameDocument)).toBe(true);

    await page.getByTestId('view-search').click();
    await page.getByTestId('source-card').getByTestId('source-read').click();
    await expect(page.getByTestId('browse-view')).toBeVisible();
    await expect(page.getByTestId('doc-title')).toHaveText('leave-policy-v2.md');
    const sec = page.locator('.doc-section[data-section="4"]');
    await expect(sec).toHaveClass(/target/);
    await expect(sec).toBeInViewport();
    await expect(sec.getByTestId('doc-section-title')).toHaveText('Parental leave');
    expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  });

  test('a source the browse index does not know says so', async ({ page }) => {
    const sources = [chunk({ id: 'a', file: 'gone.pdf', text: 'Old text.', sectionTitle: 'Intro', sectionIndex: 1 })];
    await mockLibrary(page, { stream: () => answerEvents('An answer.', sources) });
    await stubBrowseBridge(page, seed.index);
    await page.goto(pageUrl());
    await page.getByTestId('query').fill('Anything?');
    await page.getByTestId('query').press('Enter');
    await page.getByTestId('source-read').click();
    await expect(page.getByTestId('doc-error')).toHaveText(
      'This document is not in the library yet. It appears here once it is indexed.',
    );
    await expect(page.getByTestId('doc-title')).toHaveText('gone.pdf');
  });
});

// Page states for the PR in light and dark mode, through the search page as the app shows them:
//   SCREENSHOT_DIR=docs/screenshots/browse npx playwright test browse -g screenshot
const shots = process.env.SCREENSHOT_DIR;
for (const scheme of ['light', 'dark']) {
  test(`browse screenshot ${scheme}`, async ({ page }) => {
    test.skip(!shots, 'SCREENSHOT_DIR not set');
    await page.emulateMedia({ colorScheme: scheme });
    await mockLibrary(page, { documents: 6 });
    await stubBrowseBridge(page, seed.index, {
      status: watcherStatus({ indexed: 6, folder: '/Users/anna/Documents/HR' }),
    });
    await page.goto(pageUrl({ folder: '/Users/anna/Documents/HR' }));
    await page.getByTestId('view-browse').click();
    const item = page.getByTestId('library-item').filter({ hasText: 'operations-manual.docx' });
    await item.getByTestId('library-toggle').click();
    await page.screenshot({ path: `${shots}/library-${scheme}.png`, fullPage: true });

    await item.getByTestId('library-outline-entry').filter({ hasText: '1.2 Storage' }).click();
    await expect(page.locator('.doc-section.target')).toBeInViewport();
    await page.waitForTimeout(1700);
    await page.screenshot({ path: `${shots}/document-${scheme}.png` });

    await page.getByTestId('browse-tab-headings').click();
    await page.getByTestId('heading-item').filter({ hasText: 'Sick leave' }).click();
    await page.getByTestId('compare-card').nth(1).waitFor();
    await page.screenshot({ path: `${shots}/headings-${scheme}.png`, fullPage: true });

    await page.getByTestId('browse-tab-find').click();
    await page.getByTestId('find-query').fill('leave');
    await page.getByTestId('find-query').press('Enter');
    await page.getByTestId('find-group').nth(1).waitFor();
    await page.screenshot({ path: `${shots}/find-${scheme}.png`, fullPage: true });
  });
}
