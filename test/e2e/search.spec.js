import { test, expect } from '@playwright/test';
import { REFUSAL_TEXT } from '../../src/renderer/api/client.js';
import { mockLibrary, pageUrl, answerEvents, refusalEvents, chunk, asVectorResult } from './mocks.js';

const QUESTION = 'How many days of annual leave do employees get?';

function captureOpenEvents(page) {
  const opened = [];
  page.on('console', (msg) => {
    const m = /^\[search\] open source (.*)$/.exec(msg.text());
    if (m) opened.push(JSON.parse(m[1]));
  });
  return opened;
}

function realPageUrl(workspace) {
  const url = new URL(`${process.env.ASKFILES_PAGE_URL}/search/index.html`);
  url.search = new URLSearchParams({
    baseUrl: process.env.ASKFILES_UPSTREAM_URL,
    apiKey: process.env.ASKFILES_API_KEY,
    workspace,
    folder: '/Users/test/Documents/Handbook',
  }).toString();
  return url.toString();
}

/** Asks through the page and returns the sources the server sent in the stream. */
async function askReal(page, question) {
  const streamResponse = page.waitForResponse((r) => r.url().endsWith('/stream-chat'), { timeout: 200_000 });
  await page.getByTestId('query').fill(question);
  await page.getByTestId('query').press('Enter');
  const events = (await (await streamResponse).text())
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)));
  return events.flatMap((e) => e.sources || []);
}

test.describe('against a real upstream server', () => {
  test.beforeEach(() => {
    test.skip(!!process.env.ASKFILES_UPSTREAM_SKIP, process.env.ASKFILES_UPSTREAM_SKIP);
    // qwen3 on four CPU cores can take a while even with thinking off.
    test.setTimeout(240_000);
  });

  test('answers from an uploaded PDF with a source card', async ({ page }) => {
    const opened = captureOpenEvents(page);
    await page.goto(realPageUrl(process.env.ASKFILES_PDF_WORKSPACE));
    await expect(page.getByTestId('status-count')).toHaveText('1 document indexed');
    await expect(page.getByTestId('status-state')).toHaveAttribute('data-state', 'ready');

    const served = await askReal(page, QUESTION);
    expect(served.length, 'the server returned sources for an answerable question').toBeGreaterThan(0);

    await expect(page.getByTestId('answer-text')).not.toBeEmpty({ timeout: 30_000 });
    const card = page.getByTestId('source-card').first();
    await expect(card.getByTestId('source-file')).toHaveText('handbook.pdf');
    await expect(card.getByTestId('source-passage').first()).toContainText('27 days of paid annual leave');
    await expect(card.getByTestId('source-passage').first()).not.toContainText('document_metadata');

    // Collector uploads carry no page or section (upstream-analysis Q6), so the card must not show one.
    expect(served.some((s) => s.pageStart != null || s.sectionTitle != null)).toBe(false);
    await expect(card.getByTestId('source-page')).toBeHidden();
    await expect(card.getByTestId('source-section')).toBeHidden();

    await card.getByTestId('source-open').click();
    await expect.poll(() => opened.length).toBe(1);
    expect(opened[0]).toMatchObject({ title: 'handbook.pdf' });
    await expect(page.getByTestId('recent-item').first()).toHaveText(QUESTION);
  });

  test('shows section title and pages from section documents and merges their sub-chunks', async ({ page }) => {
    await page.goto(realPageUrl(process.env.ASKFILES_SECTION_WORKSPACE));
    await expect(page.getByTestId('status-count')).toHaveText('2 documents indexed');

    const served = await askReal(page, QUESTION);
    const leaveHits = served.filter((s) => s.sectionIndex === 1);
    expect(leaveHits.length, 'the leave section was retrieved').toBeGreaterThan(0);
    expect(leaveHits[0]).toMatchObject({ sectionTitle: '1 Annual leave', pageStart: 1, pageEnd: 2 });

    await expect(page.getByTestId('answer-text')).not.toBeEmpty({ timeout: 30_000 });
    const leaveCards = page.getByTestId('source-card').filter({ hasText: '1 Annual leave' });
    await expect(leaveCards).toHaveCount(1);
    await expect(leaveCards.getByTestId('source-file')).toHaveText('handbook.pdf');
    await expect(leaveCards.getByTestId('source-section')).toHaveText('1 Annual leave');
    await expect(leaveCards.getByTestId('source-page')).toHaveText('Pages 1 to 2');
    // Every distinct sub-chunk of the section is one passage inside the single card.
    const distinct = new Set(leaveHits.map((s) => s.text)).size;
    await expect(leaveCards.getByTestId('source-passage')).toHaveCount(distinct);
    console.log(`[e2e] leave section: ${leaveHits.length} hit(s), ${distinct} distinct sub-chunk(s), one card`);
    if (process.env.SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/real-server-sections-light.png`, fullPage: true });
    }
  });

  test('an unrelated question gets the section list from vector search', async ({ page }) => {
    await page.goto(realPageUrl(process.env.ASKFILES_SECTION_WORKSPACE));
    const served = await askReal(page, 'What is the boiling point of mercury on Mars?');
    expect(served).toEqual([]);
    await expect(page.getByTestId('fallback')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('answer-text')).toBeEmpty();
    const items = page.getByTestId('fallback-item');
    await expect(items.first()).toBeVisible();
    // vector-search drops the section keys (upstream-analysis Q15); without the shell's
    // resolveSources hook the list names the file.
    await expect(items.first().getByTestId('fallback-section')).toHaveText('handbook.pdf');
  });
});

test.describe('with the chat route mocked', () => {
  test('streams the answer and merges hits from the same section into one card', async ({ page }) => {
    // Rank order: page 5 of the leave section, then the expense section, then page 4 of the leave
    // section. Cards follow rank; passages inside the leave card follow document position.
    const sources = [
      chunk({
        id: 'b',
        text: 'Unused leave can be carried over until the end of March.',
        sectionTitle: '1 Annual leave',
        sectionIndex: 1,
        page: 5,
      }),
      chunk({
        id: 'c',
        text: 'Expense claims are submitted within 30 days.',
        sectionTitle: '2 Expense claims',
        sectionIndex: 2,
        page: 6,
      }),
      chunk({
        id: 'a',
        text: 'Every employee receives 27 days of paid annual leave per year.',
        sectionTitle: '1 Annual leave',
        sectionIndex: 1,
        page: 4,
      }),
    ];
    const { requests } = await mockLibrary(page, {
      stream: () => answerEvents('Employees receive 27 days of paid annual leave.', sources),
    });
    const opened = captureOpenEvents(page);
    await page.goto(pageUrl({ folder: '/Users/test/Documents' }));
    await expect(page.getByTestId('status-count')).toHaveText('3 documents indexed');
    await expect(page.getByTestId('status-folder')).toHaveText('/Users/test/Documents');

    await page.getByTestId('query').fill(QUESTION);
    await page.getByTestId('query').press('Enter');

    await expect(page.getByTestId('answer-text')).toHaveText('Employees receive 27 days of paid annual leave.');
    await expect(page.getByTestId('answer-text')).not.toContainText('reading');
    const cards = page.getByTestId('source-card');
    await expect(cards).toHaveCount(2);
    const merged = cards.nth(0);
    await expect(merged.getByTestId('source-file')).toHaveText('handbook.pdf');
    await expect(merged.getByTestId('source-section')).toHaveText('1 Annual leave');
    await expect(merged.getByTestId('source-page')).toHaveText('Pages 4 to 5');
    await expect(merged.getByTestId('source-passage')).toHaveText([
      'Every employee receives 27 days of paid annual leave per year.',
      'Unused leave can be carried over until the end of March.',
    ]);
    await expect(merged.getByTestId('source-count')).toHaveText('2 passages from this section');
    await expect(cards.nth(1).getByTestId('source-page')).toHaveText('Page 6');
    await expect(cards.nth(1).getByTestId('source-count')).toBeHidden();
    await expect(page.getByTestId('fallback')).toBeHidden();
    expect(requests.stream[0]).toEqual({
      message: QUESTION,
      mode: 'query',
      sessionId: expect.stringMatching(/^askfiles-search-/),
    });

    await merged.getByTestId('source-open').click();
    await expect
      .poll(() => opened)
      .toEqual([
        {
          title: 'handbook.pdf',
          url: 'file:///library/handbook.pdf',
          sectionTitle: '1 Annual leave',
          sectionIndex: 1,
          page: 4,
        },
      ]);
  });

  test('a refusal answer renders the section list from vector search', async ({ page }) => {
    const near = [
      chunk({
        id: 'a',
        file: 'travel-policy.pdf',
        text: 'Train travel is booked in second class unless the trip exceeds four hours.',
        sectionTitle: '3 Booking travel',
        sectionIndex: 3,
        page: 2,
        score: 0.21,
      }),
      chunk({
        id: 'b',
        file: 'travel-policy.pdf',
        text: 'Hotels up to 120 euros per night are approved without a manager.',
        sectionTitle: '3 Booking travel',
        sectionIndex: 3,
        page: 3,
        score: 0.18,
      }),
      chunk({
        id: 'c',
        file: 'handbook.pdf',
        text: 'Expense claims are submitted through the finance portal.',
        sectionTitle: '2 Expense claims',
        sectionIndex: 2,
        page: 6,
        score: 0.12,
      }),
    ];
    const { requests } = await mockLibrary(page, {
      stream: () => refusalEvents(REFUSAL_TEXT),
      vector: () => near.map(asVectorResult),
    });
    await page.goto(pageUrl());
    await page.getByTestId('query').fill('Can I fly business class?');
    await page.getByTestId('query').press('Enter');

    const fallback = page.getByTestId('fallback');
    await expect(fallback).toBeVisible();
    await expect(page.getByTestId('answer-text')).toBeEmpty();
    await expect(page.getByTestId('sources')).toBeHidden();
    const items = page.getByTestId('fallback-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0).getByTestId('fallback-section')).toHaveText('3 Booking travel');
    await expect(items.nth(0).getByTestId('fallback-file')).toHaveText('travel-policy.pdf');
    await expect(items.nth(0).getByTestId('fallback-page')).toHaveText('Pages 2 to 3');
    await expect(items.nth(1).getByTestId('fallback-section')).toHaveText('2 Expense claims');
    await expect(items.nth(1).getByTestId('fallback-page')).toHaveText('Page 6');
    expect(requests.vector[0]).toEqual({ query: 'Can I fly business class?', topN: 8, scoreThreshold: 0 });
  });

  test('the fallback without section metadata shows file names, and says so when nothing matches', async ({ page }) => {
    let results = [chunk({ id: 'a', text: '1 Annual leave\nEvery employee receives 27 days.' })].map(asVectorResult);
    await mockLibrary(page, { stream: () => refusalEvents(REFUSAL_TEXT), vector: () => results });
    await page.goto(pageUrl());
    await page.getByTestId('query').fill('parking rules');
    await page.getByTestId('query').press('Enter');
    const item = page.getByTestId('fallback-item');
    await expect(item).toHaveCount(1);
    await expect(item.getByTestId('fallback-section')).toHaveText('handbook.pdf');
    await expect(item.getByTestId('fallback-file')).toBeHidden();
    await expect(item.getByTestId('fallback-preview')).toHaveText('1 Annual leave Every employee receives 27 days.');

    results = [];
    await page.getByTestId('query').fill('weather tomorrow');
    await page.getByTestId('query').press('Enter');
    await expect(page.getByTestId('fallback-item')).toHaveCount(0);
    await expect(page.getByTestId('fallback')).toContainText('No section in your documents matches this question.');
  });

  test('keyboard: Shift+Enter adds a line, Escape clears, recent questions re-ask', async ({ page }) => {
    const { requests } = await mockLibrary(page, {
      recent: ['What is the notice period?'],
      stream: (body) => answerEvents(`Answer to ${body.message}`, [chunk({ id: 'a', text: 'Body' })]),
    });
    await page.goto(pageUrl());
    await expect(page.getByTestId('recent-item')).toHaveText(['What is the notice period?']);

    const query = page.getByTestId('query');
    await query.fill('first line');
    await query.press('Shift+Enter');
    await query.pressSequentially('second line');
    await expect(query).toHaveValue('first line\nsecond line');
    expect(requests.stream).toHaveLength(0);

    await query.press('Enter');
    await expect(page.getByTestId('answer-text')).toHaveText('Answer to first line second line');
    await expect(page.getByTestId('recent-item').first()).toHaveText('first line\nsecond line');

    await page.keyboard.press('Escape');
    await expect(query).toHaveValue('');
    await expect(page.getByTestId('answer')).toBeHidden();

    await page.getByTestId('recent-item').filter({ hasText: 'notice period' }).click();
    await expect(page.getByTestId('answer-text')).toHaveText('Answer to What is the notice period?');
    await expect(query).toHaveValue('What is the notice period?');
  });

  test('the shell can report indexing state', async ({ page }) => {
    await mockLibrary(page);
    await page.goto(pageUrl());
    await expect(page.getByTestId('status-state')).toHaveAttribute('data-state', 'ready');
    await page.evaluate(() => window.askfiles.setIndexStatus({ state: 'indexing', pending: 4 }));
    await expect(page.getByTestId('status-state')).toHaveText('Indexing, 4 left');
    await page.evaluate(() => window.askfiles.setIndexStatus({ state: 'idle' }));
    await expect(page.getByTestId('status-state')).toHaveText('Up to date');
  });

  test('a stream abort shows the error instead of an answer', async ({ page }) => {
    await mockLibrary(page, {
      stream: () => [
        { uuid: 'u', type: 'abort', textResponse: null, sources: [], close: true, error: 'model not found' },
      ],
    });
    await page.goto(pageUrl());
    await page.getByTestId('query').fill(QUESTION);
    await page.getByTestId('query').press('Enter');
    await expect(page.getByTestId('error')).toHaveText('Something went wrong while answering: model not found');
    await expect(page.getByTestId('fallback')).toBeHidden();
  });

  test('recent questions survive a reload', async ({ page }) => {
    await mockLibrary(page, { stream: () => answerEvents('ok', [chunk({ id: 'a', text: 'Body' })]) });
    await page.goto(pageUrl());
    await page.getByTestId('query').fill('Where is the parking garage?');
    await page.getByTestId('query').press('Enter');
    await expect(page.getByTestId('answer-text')).toHaveText('ok');
    await page.reload();
    await expect(page.getByTestId('recent-item')).toHaveText(['Where is the parking garage?']);
  });

  test('the shell can fill in section details for the fallback list', async ({ page }) => {
    await mockLibrary(page, {
      stream: () => refusalEvents(REFUSAL_TEXT),
      vector: () => [asVectorResult(chunk({ id: 'v1', text: 'Train travel is booked in second class.' }))],
    });
    await page.addInitScript((base) => {
      window.shellConfig = {
        baseUrl: base,
        apiKey: 'test-key',
        workspace: 'lib',
        resolveSources: async (sources) =>
          sources.map((s) =>
            s.id === 'v1' ? { ...s, sectionTitle: '3 Booking travel', sectionIndex: 3, page: 2 } : s,
          ),
      };
    }, 'http://127.0.0.1:1');
    await page.goto(`${process.env.ASKFILES_PAGE_URL}/search/index.html`);
    await page.getByTestId('query').fill('Can I fly business class?');
    await page.getByTestId('query').press('Enter');
    const item = page.getByTestId('fallback-item');
    await expect(item.getByTestId('fallback-section')).toHaveText('3 Booking travel');
    await expect(item.getByTestId('fallback-file')).toHaveText('handbook.pdf');
    await expect(item.getByTestId('fallback-page')).toHaveText('Page 2');
  });

  test('reads config from window.shellConfig before query parameters', async ({ page }) => {
    await mockLibrary(page, { documents: 1 });
    await page.addInitScript((base) => {
      window.shellConfig = { baseUrl: base, apiKey: 'test-key', workspace: 'lib', folder: '/Users/shell/Docs' };
    }, 'http://127.0.0.1:1');
    await page.goto(`${process.env.ASKFILES_PAGE_URL}/search/index.html?folder=ignored`);
    await expect(page.getByTestId('status-folder')).toHaveText('/Users/shell/Docs');
    await expect(page.getByTestId('status-count')).toHaveText('1 document indexed');
  });
});
