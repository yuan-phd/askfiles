// Sections the splitter cut by page or after a table (T (page N), T (continued)) on the Compare and
// Document pages: Compare merges them into their parent and shows no summaries; the Document page
// shows the parent title once and a page marker at each part, with the summary line kept per part.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BrowseIndex } from '../../dist/main/browse/index.js';
import { stubBrowseBridge } from './browse-seed.mjs';

let tmp;
let index;

/** A browse index over in-memory section documents; sections as [title, level, page, text, lead]. */
function add(file, sections) {
  index.update({
    path: file,
    url: `file://${file}`,
    relPath: path.basename(file),
    sourceId: 'files',
    hash: 'h',
    splitKey: 'k',
    size: 10,
    mtimeMs: 1,
    indexedAt: '2026-11-04T00:00:00Z',
    sections: sections.map(([t, level, page], i) => ({
      location: `${file}-${i}`,
      docId: null,
      sectionTitle: t,
      sectionIndex: i + 1,
      sectionLevel: level,
      sectionPath: [t],
      subIndex: 1,
      pageStart: page,
      pageEnd: page,
    })),
  });
}

test.beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-parts-e2e-'));
  const chunks = new Map();
  const docs = {
    '/d/bank-procedure.pdf': [
      // The splitter folds the parent title into the first page part (its lead).
      [
        'Operational Procurement Matters (page 4)',
        3,
        4,
        'Prior review applies above the thresholds.',
        ['Bank Procedure', 'Operational Procurement Matters'],
      ],
      ['Operational Procurement Matters (page 5)', 3, 5, 'Post review covers the other contracts.'],
      ['Fees', 2, 6, 'Fees before the table.'],
      ['Fees (continued)', 3, 7, 'Fees after the table.'],
    ],
    '/d/agency-guide.pdf': [
      ['Operational Procurement Matters', 1, 2, 'The agency publishes its plan.'],
      ['Fees', 1, 3, 'Agency fees are fixed.'],
    ],
  };
  for (const [file, secs] of Object.entries(docs))
    secs.forEach(([t, , , body, lead = []], i) => chunks.set(`${file}-${i}`, [...lead, t, body].join('\n')));
  index = new BrowseIndex({
    dir: path.join(tmp, 'browse'),
    readChunk: (loc) => (chunks.has(loc) ? { pageContent: chunks.get(loc), sectionLevel: 1 } : null),
    log: () => {},
  });
  for (const [file, secs] of Object.entries(docs)) add(file, secs);
});

test.afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const browseUrl = () => `${process.env.ASKFILES_PAGE_URL}/browse/index.html`;

test('Compare merges a section cut by page into its parent and shows its full text, no summaries', async ({ page }) => {
  await stubBrowseBridge(page, index);
  await page.goto(browseUrl());
  await page.getByTestId('browse-tab-compare').click();
  await expect(page.getByTestId('browse-tab-compare')).toHaveText('Compare');
  await expect(page.getByTestId('compare-subtitle')).toHaveText(
    'The same heading across several files, shown side by side.',
  );
  // Each heading appears once.
  await expect(page.getByTestId('compare-item')).toHaveCount(2);
  await page.getByTestId('compare-item').filter({ hasText: 'Operational Procurement Matters' }).click();
  await expect(page.getByTestId('compare-title')).toHaveText('Operational Procurement Matters');
  const cards = page.getByTestId('compare-card');
  await expect(cards).toHaveCount(2);
  const bank = cards.filter({ hasText: 'bank-procedure.pdf' });
  await expect(bank.getByTestId('compare-text')).toHaveText(
    /Prior review applies above the thresholds\.\s*Post review covers the other contracts\./,
  );
  await expect(bank).toContainText('Pages 4 to 5');
  await expect(
    page.locator(
      '[data-testid="compare-card"] .doc-section-summary, [data-testid="compare-card"] [data-testid*="summary"]',
    ),
  ).toHaveCount(0);

  await page.getByTestId('compare-item').filter({ hasText: 'Fees' }).click();
  await expect(cards.filter({ hasText: 'bank-procedure.pdf' }).getByTestId('compare-text')).toHaveText(
    /Fees before the table\.\s*Fees after the table\./,
  );
});

test('the Document page shows the parent title once and a page marker at each part', async ({ page }) => {
  await stubBrowseBridge(page, index);
  await page.goto(browseUrl());
  await page.getByTestId('library-item').filter({ hasText: 'bank-procedure.pdf' }).getByTestId('library-open').click();
  await expect(page.getByTestId('doc-title')).toHaveText('bank-procedure.pdf');
  const body = page.getByTestId('doc-sections');
  await expect(body).not.toContainText('(page');
  await expect(body).not.toContainText('(continued)');
  await expect(body.locator('.doc-heading', { hasText: 'Operational Procurement Matters' })).toHaveCount(1);
  await expect(body.locator('.doc-heading', { hasText: /^Fees$/ })).toHaveCount(1);
  const sections = page.getByTestId('doc-section');
  await expect(sections.nth(1).getByTestId('doc-section-title')).toHaveCount(0);
  await expect(sections.nth(1).getByTestId('doc-section-page')).toHaveText('Page 5');
  await expect(sections.nth(3).getByTestId('doc-section-page')).toHaveText('Page 7');
  // Every part keeps its own summary line, in place.
  await expect(sections.nth(1).getByTestId('doc-section-summary')).toHaveCount(1);
  await expect(sections.nth(3).getByTestId('doc-section-summary')).toHaveCount(1);
});
