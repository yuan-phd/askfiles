// Added files linked instead of copied: the Replace or Keep both dialog, Check for updates in the
// top bar, the library menu's source rows, and the Sources section of the Library page. Against
// the Ask page with a stub of the preload bridge; every library and path here is invented.
import { test, expect } from '@playwright/test';
import { mockLibrary, pageUrl, watcherStatus } from './mocks.js';
import { folderSource, library, stubLibraries } from './libraries-stub.mjs';

const calls = (page) => page.evaluate(() => window.__libCalls.filter((c) => c[0] !== 'list'));

const folder = (n, name = `Project ${n}`) => folderSource(`/Users/sam/Work/${name}`, { id: `folder-${n}`, name });
const file = (n, dir = `Inbox ${n % 200}`) => ({
  id: `file-${n}`,
  kind: 'file',
  path: `/Users/sam/${dir}/memo-${String(n).padStart(3, '0')}.md`,
  name: `memo-${String(n).padStart(3, '0')}.md`,
  available: true,
});
const range = (n, make) => Array.from({ length: n }, (_, i) => make(i + 1));

function libraries(sources, over = {}) {
  return { current: 'all-files', libraries: [library({ indexed: sources.length, sources, ...over })] };
}

/** The browse bridge the Library page reads: no documents, so the page shows its Sources section. */
async function stubBrowse(page) {
  await page.addInitScript(() => {
    window.askfiles = {
      ...(window.askfiles || {}),
      browse: {
        documents: async () => [],
        document: async () => null,
        headings: async () => [],
        search: async (query) => ({ query, terms: [], total: 0, groups: [], truncated: false }),
      },
    };
  });
}

async function open(page, options) {
  await mockLibrary(page, { documents: 5 });
  await stubBrowse(page);
  await stubLibraries(page, options);
  await page.goto(pageUrl());
  await expect(page.getByTestId('library-name')).not.toHaveText('Library');
}

const conflict = {
  path: '/Users/sam/Desktop/minutes.md',
  name: 'minutes.md',
  existing: { id: 'file-1', path: '/Users/sam/Archive/Minutes.md', kind: 'file' },
};
const asking = { added: 0, skipped: [], already: [], conflicts: [conflict], kept: [] };

test.describe('add files', () => {
  test('a file named like an added file asks Replace or Keep both; Replace sends the answer', async ({ page }) => {
    await open(page, {
      libraries: libraries([file(1)]),
      addResult: asking,
      resolvedResult: { added: 1, skipped: [], already: [], conflicts: [], kept: [] },
    });
    await page.getByTestId('add-button').click();
    await expect(page.getByTestId('add-files')).toContainText('Links them; AskFiles follows their changes');
    await page.getByTestId('add-files').click();
    const dialog = page.getByTestId('replace-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('replace-text')).toHaveText(
      'A file named minutes.md is already in this library (/Users/sam/Archive/Minutes.md). Replace it, or keep both?',
    );
    await page.getByTestId('replace-confirm').click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => calls(page))
      .toEqual([
        ['addFiles'],
        ['addPaths', [conflict.path], { [conflict.path]: { action: 'replace', replaces: 'file-1' } }],
      ]);
    await expect(page.getByTestId('add-result')).toHaveText('Added 1 item.');
  });

  test('Keep both adds it as another document; Cancel adds nothing', async ({ page }) => {
    await open(page, {
      libraries: libraries([file(1)]),
      addResult: asking,
      resolvedResult: { added: 1, skipped: [], already: [], conflicts: [], kept: [] },
    });
    await page.getByTestId('add-button').click();
    await page.getByTestId('add-files').click();
    await page.getByTestId('replace-keep').click();
    await expect(page.getByTestId('add-result')).toHaveText('Added 1 item.');

    await page.getByTestId('add-button').click();
    await page.getByTestId('add-files').click();
    await expect(page.getByTestId('replace-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('replace-dialog')).toBeHidden();
    await expect(page.getByTestId('add-result')).toHaveText('Nothing was added.');
    expect(await calls(page)).toEqual([
      ['addFiles'],
      ['addPaths', [conflict.path], { [conflict.path]: { action: 'keep' } }],
      ['addFiles'],
    ]);
  });

  test('dropped files ask too, and a name from a linked folder is added with a note', async ({ page }) => {
    await open(page, {
      libraries: libraries([folder(1), file(1)]),
      addResult: {
        added: 1,
        skipped: [],
        already: [],
        conflicts: [{ ...conflict, path: '/dropped/minutes.md' }],
        kept: [{ name: 'report.md', path: '/Users/sam/Work/Project 1/Report.md' }],
      },
      resolvedResult: { added: 1, skipped: [], already: [], conflicts: [], kept: [] },
    });
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'minutes.md'));
      dt.items.add(new File(['y'], 'report.md'));
      document
        .querySelector('main')
        .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.getByTestId('replace-keep').click();
    await expect(page.getByTestId('add-result')).toHaveText(
      'Added 2 items. A file named report.md is already in this library (/Users/sam/Work/Project 1/Report.md); both will be kept.',
    );
  });

  test('adding a file already in the library says it is kept up to date', async ({ page }) => {
    await open(page, {
      libraries: libraries([file(1)]),
      addResult: { added: 0, skipped: [], already: ['memo-001.md'], conflicts: [], kept: [] },
    });
    await page.getByTestId('add-button').click();
    await page.getByTestId('add-files').click();
    await expect(page.getByTestId('add-result')).toHaveText('Already in this library; it is kept up to date.');
    await expect(page.getByTestId('replace-dialog')).toBeHidden();
  });
});

test.describe('check for updates', () => {
  test('the control says Checking, then Up to date', async ({ page }) => {
    await open(page, {
      libraries: libraries([folder(1)]),
      status: watcherStatus({ indexed: 4 }),
      checkGate: true,
      checkResult: watcherStatus({ indexed: 4 }),
    });
    const control = page.getByTestId('check-updates');
    await expect(control).toHaveAttribute('title', 'Check for updates');
    await expect(control).toHaveAccessibleName('Check for updates');
    await expect(page.getByTestId('status-state')).toHaveText('Up to date');
    await control.click();
    await expect(page.getByTestId('status-state')).toHaveText('Checking…');
    await expect(page.getByTestId('status-state')).toHaveAttribute('data-state', 'checking');
    await expect(control).toBeDisabled();
    await page.evaluate(() => window.__finishCheck());
    await expect(page.getByTestId('status-state')).toHaveText('Up to date');
    await expect(control).toBeEnabled();
    expect(await calls(page)).toEqual([['checkUpdates']]);
  });

  test('a changed file found by the check shows the usual indexing status', async ({ page }) => {
    await open(page, {
      libraries: libraries([folder(1)]),
      status: watcherStatus({ indexed: 4 }),
      checkResult: watcherStatus({ state: 'working', pending: 1, indexed: 4 }),
    });
    await page.getByTestId('check-updates').click();
    await expect(page.getByTestId('status-state')).toHaveText('Checking…');
    await expect(page.getByTestId('status-state')).toHaveText('Indexing, 1 left');
    // The watcher's own events then take over, as for any change.
    await page.evaluate((s) => window.__watcher(s), watcherStatus({ indexed: 4 }));
    await expect(page.getByTestId('status-state')).toHaveText('Up to date');
  });
});

test.describe('library menu sources', () => {
  test('3 folders and 900 files: the folders, two files, then one row with Manage', async ({ page }) => {
    await open(page, { libraries: libraries([...range(3, folder), ...range(900, file)]) });
    await page.getByTestId('library-switcher').click();
    const items = page.getByTestId('source-item');
    await expect(items).toHaveCount(5);
    await expect(items.locator('.source-name')).toHaveText([
      'Project 1',
      'Project 2',
      'Project 3',
      'memo-001.md',
      'memo-002.md',
    ]);
    await expect(items.locator('.source-kind')).toHaveText(['Folder', 'Folder', 'Folder', 'File', 'File']);
    await expect(page.getByTestId('source-more')).toHaveText('898 more files · Manage');
  });

  test('8 folders: every folder and no single file', async ({ page }) => {
    await open(page, { libraries: libraries([...range(8, folder), ...range(900, file)]) });
    await page.getByTestId('library-switcher').click();
    await expect(page.getByTestId('source-item')).toHaveCount(8);
    await expect(page.getByTestId('source-item').locator('.source-kind')).toHaveText(Array(8).fill('Folder'));
    await expect(page.getByTestId('source-more')).toHaveText('900 more files · Manage');
  });

  test('everything that fits is listed without a Manage row', async ({ page }) => {
    await open(page, { libraries: libraries([...range(3, folder), ...range(2, file)]) });
    await page.getByTestId('library-switcher').click();
    await expect(page.getByTestId('source-item')).toHaveCount(5);
    await expect(page.getByTestId('source-more')).toHaveCount(0);
  });

  test('Manage opens the Library page in Browse at its Sources section', async ({ page }) => {
    await open(page, { libraries: libraries([...range(3, folder), ...range(900, file)]) });
    await page.getByTestId('library-switcher').click();
    await page.getByTestId('source-manage').click();
    await expect(page.getByTestId('library-menu')).toBeHidden();
    await expect(page.getByTestId('view-browse')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('library')).toBeVisible();
    await expect(page.getByTestId('library-sources')).toBeInViewport();
    await expect(page.getByTestId('library-sources-search')).toBeFocused();
    await expect(page.getByTestId('library-sources-item')).toHaveCount(903);
    await expect(page.getByTestId('library-sources-count')).toHaveText('3 folders, 900 files');
  });
});

test.describe('Sources section', () => {
  const sources = [
    folder(1, 'Contracts'),
    file(1, 'Desktop'),
    { ...file(2, 'Downloads'), available: false },
    { id: 'file:handbook.md', kind: 'copy', path: '/data/files/handbook.md', name: 'handbook.md', available: true },
  ];

  test('lists every source with type and path, searches, and removes one', async ({ page }) => {
    await open(page, { libraries: libraries(sources) });
    await page.getByTestId('view-browse').click();
    const items = page.getByTestId('library-sources-item');
    await expect(items).toHaveCount(4);
    await expect(page.getByTestId('library-sources-kind')).toHaveText([
      'Folder',
      'File',
      'File, original missing',
      'Copy',
    ]);
    await expect(page.getByTestId('library-sources-path').first()).toHaveText('/Users/sam/Work/Contracts');
    await expect(page.getByTestId('library-sources-missing')).toHaveText(
      '1 original is missing. It leaves the library once AskFiles has checked it.',
    );
    await expect(page.getByTestId('library-sources-count')).toHaveText('1 folder, 2 files, 1 copy');

    await page.getByTestId('library-sources-search').fill('DOWNLOADS');
    await expect(items).toHaveCount(1);
    await expect(items).toContainText('memo-002.md');
    await expect(page.getByTestId('library-sources-count')).toHaveText('1 of 4 shown');
    await page.getByTestId('library-sources-search').fill('nothing like this');
    await expect(items).toHaveCount(0);
    await expect(page.getByTestId('library-sources-empty')).toBeVisible();
    await page.getByTestId('library-sources-search').fill('');

    await items.filter({ hasText: 'handbook.md' }).getByTestId('library-sources-remove').click();
    await expect.poll(() => calls(page)).toEqual([['removeSource', 'file:handbook.md']]);
    // The main process answers with the new view; the list follows it.
    await page.evaluate((v) => window.__librariesEvent(v), libraries(sources.slice(0, 3)));
    await expect(items).toHaveCount(3);
    await expect(page.getByTestId('source-item')).toHaveCount(3);
  });

  test('a refused removal shows its reason', async ({ page }) => {
    await open(page, { libraries: libraries(sources), fail: { removeSource: 'No such file in this library.' } });
    await page.getByTestId('view-browse').click();
    await page.getByTestId('library-sources-remove').first().click();
    await expect(page.getByTestId('library-sources-error')).toHaveText('No such file in this library.');
  });
});

// Screenshots for the PR, invented libraries only:
//   SCREENSHOT_DIR=docs/screenshots/add-files npx playwright test add-files -g screenshot
const shots = process.env.SCREENSHOT_DIR;
for (const scheme of ['light', 'dark']) {
  test(`add files screenshot ${scheme}`, async ({ page }) => {
    test.skip(!shots, 'SCREENSHOT_DIR not set');
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, {
      libraries: libraries([...range(3, folder), ...range(900, file)]),
      status: watcherStatus({ indexed: 903 }),
      addResult: asking,
      checkGate: true,
    });
    await page.getByTestId('library-switcher').click();
    await page.screenshot({ path: `${shots}/menu-3-folders-900-files-${scheme}.png` });
    await page.keyboard.press('Escape');

    await page.getByTestId('add-button').click();
    await page.getByTestId('add-files').click();
    await expect(page.getByTestId('replace-dialog')).toBeVisible();
    await page.screenshot({ path: `${shots}/replace-dialog-${scheme}.png` });
    await page.getByTestId('replace-cancel').click();

    await page.getByTestId('check-updates').click();
    await expect(page.getByTestId('status-state')).toHaveText('Checking…');
    await page.getByTestId('status-bar').screenshot({ path: `${shots}/checking-${scheme}.png` });
    await page.evaluate(() => window.__finishCheck());
    await expect(page.getByTestId('status-state')).toHaveText('Up to date');
    await page.getByTestId('check-updates').hover();
    await page.getByTestId('status-bar').screenshot({ path: `${shots}/up-to-date-${scheme}.png` });

    const eight = await page.context().newPage();
    await eight.emulateMedia({ colorScheme: scheme });
    await open(eight, { libraries: libraries([...range(8, folder), ...range(900, file)]) });
    await eight.getByTestId('library-switcher').click();
    await eight.screenshot({ path: `${shots}/menu-8-folders-${scheme}.png` });

    const manage = await page.context().newPage();
    await manage.emulateMedia({ colorScheme: scheme });
    await open(manage, {
      libraries: libraries([
        folder(1, 'Contracts'),
        folder(2, 'Minutes'),
        file(1, 'Desktop'),
        { ...file(2, 'Downloads'), available: false },
        file(3, 'Desktop'),
        { id: 'file:handbook.md', kind: 'copy', path: '/data/files/handbook.md', name: 'handbook.md', available: true },
      ]),
    });
    await manage.getByTestId('view-browse').click();
    await manage.getByTestId('library-sources').scrollIntoViewIfNeeded();
    await manage.screenshot({ path: `${shots}/sources-${scheme}.png` });
    await manage.getByTestId('library-sources-search').fill('desktop');
    await manage.screenshot({ path: `${shots}/sources-search-${scheme}.png` });
  });
}
