// Interface fixes from the owner's tests: Find ranking and snippets, the page history (Back and
// Cmd+[), the dagger on unsupported sentences, the top bar layout at two widths, and the Ask
// off notice of the 8 GB tier only.
import { test, expect } from '@playwright/test';
import { seedBrowse, stubBrowseBridge } from './browse-seed.mjs';
import { folderSource, library, stubLibraries } from './libraries-stub.mjs';
import { answerRun, card, mockLibrary, pageUrl, partsOf, stubAnswer, watcherStatus } from './mocks.js';

const FIND_FILES = ['a-scattered.md', 'b-paragraph.md', 'c-adjacent.md', 'd-reversed.md'].map((f) => `find/${f}`);
let corpus;
let findSeed;

test.beforeAll(async () => {
  corpus = await seedBrowse();
  findSeed = await seedBrowse({ files: FIND_FILES });
});

test.afterAll(() => {
  corpus?.cleanup();
  findSeed?.cleanup();
});

const browseUrl = () => `${process.env.ASKFILES_PAGE_URL}/browse/index.html`;

async function findWords(page, words) {
  await page.getByTestId('browse-tab-find').click();
  await page.getByTestId('find-query').fill(words);
  await page.getByTestId('find-query').press('Enter');
  await expect(page.getByTestId('find-summary')).toBeVisible();
}

test.describe('Find', () => {
  test('ranks words side by side first, then in one paragraph, then the rest; quotes force a phrase', async ({
    page,
  }) => {
    await stubBrowseBridge(page, findSeed.index);
    await page.goto(browseUrl());
    await findWords(page, 'annual leave');
    await expect(page.getByTestId('find-file')).toHaveText([
      'c-adjacent.md',
      'b-paragraph.md',
      'd-reversed.md',
      'a-scattered.md',
    ]);

    // The snippet is the passage where the words are densest, not the first mention of leave.
    const snippet = page.getByTestId('find-group').first().getByTestId('find-snippet');
    await expect(snippet).toContainText('Annual leave is 27 days a year, and annual leave not taken');
    await expect(snippet).not.toContainText('recorded in the portal');
    await expect(snippet.locator('mark')).toHaveText(['Annual', 'leave', 'annual', 'leave']);

    // The order is the explanation: no hit says why it ranks where it does.
    await expect(page.getByTestId('find-hit').first()).not.toContainText(/exact|phrase|paragraph|rank/i);

    await findWords(page, '"annual leave"');
    await expect(page.getByTestId('find-file')).toHaveText(['c-adjacent.md']);
    await expect(page.getByTestId('find-snippet').locator('mark')).toHaveText(['Annual leave', 'annual leave']);
    await expect(page.getByTestId('find-summary')).toHaveText('1 section in 1 document');
  });
});

test.describe('Back', () => {
  test('returns from a document to the Ask results, then through Browse pages with their state', async ({ page }) => {
    const v2 = corpus.index.listDocuments().find((d) => d.title === 'leave-policy-v2.md');
    const source = card(1, {
      file: 'leave-policy-v2.md',
      url: v2.url,
      documentId: v2.id,
      sectionIndex: 4,
      title: 'Parental leave',
      path: ['Parental leave'],
      pageStart: null,
      pageEnd: null,
      passage: 'Each parent may take 16 weeks of paid parental leave.',
    });
    const run = answerRun({
      sources: [source],
      deltas: [partsOf('Sixteen weeks.')],
      result: { claims: [{ text: 'Sixteen weeks.', citations: [1], unsupported: false }], cited: [source] },
    });
    await mockLibrary(page);
    await stubBrowseBridge(page, corpus.index, { status: watcherStatus({ indexed: 6 }) });
    await stubAnswer(page, { runs: { 'How long is parental leave?': run } });
    await page.goto(pageUrl());
    await page.getByTestId('query').fill('How long is parental leave?');
    await page.getByTestId('query').press('Enter');
    await expect(page.getByTestId('answer-text')).toHaveText('Sixteen weeks.[1]');

    // Ask -> Read section -> Document; Back returns to the Ask results.
    await page.getByTestId('source-read').click();
    await expect(page.getByTestId('doc-title')).toHaveText('leave-policy-v2.md');
    // Back sits at the top of the sidebar, above Library; the Document page has none of its own.
    const back = page.getByTestId('browse-back');
    await expect(back).toBeVisible();
    await expect(back).toBeEnabled();
    const [backBox, libraryTab] = [
      await back.boundingBox(),
      await page.getByTestId('browse-tab-library').boundingBox(),
    ];
    expect(backBox.y + backBox.height).toBeLessThanOrEqual(libraryTab.y);
    await expect(page.getByTestId('document').getByRole('button', { name: 'Back' })).toHaveCount(0);
    await back.click();
    await expect(page.getByTestId('search-view')).toBeVisible();
    await expect(page.getByTestId('view-search')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('answer-text')).toHaveText('Sixteen weeks.[1]');
    await expect(page.getByTestId('query')).toHaveValue('How long is parental leave?');

    // Compare with a selection -> Read in document; Cmd+[ returns to the same selection.
    await page.getByTestId('view-browse').click();
    await page.getByTestId('browse-tab-compare').click();
    await page.getByTestId('compare-item').filter({ hasText: 'Sick leave' }).click();
    await expect(page.getByTestId('compare-title')).toHaveText(/Sick leave/i);
    await page.getByTestId('compare-read').first().click();
    await expect(page.getByTestId('browse-tab-document')).toHaveClass(/active/);
    await page.keyboard.press('Meta+BracketLeft');
    await expect(page.getByTestId('browse-tab-compare')).toHaveClass(/active/);
    await expect(page.getByTestId('compare-title')).toHaveText(/Sick leave/i);
    await expect(page.getByTestId('compare-item').filter({ hasText: 'Sick leave' })).toHaveClass(/active/);

    // Find results -> a hit; Back returns to the results and the words.
    await findWords(page, 'medical certificate');
    await expect(page.getByTestId('find-group')).toHaveCount(2);
    await page.getByTestId('find-hit').first().click();
    await expect(page.getByTestId('browse-tab-document')).toHaveClass(/active/);
    await page.getByTestId('browse-back').click();
    await expect(page.getByTestId('browse-tab-find')).toHaveClass(/active/);
    await expect(page.getByTestId('find-query')).toHaveValue('medical certificate');
    await expect(page.getByTestId('find-group')).toHaveCount(2);

    // Library at a scroll position -> a document from its outline; Back returns to that position.
    await page.setViewportSize({ width: 1200, height: 420 });
    await page.getByTestId('browse-tab-library').click();
    const item = page.getByTestId('library-item').filter({ hasText: 'operations-manual.docx' });
    await item.getByTestId('library-toggle').click();
    const content = page.getByTestId('browse-content');
    await content.evaluate((el) => (el.scrollTop = 160));
    const before = await content.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(100);
    await item.getByTestId('library-outline-entry').first().click();
    await expect(page.getByTestId('browse-tab-document')).toHaveClass(/active/);
    await page.keyboard.press('Meta+BracketLeft');
    await expect(page.getByTestId('browse-tab-library')).toHaveClass(/active/);
    await expect(item.getByTestId('library-outline')).toBeVisible();
    await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBe(before);

    // Back further: the Find page, the document before it, and so on, down to Ask.
    for (let i = 0; i < 12 && (await page.getByTestId('search-view').isHidden()); i++)
      await page.keyboard.press('Meta+BracketLeft');
    await expect(page.getByTestId('search-view')).toBeVisible();
    await expect(page.getByTestId('answer-text')).toHaveText('Sixteen weeks.[1]');
  });

  test('on the Browse page alone, Back returns from a document to the page before', async ({ page }) => {
    await stubBrowseBridge(page, findSeed.index);
    await page.goto(browseUrl());
    await expect(page.getByTestId('library-item')).toHaveCount(4);
    // Always shown, disabled while there is nothing to go back to.
    await expect(page.getByTestId('browse-back')).toBeVisible();
    await expect(page.getByTestId('browse-back')).toBeDisabled();
    await findWords(page, 'annual leave');
    await page.getByTestId('find-hit').first().click();
    await expect(page.getByTestId('doc-title')).toHaveText('c-adjacent.md');
    await page.getByTestId('browse-back').click();
    await expect(page.getByTestId('browse-tab-find')).toHaveClass(/active/);
    await expect(page.getByTestId('find-file')).toHaveCount(4);
  });
});

test.describe('Back after a library change', () => {
  test('starts again: nothing to go back to, and Cmd+[ stays put', async ({ page }) => {
    const libs = (current) => ({
      current,
      libraries: [
        library({ isCurrent: current === 'all-files', indexed: 6, sources: [folderSource('/Users/anna/Documents')] }),
        library({
          id: 'lib-1',
          name: 'Work',
          isDefault: false,
          isCurrent: current === 'lib-1',
          indexed: 6,
          sources: [folderSource('/Users/anna/Work')],
        }),
      ],
    });
    await mockLibrary(page, { documents: 6 });
    await stubBrowseBridge(page, corpus.index, { status: watcherStatus({ indexed: 6 }) });
    await stubLibraries(page, { libraries: libs('all-files') });
    await page.goto(pageUrl());
    await expect(page.getByTestId('library-name')).toHaveText('All files');
    await page.getByTestId('view-browse').click();
    await page.getByTestId('browse-tab-compare').click();
    await page.getByTestId('browse-tab-find').click();
    await expect(page.getByTestId('browse-back')).toBeEnabled();

    // The main process reports another current library (normally it also reloads the window).
    await page.evaluate((v) => window.__librariesEvent(v), libs('lib-1'));
    await expect(page.getByTestId('library-name')).toHaveText('Work');
    await expect(page.getByTestId('browse-back')).toBeDisabled();
    await page.keyboard.press('Meta+BracketLeft');
    await expect(page.getByTestId('browse-tab-find')).toHaveClass(/active/);
    await expect(page.getByTestId('browse-view')).toBeVisible();
  });
});

test.describe('unsupported sentences', () => {
  test('stay muted, get a dagger, and one line under the answer explains it', async ({ page }) => {
    const LEAVE = card(1, {
      title: '1 Annual leave',
      path: ['1 Annual leave'],
      passage: 'Every employee gets 27 days.',
    });
    const run = answerRun({
      sources: [LEAVE],
      deltas: [partsOf('Employees get 27 days [1]. Plan leave early.')],
      result: {
        claims: [
          { text: 'Employees get 27 days . ', citations: [1], unsupported: false },
          { text: 'Plan leave early.', citations: [], unsupported: true },
        ],
        cited: [LEAVE],
      },
    });
    await mockLibrary(page);
    await stubAnswer(page, { runs: { 'How much leave?': run } });
    await page.goto(pageUrl());
    await page.getByTestId('query').fill('How much leave?');
    await page.getByTestId('query').press('Enter');
    const starred = page.getByTestId('claim-unsupported');
    await expect(starred).toHaveText('Plan leave early.†');
    await expect(starred).toHaveClass(/unsupported/);
    await expect(starred.getByTestId('unsupported-mark')).toHaveText('†');
    // Muted like before: the sentence takes the muted text colour, the supported one does not.
    const color = (l) => l.evaluate((el) => window.getComputedStyle(el).color);
    expect(await color(starred)).not.toBe(await color(page.getByTestId('claim').first()));
    await expect(page.getByTestId('claim').first().getByTestId('unsupported-mark')).toHaveCount(0);
    await expect(page.getByTestId('answer-note')).toHaveText(
      'Sentences marked † have no word-for-word support in the sources. They may be a summary or conclusion drawn from the sources, or they may be inaccurate. Check them against the source cards.',
    );
  });

  test('a Chinese answer gets the Chinese line, and a list lead-in no dagger', async ({ page }) => {
    const REQ = card(1, { title: '第五条', path: ['第五条'], passage: '差旅单次报销申请额在400万元人民币以上。' });
    const run = answerRun({
      sources: [REQ],
      deltas: [partsOf('门槛如下：\n- 施工400万元人民币以上 [1]\n两者一致。')],
      result: {
        claims: [
          { text: '门槛如下：\n', citations: [], unsupported: false, leadIn: true },
          { text: '- 施工400万元人民币以上 \n', citations: [1], unsupported: false },
          { text: '两者一致。', citations: [], unsupported: true },
        ],
        cited: [REQ],
      },
    });
    await mockLibrary(page);
    await stubAnswer(page, { runs: { '门槛是多少？': run } });
    await page.goto(pageUrl());
    await page.getByTestId('query').fill('门槛是多少？');
    await page.getByTestId('query').press('Enter');
    await expect(page.getByTestId('unsupported-mark')).toHaveCount(1);
    await expect(page.getByTestId('claim').first()).toHaveText('门槛如下：');
    await expect(page.getByTestId('answer-note')).toHaveText(
      '带 † 标记的句子在来源中没有逐字对应的原文，可能是根据来源归纳的结论，也可能不准确，请对照来源卡片核实。',
    );
    await expect(page.getByTestId('unsupported-mark')).toHaveAttribute(
      'title',
      '带 † 标记的句子在来源中没有逐字对应的原文，可能是根据来源归纳的结论，也可能不准确，请对照来源卡片核实。',
    );
  });

  test('without an unsupported sentence there is no dagger and no note', async ({ page }) => {
    const LEAVE = card(1, {
      title: '1 Annual leave',
      path: ['1 Annual leave'],
      passage: 'Every employee gets 27 days.',
    });
    const run = answerRun({
      sources: [LEAVE],
      deltas: [partsOf('Employees get 27 days [1].')],
      result: { claims: [{ text: 'Employees get 27 days .', citations: [1], unsupported: false }], cited: [LEAVE] },
    });
    await mockLibrary(page);
    await stubAnswer(page, { runs: { 'How much leave?': run } });
    await page.goto(pageUrl());
    await page.getByTestId('query').fill('How much leave?');
    await page.getByTestId('query').press('Enter');
    await expect(page.getByTestId('claim')).toHaveCount(1);
    await expect(page.getByTestId('unsupported-mark')).toHaveCount(0);
    await expect(page.getByTestId('answer-note')).toBeHidden();
  });
});

test.describe('top bar layout', () => {
  for (const width of [1280, 760]) {
    test(`Ask and Browse at the left over the sidebar, library and Add at the right, fixed (${width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 600 });
      await mockLibrary(page, { documents: 6 });
      await stubBrowseBridge(page, corpus.index, { status: watcherStatus({ indexed: 6 }) });
      await stubLibraries(page, {
        libraries: {
          current: 'all-files',
          libraries: [library({ indexed: 6, sources: [folderSource('/Users/anna/Documents')] })],
        },
        status: watcherStatus({ indexed: 6 }),
      });
      await page.goto(pageUrl());
      await page.getByTestId('view-browse').click();
      await expect(page.getByTestId('library-item')).toHaveCount(6);

      const box = async (id) => await page.getByTestId(id).boundingBox();
      const switchBox = await page.locator('.view-switch').boundingBox();
      const sidebar = await box('browse-sidebar');
      const firstTab = await box('browse-tab-library');
      const lib = await box('library-switcher');
      const add = await box('add-button');

      // The switch starts where the sidebar's entries start, in the sidebar's column.
      expect(Math.abs(switchBox.x - firstTab.x)).toBeLessThanOrEqual(1);
      expect(switchBox.x + switchBox.width).toBeLessThan(sidebar.x + sidebar.width);
      // Library and Add at the right, in that order, with a clear gap, inside the window.
      expect(lib.x).toBeGreaterThan(switchBox.x + switchBox.width + 24);
      expect(add.x).toBeGreaterThanOrEqual(lib.x + lib.width + 20);
      expect(add.x + add.width).toBeLessThanOrEqual(width - 16);
      expect(add.x + add.width).toBeGreaterThan(width - 48);
      // All on one row.
      for (const b of [lib, add])
        expect(Math.abs(b.y + b.height / 2 - (switchBox.y + switchBox.height / 2))).toBeLessThan(3);

      // The library menu opens inside the window.
      await page.getByTestId('library-switcher').click();
      const menu = await box('library-menu');
      expect(menu.x).toBeGreaterThanOrEqual(0);
      expect(menu.x + menu.width).toBeLessThanOrEqual(width);
      await page.keyboard.press('Escape');

      // The bar stays where it is while the content scrolls.
      const bar = await box('status-bar');
      await page.getByTestId('browse-content').evaluate((el) => (el.scrollTop = 400));
      await page.mouse.wheel(0, 600);
      expect((await box('status-bar')).y).toBe(bar.y);
      expect(bar.y).toBe(0);
    });
  }
});

test.describe('Ask off notice', () => {
  const NOTICE =
    'Ask needs a Mac with 16 GB of memory or more; on this Mac use Browse and Find to read your documents.';

  test('shows on the Ask page of a tier with Ask off, never in Browse', async ({ page }) => {
    await page.addInitScript((notice) => {
      window.shellConfig = { askNotice: notice };
    }, NOTICE);
    await mockLibrary(page);
    await stubBrowseBridge(page, corpus.index);
    await page.goto(pageUrl());
    await expect(page.getByTestId('ask-off')).toHaveText(NOTICE);
    await expect(page.getByTestId('query')).toBeDisabled();
    await page.getByTestId('view-browse').click();
    await expect(page.getByTestId('ask-off')).toBeHidden();
    await expect(page.getByTestId('browse-view').getByText(NOTICE)).toHaveCount(0);
  });

  test('does not show on a tier with Ask on', async ({ page }) => {
    await page.addInitScript(() => {
      window.shellConfig = { askNotice: null };
    });
    await mockLibrary(page);
    await page.goto(pageUrl());
    await expect(page.getByTestId('ask-off')).toBeHidden();
    await expect(page.getByTestId('query')).toBeEnabled();
  });
});
