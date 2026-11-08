// Compare page cards: at most 10 lines of text with Show more, Expand all, and columns that follow
// the window width. Seeded with Markdown files that share one heading, four long and one short.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { seedBrowse, stubBrowseBridge } from './browse-seed.mjs';

const LONG = Array.from(
  { length: 6 },
  (_, i) =>
    `Paragraph ${i + 1}. The notice period depends on the length of service and on the kind of contract. ` +
    'A member of staff gives written notice to the line manager, who confirms the last working day in writing.',
).join('\n\n');
const SHORT = 'One month for everyone.';
const FILES = {
  'policy-a.md': LONG,
  'policy-b.md': LONG,
  'policy-c.md': SHORT,
  'policy-d.md': LONG,
  'policy-e.md': LONG,
};

let seed;
let dir;

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-compare-e2e-'));
  const files = Object.entries(FILES).map(([name, text]) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `# ${name.replace('.md', '')}\n\n## Notice period\n\n${text}\n`);
    return f;
  });
  seed = await seedBrowse({ files });
});

test.afterAll(() => {
  seed?.cleanup();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// Screenshots for the PR, only with SCREENSHOT_DIR set:
//   SCREENSHOT_DIR=docs/screenshots/compare npx playwright test compare
const shots = process.env.SCREENSHOT_DIR;

async function openCompare(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await stubBrowseBridge(page, seed.index);
  await page.goto(`${process.env.ASKFILES_PAGE_URL}/browse/index.html`);
  await page.getByTestId('browse-tab-compare').click();
  await page.getByTestId('compare-item').filter({ hasText: 'Notice period' }).click();
  await expect(page.getByTestId('compare-card')).toHaveCount(5);
  return page.getByTestId('compare-card');
}

/** Distinct left edges of the cards: the number of columns. */
async function columns(page) {
  const boxes = await page
    .getByTestId('compare-card')
    .evaluateAll((cards) => cards.map((c) => Math.round(c.getBoundingClientRect().left)));
  return new Set(boxes).size;
}

const LINE = (l) => l.evaluate((b) => parseFloat(window.getComputedStyle(b).lineHeight));

test.describe('Compare cards', () => {
  test('clamps long text to 10 lines with a fade and Show more; short text has neither', async ({ page }) => {
    const cards = await openCompare(page, 1200);
    const long = cards.filter({ hasText: 'policy-a' });
    const short = cards.filter({ hasText: 'policy-c' });
    const text = long.getByTestId('compare-text');
    const line = await LINE(text);
    const h = (await text.boundingBox()).height;
    expect(h).toBeLessThanOrEqual(line * 10 + 1);
    expect(h).toBeGreaterThan(line * 9);
    expect(await text.evaluate((b) => window.getComputedStyle(b).maskImage)).toContain('linear-gradient');
    await expect(long.getByTestId('compare-more')).toHaveText('Show more');
    await expect(short.getByTestId('compare-more')).toBeHidden();
    expect(await short.getByTestId('compare-text').evaluate((b) => window.getComputedStyle(b).maskImage)).toBe('none');
    // File name, section and page stay in the header.
    await expect(long.getByTestId('compare-file')).toHaveText('policy-a.md');
    await expect(long.locator('.compare-section')).toHaveText('Notice period');
    if (shots) await page.screenshot({ path: `${shots}/compare-clamped.png`, fullPage: true });
  });

  test('Show more expands one card in place and Show less collapses it again', async ({ page }) => {
    const cards = await openCompare(page, 1200);
    const long = cards.filter({ hasText: 'policy-a' });
    const other = cards.filter({ hasText: 'policy-b' });
    const text = long.getByTestId('compare-text');
    const before = (await text.boundingBox()).height;
    const otherBefore = (await other.getByTestId('compare-text').boundingBox()).height;
    await long.getByTestId('compare-more').click();
    await expect(long.getByTestId('compare-more')).toHaveText('Show less');
    await expect(long.getByTestId('compare-more')).toHaveAttribute('aria-expanded', 'true');
    expect((await text.boundingBox()).height).toBeGreaterThan(before + 20);
    await expect(text).toContainText('Paragraph 6.');
    expect((await other.getByTestId('compare-text').boundingBox()).height).toBe(otherBefore);
    if (shots) await page.screenshot({ path: `${shots}/compare-one-expanded.png`, fullPage: true });
    await long.getByTestId('compare-more').click();
    await expect(long.getByTestId('compare-more')).toHaveText('Show more');
    expect((await text.boundingBox()).height).toBeCloseTo(before, 0);
  });

  test('Expand all opens every long card, Collapse all closes them', async ({ page }) => {
    const cards = await openCompare(page, 1200);
    const all = page.getByTestId('compare-expand-all');
    await expect(all).toHaveText('Expand all');
    await all.click();
    await expect(all).toHaveText('Collapse all');
    await expect(cards.getByTestId('compare-more').filter({ visible: true })).toHaveText(Array(4).fill('Show less'));
    // Cards in a row stay aligned at the top when their heights differ.
    const tops = await cards.evaluateAll((cs) => cs.slice(0, 2).map((c) => Math.round(c.getBoundingClientRect().top)));
    expect(tops[0]).toBe(tops[1]);
    if (shots) await page.screenshot({ path: `${shots}/compare-expanded-all.png`, fullPage: true });
    await all.click();
    await expect(all).toHaveText('Expand all');
    await expect(cards.getByTestId('compare-more').filter({ visible: true })).toHaveText(Array(4).fill('Show more'));
    // Opening the last long card by hand makes every one open, so the control offers Collapse all.
    for (const name of ['policy-a', 'policy-b', 'policy-d', 'policy-e'])
      await cards.filter({ hasText: name }).getByTestId('compare-more').click();
    await expect(all).toHaveText('Collapse all');
  });

  for (const [width, expected] of [
    [700, 1],
    [1200, 2],
    [1600, 3],
    [1920, 4],
  ]) {
    test(`a ${width} px window shows ${expected} column${expected > 1 ? 's' : ''} of readable width`, async ({
      page,
    }) => {
      await openCompare(page, width);
      await expect.poll(() => columns(page)).toBe(expected);
      const widths = await page
        .getByTestId('compare-card')
        .evaluateAll((cs) => cs.map((c) => c.getBoundingClientRect().width));
      const rem = await page.evaluate(() => parseFloat(window.getComputedStyle(document.documentElement).fontSize));
      for (const w of widths) {
        expect(w / rem).toBeGreaterThanOrEqual(expected === 1 ? 20 : 16.5);
        expect(w / rem).toBeLessThanOrEqual(32);
      }
      if (shots) await page.screenshot({ path: `${shots}/compare-${width}.png`, fullPage: true });
    });
  }
});
