// Captures the page states for the PR in light and dark mode. Runs only with SCREENSHOT_DIR set:
//   SCREENSHOT_DIR=docs/screenshots/search npx playwright test screenshots
import { test } from '@playwright/test';
import { mockLibrary, pageUrl, stubBridge, stubAnswer, watcherStatus, card, answerRun, partsOf } from './mocks.js';

const dir = process.env.SCREENSHOT_DIR;
const recent = ['Who approves travel over 500 euros?', 'What is the notice period?', '年假可以结转吗?'];
const LEAVE = card(1, {
  title: '1 Annual leave',
  path: ['Employee handbook', '1 Annual leave'],
  pageStart: 4,
  pageEnd: 5,
  passage:
    'Every employee of Northwind receives 27 days of paid annual leave per year. Unused leave can be carried over until the end of March of the next year.',
});
const ZH = card(2, {
  file: '员工手册-2026.pdf',
  url: 'file:///library/员工手册-2026.pdf',
  title: '第三章 休假',
  path: ['第三章 休假'],
  pageStart: 12,
  pageEnd: 12,
  passage: '每位员工每年享有二十七天带薪年假。未使用的年假可结转至次年三月底。',
});
const TRAVEL = card(3, {
  file: 'travel-policy.pdf',
  title: '3 Booking travel',
  path: ['Travel policy', '3 Booking travel'],
  pageStart: 2,
  pageEnd: 2,
  passage: 'Train travel is booked in second class unless the trip exceeds four hours.',
});
const EXPENSES = card(4, {
  title: '2 Expense claims',
  path: ['Employee handbook', '2 Expense claims'],
  pageStart: 6,
  pageEnd: 6,
  passage: 'Expense claims are submitted through the finance portal within 30 days.',
});
const ANSWER =
  'Employees receive 27 days of paid annual leave per year [1][2]. Unused days can be carried over until the end of March of the following year [1]. Plan leave early.';
const answered = answerRun({
  sources: [LEAVE, ZH, TRAVEL],
  deltas: [partsOf(ANSWER)],
  result: {
    claims: [
      { text: 'Employees receive 27 days of paid annual leave per year . ', citations: [1, 2], unsupported: false },
      {
        text: 'Unused days can be carried over until the end of March of the following year . ',
        citations: [1],
        unsupported: false,
      },
      { text: 'Plan leave early.', citations: [], unsupported: true },
    ],
    cited: [LEAVE, ZH],
    considered: [TRAVEL],
  },
});
const notFound = answerRun({
  sources: [],
  result: { notFound: true, skippedModel: true, nearest: [TRAVEL, EXPENSES, LEAVE] },
});

for (const scheme of ['light', 'dark']) {
  test(`screenshot answer ${scheme}`, async ({ page }) => {
    test.skip(!dir, 'SCREENSHOT_DIR not set');
    await page.emulateMedia({ colorScheme: scheme });
    await mockLibrary(page, { documents: 14, recent });
    await stubAnswer(page, { runs: { 'How many days of annual leave do I get?': answered } });
    await page.goto(pageUrl({ folder: '/Users/anna/Documents/HR' }));
    await page.getByTestId('query').fill('How many days of annual leave do I get?');
    await page.getByTestId('query').press('Enter');
    await page.getByTestId('sources').getByTestId('source-card').nth(1).waitFor();
    await page.screenshot({ path: `${dir}/answer-${scheme}.png`, fullPage: true });
  });

  test(`screenshot fallback ${scheme}`, async ({ page }) => {
    test.skip(!dir, 'SCREENSHOT_DIR not set');
    await page.emulateMedia({ colorScheme: scheme });
    await mockLibrary(page, { documents: 14, recent });
    await stubBridge(page, { status: watcherStatus({ state: 'working', pending: 3, indexed: 11 }) });
    await stubAnswer(page, { runs: { 'Can I fly business class?': notFound } });
    await page.goto(pageUrl({ folder: '/Users/anna/Documents/HR' }));
    await page.getByTestId('query').fill('Can I fly business class?');
    await page.getByTestId('query').press('Enter');
    await page.getByTestId('fallback-item').nth(2).waitFor();
    await page.screenshot({ path: `${dir}/fallback-${scheme}.png`, fullPage: true });
  });
}
