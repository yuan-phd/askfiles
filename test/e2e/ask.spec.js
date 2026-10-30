import { test, expect } from '@playwright/test';
import { mockLibrary, pageUrl, stubBridge, stubAnswer, watcherStatus, card, answerRun, partsOf } from './mocks.js';

const QUESTION = 'How many days of annual leave do employees get?';

const LEAVE = card(1, {
  file: 'handbook.pdf',
  title: 'Annual leave',
  path: ['Employee handbook', 'Leave', 'Annual leave'],
  pageStart: 4,
  pageEnd: 5,
  pageLabel: 'iv',
  passage: 'Employees get 27 days of paid annual leave per year.',
});
const CARRY = card(2, {
  file: 'leave-policy.docx',
  url: 'file:///library/leave-policy.docx',
  documentId: 'doc-policy',
  sectionIndex: 7,
  title: 'Carry-over',
  path: ['Carry-over'],
  pageStart: null,
  pageEnd: null,
  passage: 'Unused days can be carried over until March.',
});
const PARKING = card(3, { title: 'Parking', path: ['Facilities', 'Parking'], passage: 'Parking is free.' });

/** The answer cites [2] first, then [1]; [3] is selected but not cited. */
const ANSWERED = answerRun({
  sources: [LEAVE, CARRY, PARKING],
  // The citation [2] of the first sentence arrives split over two deltas, as the pipeline holds it
  // back until it closes and then sends it whole.
  deltas: [
    partsOf('Unused days carry over until March '),
    partsOf('[2]. Employees get 27 days a year [1]. '),
    partsOf('Ask your manager first.'),
  ],
  result: {
    text: 'Unused days carry over until March [2]. Employees get 27 days a year [1]. Ask your manager first.',
    claims: [
      { text: 'Unused days carry over until March . ', citations: [2], unsupported: false },
      { text: 'Employees get 27 days a year . ', citations: [1], unsupported: false },
      { text: 'Ask your manager first.', citations: [], unsupported: true },
    ],
    cited: [CARRY, LEAVE],
    considered: [PARKING],
  },
});

async function open(page, { runs = { [QUESTION]: ANSWERED }, developer, status, recent } = {}) {
  await mockLibrary(page, { recent });
  await stubBridge(page, { status });
  await stubAnswer(page, { runs, developer });
  await page.goto(pageUrl());
}

async function askQuestion(page, q = QUESTION) {
  await page.getByTestId('query').fill(q);
  await page.getByTestId('query').press('Enter');
}

test.describe('Ask page with the answer pipeline stubbed', () => {
  test('streams the answer with citations, cards in citation order and the other sections collapsed', async ({
    page,
  }) => {
    await open(page);
    await askQuestion(page);
    await expect(page.getByTestId('result-question')).toHaveText(QUESTION);

    const cards = page.getByTestId('sources').getByTestId('source-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.getByTestId('source-number')).toHaveText(['[2]', '[1]']);
    await expect(cards.getByTestId('source-file')).toHaveText(['leave-policy.docx', 'handbook.pdf']);
    await expect(cards.nth(1).getByTestId('source-section')).toHaveText('Employee handbook > Leave > Annual leave');
    await expect(cards.nth(1).getByTestId('source-page')).toHaveText('Pages 4 to 5 (printed iv)');
    await expect(cards.nth(0).getByTestId('source-page')).toBeHidden();
    await expect(cards.nth(1).getByTestId('source-passage')).toHaveText(LEAVE.passage);

    // The citation markers in the text, in the order written.
    await expect(page.getByTestId('answer-text').getByTestId('cite')).toHaveText(['[2]', '[1]']);
    await expect(page.getByTestId('claim-unsupported')).toHaveText('Ask your manager first.');
    await expect(page.getByTestId('answer-note')).toBeVisible();

    const considered = page.getByTestId('considered');
    await expect(considered).toBeVisible();
    await expect(considered).not.toHaveAttribute('open', '');
    await expect(considered.getByTestId('source-card')).toBeHidden();
    await considered.locator('summary').click();
    await expect(considered.getByTestId('source-card')).toHaveCount(1);
    await expect(considered.getByTestId('source-section')).toHaveText('Facilities > Parking');
    await expect(considered.getByTestId('source-number')).toBeHidden();

    await expect(page.getByTestId('answer')).toHaveAttribute('aria-busy', 'false');
    expect(await page.evaluate(() => window.__answerCalls)).toEqual([['ask', QUESTION]]);
  });

  test('shows the streamed text with citations before the answer is done', async ({ page }) => {
    // A run that never finishes: only the stages, the sources and one delta.
    const partial = ANSWERED.slice(0, 4);
    await open(page, { runs: { [QUESTION]: partial } });
    await askQuestion(page);
    await expect(page.getByTestId('answer-text')).toHaveText('Unused days carry over until March ');
    await expect(page.getByTestId('answer')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('submit')).toBeDisabled();
  });

  test('the not-found marker shows the nothing-found state with the nearest sections', async ({ page }) => {
    const run = answerRun({
      sources: [LEAVE],
      result: { notFound: true, text: 'NOT_IN_SOURCES', nearest: [PARKING, CARRY] },
    });
    await open(page, { runs: { 'Can I fly business class?': run } });
    await askQuestion(page, 'Can I fly business class?');
    await expect(page.getByTestId('fallback')).toBeVisible();
    const items = page.getByTestId('fallback-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0).getByTestId('fallback-section')).toHaveText('Facilities > Parking');
    await expect(items.nth(0).getByTestId('fallback-file')).toHaveText('handbook.pdf');
    await expect(items.nth(0).getByTestId('fallback-page')).toHaveText('Page 3');
    await expect(items.nth(1).getByTestId('fallback-page')).toBeHidden();
    await expect(page.getByTestId('answer-text')).toBeEmpty();
    await expect(page.getByTestId('sources')).toBeHidden();
  });

  test('an error event shows the error instead of an answer', async ({ page }) => {
    await open(page, {
      runs: {
        [QUESTION]: [
          { type: 'stage', stage: 'retrieving' },
          { type: 'error', message: 'model not found' },
        ],
      },
    });
    await askQuestion(page);
    await expect(page.getByTestId('error')).toHaveText('Something went wrong while answering: model not found');
    await expect(page.getByTestId('fallback')).toBeHidden();
    await expect(page.getByTestId('submit')).toBeEnabled();
  });

  test('keyboard: Shift+Enter adds a line, Escape clears, recent questions re-ask', async ({ page }) => {
    const simple = (q) =>
      answerRun({
        sources: [LEAVE],
        deltas: [partsOf(`Answer to ${q} [1]`)],
        result: { cited: [LEAVE], claims: [{ text: `Answer to ${q} `, citations: [1], unsupported: false }] },
      });
    const runs = { 'first line\nsecond line': simple('first'), 'What is the notice period?': simple('notice') };
    await open(page, { runs, recent: ['What is the notice period?'] });
    await expect(page.getByTestId('recent-item')).toHaveText(['What is the notice period?']);

    const query = page.getByTestId('query');
    await query.fill('first line');
    await query.press('Shift+Enter');
    await query.pressSequentially('second line');
    await expect(query).toHaveValue('first line\nsecond line');
    expect(await page.evaluate(() => window.__answerCalls)).toEqual([]);

    await query.press('Enter');
    await expect(page.getByTestId('answer-text')).toHaveText('Answer to first [1]');
    await expect(page.getByTestId('recent-item').first()).toHaveText('first line\nsecond line');

    await page.keyboard.press('Escape');
    await expect(query).toHaveValue('');
    await expect(page.getByTestId('answer')).toBeHidden();

    await page.getByTestId('recent-item').filter({ hasText: 'notice period' }).click();
    await expect(page.getByTestId('answer-text')).toHaveText('Answer to notice [1]');
    await expect(query).toHaveValue('What is the notice period?');
  });

  test('recent questions survive a reload', async ({ page }) => {
    await open(page);
    await askQuestion(page);
    await expect(page.getByTestId('sources').getByTestId('source-card')).toHaveCount(2);
    await page.reload();
    await expect(page.getByTestId('recent-item')).toHaveText([QUESTION]);
  });

  test('the status bar follows the folder watcher through the bridge', async ({ page }) => {
    await mockLibrary(page, { documents: 40 });
    await stubBridge(page, { status: watcherStatus({ state: 'working', pending: 4, indexed: 10 }) });
    await page.goto(pageUrl());
    await expect(page.getByTestId('status-state')).toHaveText('Indexing, 4 left');
    // Files from the watcher, not the 40 section documents of the workspace.
    await expect(page.getByTestId('status-count')).toHaveText('10 documents indexed');
    await expect(page.getByTestId('status-folder')).toHaveText('/Users/anna/Documents/HR');
    await expect
      .poll(() => page.evaluate(() => window.__bridgeCalls))
      .toEqual([['pageReady', { page: 'ask', connected: true, documents: 40 }]]);
    await page.evaluate(
      (s) => window.__watcher(s),
      watcherStatus({ state: 'stopped', error: 'The folder /Users/anna/Documents/HR cannot be read: ENOENT' }),
    );
    await expect(page.getByTestId('status-state')).toHaveText('Folder not available');
  });

  test('Open file sends the card metadata and says so when the file is gone', async ({ page }) => {
    await mockLibrary(page);
    await stubAnswer(page, { runs: { [QUESTION]: ANSWERED } });
    await page.addInitScript((base) => {
      window.__opened = [];
      window.shellConfig = {
        baseUrl: base,
        apiKey: 'test-key',
        workspace: 'lib',
        openSource: async (detail) => {
          window.__opened.push(detail);
          return false;
        },
      };
    }, 'http://127.0.0.1:1');
    await page.goto(`${process.env.ASKFILES_PAGE_URL}/ask/index.html`);
    await askQuestion(page);
    await page.getByTestId('sources').getByTestId('source-open').nth(1).click();
    await expect(page.getByTestId('error')).toHaveText('handbook.pdf is no longer in your documents folder.');
    expect(await page.evaluate(() => window.__opened)).toEqual([
      {
        title: 'handbook.pdf',
        url: 'file:///library/handbook.pdf',
        sectionTitle: 'Annual leave',
        sectionIndex: 1,
        page: 4,
      },
    ]);
  });

  test('without the app bridge the page says answers need the app', async ({ page }) => {
    await mockLibrary(page);
    await page.goto(pageUrl());
    await askQuestion(page);
    await expect(page.getByTestId('error')).toHaveText(
      'Answers need the AskFiles app; this page is open in a plain browser.',
    );
  });

  test('reads config from window.shellConfig before query parameters', async ({ page }) => {
    await mockLibrary(page, { documents: 1 });
    await page.addInitScript((base) => {
      window.shellConfig = { baseUrl: base, apiKey: 'test-key', workspace: 'lib', folder: '/Users/shell/Docs' };
    }, 'http://127.0.0.1:1');
    await page.goto(`${process.env.ASKFILES_PAGE_URL}/ask/index.html?folder=ignored`);
    await expect(page.getByTestId('status-folder')).toHaveText('/Users/shell/Docs');
    await expect(page.getByTestId('status-count')).toHaveText('1 document indexed');
  });
});

test.describe('developer panel', () => {
  const trace = {
    question: QUESTION,
    scope: 'balanced',
    terms: [{ text: 'annual leave', kind: 'pair', df: 2 }],
    vector: [
      { rank: 1, file: 'handbook.pdf', section: 'doc-handbook#1', score: 0.61, preview: 'Employees get 27 days' },
    ],
    keyword: [{ rank: 1, section: 'doc-handbook#1', score: 4.2, terms: ['annual leave'] }],
    fused: [{ key: 'doc-handbook#1', score: 0.0328, vectorRank: 1, keywordRank: 1 }],
    candidates: [
      {
        key: 'doc-handbook#1',
        file: 'handbook.pdf',
        sectionIndex: 1,
        path: ['Leave', 'Annual leave'],
        rerank: 0.97,
        selected: true,
        dropped: null,
        pageStart: 4,
      },
      {
        key: 'doc-handbook#3',
        file: 'handbook.pdf',
        sectionIndex: 3,
        path: ['Facilities', 'Parking'],
        rerank: 0.02,
        selected: false,
        dropped: 'below-floor',
        pageStart: 9,
      },
    ],
    bypassReason: null,
    floor: 0.1,
    count: 3,
    budgetTokens: 6656,
    usedTokens: 120,
    timings: { vectorMs: 40, keywordMs: 3, rerankMs: 600 },
  };

  test('is hidden without developer mode', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('dev-panel')).toBeHidden();
  });

  test('shows every stage of the last question, applies live controls and saves an eval case', async ({ page }) => {
    const run = [{ type: 'trace', trace }, ...ANSWERED];
    await open(page, { runs: { [QUESTION]: run }, developer: { enabled: true, overrides: {}, trace: null } });
    await expect(page.getByTestId('dev-panel')).toBeVisible();

    await page.getByTestId('dev-count').fill('2');
    await page.getByTestId('dev-floor').fill('0.35');
    await page.getByTestId('dev-apply').click();
    await expect(page.getByTestId('dev-status')).toHaveText('Next question: section count 2, rerank floor 0.35');

    await askQuestion(page);
    const rows = page.getByTestId('dev-candidate');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('0.970');
    await expect(rows.nth(1)).toContainText('below-floor');
    await expect(page.getByTestId('dev-trace')).toContainText('annual leave [2]');
    await expect(page.getByTestId('dev-save')).toBeDisabled();

    await rows.nth(1).click();
    await expect(page.getByTestId('dev-expected')).toHaveText('Expected: handbook.pdf, Facilities > Parking');
    await page.getByTestId('dev-save').click();
    await expect(page.getByTestId('dev-status')).toHaveText('Saved case-1 to /data/eval-questions.csv');
    expect(await page.evaluate(() => window.__answerCalls)).toEqual([
      ['setOverrides', { sectionCount: 2, rerankFloor: 0.35 }],
      ['ask', QUESTION],
      ['saveCase', { question: QUESTION, file: 'handbook.pdf', path: ['Facilities', 'Parking'], pageStart: 9 }],
    ]);
  });
});
