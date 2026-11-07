// The test build's pages (docs/test-build.md): the notice of the first start, the Test record part
// of Settings with Export test record, About, and Browse page events reaching the record. The test
// build's preload (src/main/test-record/preload.ts) is stood in for by window.askfilesTest and the
// same script tag it adds; without them the pages are the release build's.
import { test, expect } from '@playwright/test';
import { seedBrowse, stubBrowseBridge } from './browse-seed.mjs';
import { library, settingsView, stubLibraries } from './libraries-stub.mjs';
import { answerRun, card, mockLibrary, pageUrl, partsOf, stubAnswer, watcherStatus } from './mocks.js';

const url = (page) => `${process.env.ASKFILES_PAGE_URL}/${page}/index.html`;
const NOTICE =
  'This test build records your questions and actions on this computer only. Nothing is uploaded. ' +
  'You decide whether to export and share the record. Installing the regular version removes the record.';
const NOTICE_ZH =
  '此测试版只在这台电脑上记录您的问题和操作。不会上传任何内容。是否导出和分享这份记录由您决定。安装正式版会删除这份记录。';

/** window.askfilesTest as the test preload exposes it, with its calls in window.__testCalls. */
async function stubTestBuild(page, o = {}) {
  await page.addInitScript((o) => {
    const calls = [];
    const status = {
      paused: false,
      noticeShown: false,
      events: 3,
      questions: 2,
      file: '/data/test-record/record.jsonl',
      platform: 'darwin',
      ...o.status,
    };
    const call =
      (name, value) =>
      async (...args) => {
        calls.push([name, ...args]);
        if (o.fail?.[name]) throw new Error(o.fail[name]);
        return typeof value === 'function' ? value(...args) : value;
      };
    window.__testCalls = calls;
    window.askfilesTest = {
      status: call('status', () => ({ ...status })),
      noticeShown: call('noticeShown', () => Object.assign(status, { noticeShown: true })),
      pause: call('pause', (p) => Object.assign(status, { paused: p })),
      clear: call('clear', () => Object.assign(status, { events: 0, questions: 0 })),
      exportRecord: call('exportRecord', (mode) => ({
        file: `/Users/anna/Desktop/AskFiles test record ${mode === 'full' ? 'with answers' : 'questions only'} 2026-11-12 090000.jsonl`,
      })),
      record: call('record', true),
    };
    // What the preload does once the page has loaded.
    window.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = '/test-record/ui.js';
      document.head.append(s);
    });
  }, o);
}
const testCalls = (page, skip = ['status']) =>
  page.evaluate((skip) => window.__testCalls.filter((c) => !skip.includes(c[0])), skip);

const libs = { current: 'lib-1', libraries: [library({ id: 'lib-1', name: 'Work', isDefault: false })] };

test.describe('test build notice', () => {
  test('shows the notice once on the first start, and Continue is the only way on', async ({ page }) => {
    await stubLibraries(page, { settings: settingsView(), libraries: libs });
    await stubTestBuild(page);
    await page.goto(url('settings'));
    const notice = page.getByTestId('test-notice');
    await expect(notice).toBeVisible();
    await expect(notice.locator('h2')).toHaveText('This is a test build');
    await expect(page.getByTestId('test-notice-text')).toHaveText(NOTICE);
    await expect(notice.getByRole('button')).toHaveText(['Continue']);
    await page.keyboard.press('Escape');
    await expect(notice).toBeVisible();
    await page.getByTestId('test-notice-continue').click();
    await expect(notice).toHaveCount(0);
    expect(await testCalls(page)).toEqual([['noticeShown']]);
  });

  test('stays away once the notice was confirmed', async ({ page }) => {
    await stubLibraries(page, { settings: settingsView(), libraries: libs });
    await stubTestBuild(page, { status: { noticeShown: true } });
    await page.goto(url('settings'));
    await expect(page.getByTestId('test-record')).toBeVisible();
    await expect(page.getByTestId('test-notice')).toHaveCount(0);
  });

  test.describe('on a Chinese system', () => {
    test.use({ locale: 'zh-CN' });
    test('is in Chinese, as is the Settings part', async ({ page }) => {
      await stubLibraries(page, { settings: settingsView(), libraries: libs });
      await stubTestBuild(page);
      await page.goto(url('settings'));
      await expect(page.getByTestId('test-notice-text')).toHaveText(NOTICE_ZH);
      await expect(page.getByTestId('test-notice-continue')).toHaveText('继续');
      await page.getByTestId('test-notice-continue').click();
      await expect(page.getByTestId('test-record-notice')).toHaveText(NOTICE_ZH);
      await expect(page.getByTestId('test-record-export')).toHaveText('导出测试记录');
    });
  });

  test('shows on the first page of a first start too, the onboarding page', async ({ page }) => {
    await stubTestBuild(page);
    await page.goto(url('onboarding'));
    await expect(page.getByTestId('test-notice')).toBeVisible();
  });
});

test.describe('test record in Settings', () => {
  test.beforeEach(async ({ page }) => {
    await stubLibraries(page, { settings: settingsView(), libraries: libs });
  });

  test('has the notice next to Export test record, which offers two choices and saves to the Desktop', async ({
    page,
  }) => {
    await stubTestBuild(page, { status: { noticeShown: true } });
    await page.goto(url('settings'));
    const part = page.getByTestId('test-record');
    await expect(part.locator('legend')).toHaveText('Test record');
    await expect(page.getByTestId('test-record-notice')).toHaveText(NOTICE);
    await expect(part.getByRole('button')).toHaveText(['Export test record', 'Pause recording', 'Clear the record']);
    await expect(page.getByTestId('test-record-status')).toHaveText('2 questions and 1 other action recorded.');
    // The four settings stay as they are, with the part after them.
    await expect(page.locator('fieldset legend')).toHaveText([
      'Answer scope',
      'Answer model',
      'Context length',
      'Reindex this library',
      'Test record',
    ]);

    await page.getByTestId('test-record-export').click();
    const choice = page.getByTestId('test-export-choice');
    await expect(choice.getByRole('button')).toHaveText([
      'Cancel',
      'Questions only',
      'Questions with answers and sources',
    ]);
    await page.getByTestId('test-export-questions').click();
    await expect(choice).toHaveCount(0);
    await expect(page.getByTestId('test-record-status')).toHaveText(
      'Saved "AskFiles test record questions only 2026-11-12 090000.jsonl" on your Desktop and showed it in Finder.',
    );

    await page.getByTestId('test-record-export').click();
    await page.getByTestId('test-export-full').click();
    await expect(page.getByTestId('test-record-status')).toContainText('AskFiles test record with answers');

    await page.getByTestId('test-record-export').click();
    await page.getByTestId('test-export-cancel').click();
    expect(await testCalls(page)).toEqual([
      ['exportRecord', 'questions'],
      ['exportRecord', 'full'],
    ]);
  });

  test('pauses and resumes recording, and clears the record after asking', async ({ page }) => {
    await stubTestBuild(page, { status: { noticeShown: true } });
    await page.goto(url('settings'));
    await page.getByTestId('test-record-pause').click();
    await expect(page.getByTestId('test-record-pause')).toHaveText('Resume recording');
    await expect(page.getByTestId('test-record-status')).toHaveText(
      '2 questions and 1 other action recorded. Recording is paused.',
    );
    await page.getByTestId('test-record-pause').click();
    await expect(page.getByTestId('test-record-pause')).toHaveText('Pause recording');

    page.once('dialog', (d) => d.dismiss());
    await page.getByTestId('test-record-clear').click();
    page.once('dialog', (d) => {
      expect(d.message()).toBe('Delete everything recorded so far? This cannot be undone.');
      void d.accept();
    });
    await page.getByTestId('test-record-clear').click();
    await expect(page.getByTestId('test-record-status')).toHaveText('The record is empty.');
    expect(await testCalls(page)).toEqual([['pause', true], ['pause', false], ['clear']]);
  });

  test('shows the export in File Explorer on Windows', async ({ page }) => {
    await stubTestBuild(page, { status: { noticeShown: true, platform: 'win32' } });
    await page.goto(url('settings'));
    await page.getByTestId('test-record-export').click();
    await page.getByTestId('test-export-full').click();
    await expect(page.getByTestId('test-record-status')).toContainText(
      'on your Desktop and showed it in File Explorer.',
    );
  });

  test('says when an export fails', async ({ page }) => {
    await stubTestBuild(page, { status: { noticeShown: true }, fail: { exportRecord: 'the Desktop is not writable' } });
    await page.goto(url('settings'));
    await page.getByTestId('test-record-export').click();
    await page.getByTestId('test-export-full').click();
    await expect(page.getByTestId('test-record-status')).toHaveText('That did not work: the Desktop is not writable');
  });

  test('is not there in the release build', async ({ page }) => {
    await page.goto(url('settings'));
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('test-record')).toHaveCount(0);
    await expect(page.getByTestId('test-notice')).toHaveCount(0);
  });
});

test('About says it is a test build', async ({ page }) => {
  await page.addInitScript(() => {
    window.askfiles = { app: { info: async () => ({ name: 'AskFiles', version: '0.1.0' }) } };
  });
  await stubTestBuild(page, { status: { noticeShown: true } });
  await page.route('**/THIRD-PARTY-NOTICES', (route) => route.fulfill({ status: 200, body: 'notices' }));
  await page.goto(url('about'));
  await expect(page.getByTestId('test-build-note')).toHaveText(
    'Test build. It records your questions and actions on this computer only; see Settings, Test record.',
  );
  await expect(page.getByTestId('version')).toHaveText('Version 0.1.0');
});

test.describe('Browse pages in the record', () => {
  let seed;
  test.beforeAll(async () => {
    seed = await seedBrowse();
  });
  test.afterAll(() => seed?.cleanup());

  test('records each Browse page and the document opened', async ({ page }) => {
    await stubBrowseBridge(page, seed.index);
    await stubTestBuild(page, { status: { noticeShown: true } });
    await page.goto(url('browse'));
    await expect(page.getByTestId('library-item')).toHaveCount(6);
    await page.getByTestId('library-open').filter({ hasText: 'operations-manual.docx' }).click();
    await expect(page.getByTestId('doc-title')).toHaveText('operations-manual.docx');
    await page.getByTestId('browse-tab-find').click();
    await page.getByTestId('browse-tab-library').click();
    await expect
      .poll(() => testCalls(page))
      .toEqual([
        ['record', { type: 'browse', page: 'document', document: 'operations-manual.docx' }],
        ['record', { type: 'browse', page: 'find', document: null }],
        ['record', { type: 'browse', page: 'library', document: null }],
      ]);
  });

  test('records source card clicks and the switch from Ask to Browse', async ({ page }) => {
    const v2 = seed.index.listDocuments().find((d) => d.title === 'leave-policy-v2.md');
    const source = card(1, {
      file: 'leave-policy-v2.md',
      url: v2.url,
      documentId: v2.id,
      sectionIndex: 4,
      title: 'Parental leave',
      path: ['Leave', 'Parental leave'],
      pageStart: 3,
      pageEnd: 3,
      passage: 'Each parent may take 16 weeks of paid parental leave.',
    });
    const run = answerRun({
      sources: [source],
      deltas: [partsOf('Sixteen weeks.')],
      result: { claims: [{ text: 'Sixteen weeks.', citations: [1], unsupported: false }], cited: [source] },
    });
    await mockLibrary(page);
    await stubBrowseBridge(page, seed.index, { status: watcherStatus({ indexed: 6 }) });
    await stubAnswer(page, { runs: { 'How long is parental leave?': run } });
    await stubTestBuild(page, { status: { noticeShown: true } });
    await page.goto(pageUrl());
    await page.getByTestId('query').fill('How long is parental leave?');
    await page.getByTestId('query').press('Enter');
    await expect(page.getByTestId('answer-text')).toHaveText('Sixteen weeks.[1]');
    await page.getByTestId('view-browse').click();
    await page.getByTestId('view-search').click();
    await page.getByTestId('source-card').getByTestId('source-read').click();
    await expect(page.getByTestId('doc-title')).toHaveText('leave-policy-v2.md');
    await expect
      .poll(() => testCalls(page))
      .toEqual([
        ['record', { type: 'browse', page: 'library', document: null }],
        [
          'record',
          { type: 'source', action: 'read', file: 'leave-policy-v2.md', section: 'Leave > Parental leave', page: 3 },
        ],
        ['record', { type: 'browse', page: 'document', document: 'leave-policy-v2.md' }],
      ]);
  });
});
