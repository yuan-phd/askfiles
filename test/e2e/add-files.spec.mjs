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
  existing: [{ id: 'file-1', path: '/Users/sam/Archive/Minutes.md', kind: 'file' }],
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

test.describe('several files of one name', () => {
  const three = {
    path: '/Users/sam/Desktop/agenda.md',
    name: 'agenda.md',
    existing: [
      { id: 'file-1', path: '/Users/sam/Board/agenda.md', kind: 'file' },
      { id: 'file-2', path: '/Users/sam/Team/Agenda.md', kind: 'file' },
      { id: 'file:agenda.md', path: '/data/files/agenda.md', kind: 'copy' },
    ],
  };

  test('lists every file of that name with its path; Replace waits for a pick', async ({ page }) => {
    await open(page, {
      libraries: libraries([file(1)]),
      addResult: { added: 0, skipped: [], already: [], conflicts: [three], kept: [] },
      resolvedResult: { added: 1, skipped: [], already: [], conflicts: [], kept: [] },
    });
    await page.getByTestId('add-button').click();
    await page.getByTestId('add-files').click();
    await expect(page.getByTestId('replace-text')).toHaveText(
      '3 files named agenda.md are already in this library. Pick the one to replace, or keep all.',
    );
    const choices = page.getByTestId('replace-choice');
    await expect(choices).toHaveCount(3);
    await expect(choices.locator('.replace-choice-path')).toHaveText([
      '/Users/sam/Board/agenda.md',
      '/Users/sam/Team/Agenda.md',
      '/data/files/agenda.md (copy)',
    ]);
    await expect(page.getByTestId('replace-keep')).toHaveText('Keep all');
    await expect(page.getByTestId('replace-confirm')).toBeDisabled();
    await choices.nth(1).click();
    await expect(page.getByTestId('replace-confirm')).toBeEnabled();
    await page.getByTestId('replace-confirm').click();
    await expect
      .poll(() => calls(page))
      .toEqual([['addFiles'], ['addPaths', [three.path], { [three.path]: { action: 'replace', replaces: 'file-2' } }]]);
  });

  test('Keep all adds it beside the others', async ({ page }) => {
    await open(page, {
      libraries: libraries([file(1)]),
      addResult: { added: 0, skipped: [], already: [], conflicts: [three], kept: [] },
      resolvedResult: { added: 1, skipped: [], already: [], conflicts: [], kept: [] },
    });
    await page.getByTestId('add-button').click();
    await page.getByTestId('add-files').click();
    await page.getByTestId('replace-keep').click();
    await expect
      .poll(() => calls(page))
      .toEqual([['addFiles'], ['addPaths', [three.path], { [three.path]: { action: 'keep' } }]]);
  });

  test('one file of that name keeps the short question without a list', async ({ page }) => {
    await open(page, { libraries: libraries([file(1)]), addResult: asking });
    await page.getByTestId('add-button').click();
    await page.getByTestId('add-files').click();
    await expect(page.getByTestId('replace-choices')).toBeHidden();
    await expect(page.getByTestId('replace-keep')).toHaveText('Keep both');
    await expect(page.getByTestId('replace-confirm')).toBeEnabled();
  });
});

test.describe('sources out of reach', () => {
  test('a folder and an added file on an unplugged drive are marked Not available, and stay listed', async ({
    page,
  }) => {
    const away = [
      { ...folder(1, 'Archive'), path: '/Volumes/Backup/Archive', available: false, status: 'unavailable' },
      { ...file(1, 'Desktop') },
      { ...file(2), path: '/Volumes/Backup/memo-002.md', available: false, status: 'unavailable' },
    ];
    await open(page, { libraries: libraries(away) });
    await page.getByTestId('library-switcher').click();
    await expect(page.getByTestId('source-item').locator('.source-kind')).toHaveText([
      'Folder, not available',
      'File',
      'File, not available',
    ]);
    await page.keyboard.press('Escape');
    await page.getByTestId('view-browse').click();
    await expect(page.getByTestId('library-sources-status')).toHaveText(['Not available', 'Not available']);
    await expect(page.getByTestId('library-sources-missing')).toBeHidden();

    // The drive is back: the main process sends the view without the marks.
    await page.evaluate(
      (v) => window.__librariesEvent(v),
      libraries(away.map((x) => ({ ...x, available: true, status: 'ok' }))),
    );
    await expect(page.getByTestId('library-sources-status')).toHaveCount(0);
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
    // The status and its ↻ are one control: "Up to date ↻", with the tooltip Check for updates.
    const control = page.getByTestId('check-updates');
    await expect(control).toHaveText('Up to date ↻');
    await expect(control).toHaveAttribute('title', 'Check for updates');
    await expect(control).toHaveAccessibleName('Up to date');
    await expect(control).toHaveAccessibleDescription('Check for updates');
    await expect(page.getByTestId('library-switcher')).not.toContainText('Up to date');
    await page.getByText('Up to date').click();
    await expect(control).toHaveText('Checking… ↻');
    await expect(page.getByTestId('status-state')).toHaveAttribute('data-state', 'checking');
    await expect(control).toHaveAttribute('aria-disabled', 'true');
    // A second click while checking does nothing (Playwright waits on aria-disabled; send it anyway).
    await control.dispatchEvent('click');
    await page.evaluate(() => window.__finishCheck());
    await expect(control).toHaveText('Up to date ↻');
    await expect(control).not.toHaveAttribute('aria-disabled');
    expect(await calls(page)).toEqual([['checkUpdates']]);
  });

  test('works from the keyboard, with a focus ring for keyboard focus only', async ({ page }) => {
    await open(page, {
      libraries: libraries([folder(1)]),
      status: watcherStatus({ indexed: 4 }),
      checkResult: watcherStatus({ indexed: 4 }),
    });
    const control = page.getByTestId('check-updates');
    const ring = () => control.evaluate((el) => window.getComputedStyle(el).outlineStyle);
    await control.click();
    await expect(control).toBeFocused();
    expect(await ring()).toBe('none');
    await expect(control).toHaveText('Up to date ↻');

    // Tab to it from the library switcher, then Enter and Space each check.
    await page.getByTestId('library-switcher').focus();
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
    expect(await ring()).toBe('solid');
    await page.keyboard.press('Enter');
    await expect(control).toHaveText('Checking… ↻');
    await expect(control).toBeFocused();
    await expect(control).toHaveText('Up to date ↻');
    await page.keyboard.press('Space');
    await expect(control).toHaveText('Checking… ↻');
    await expect(control).toHaveText('Up to date ↻');
    expect(await calls(page)).toEqual([['checkUpdates'], ['checkUpdates'], ['checkUpdates']]);
  });

  test('a library that cannot be read says why in the same tooltip', async ({ page }) => {
    await open(page, {
      libraries: libraries([folder(1)]),
      status: watcherStatus({
        indexed: 4,
        unavailable: ['/Volumes/Archive'],
        error: '/Volumes/Archive is not available',
      }),
    });
    await expect(page.getByTestId('check-updates')).toHaveAttribute(
      'title',
      '/Volumes/Archive is not available. Check for updates',
    );
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

  test('two listed files of one name show their folder, cut short, the full path on hover', async ({ page }) => {
    const long = 'Minutes of the regional water board meetings and their appendices';
    await open(page, {
      libraries: libraries([
        folder(1),
        { ...file(1), name: 'agenda.md', path: '/Users/sam/Board/agenda.md' },
        { ...file(2), name: 'Agenda.md', path: `/Users/sam/${long}/Agenda.md` },
        { ...file(3), name: 'budget.md', path: '/Users/sam/Board/budget.md' },
        { id: 'file:agenda.md', kind: 'copy', path: '/data/files/agenda.md', name: 'agenda.md', available: true },
      ]),
    });
    await page.getByTestId('library-switcher').click();
    const items = page.getByTestId('source-item');
    await expect(items.locator('.source-kind')).toHaveText([
      'Folder',
      'File · Board',
      `File · ${long}`,
      'File',
      'Copy · AskFiles',
    ]);
    const where = page.getByTestId('source-folder');
    await expect(where).toHaveCount(3);
    await expect(where.nth(2)).toHaveAttribute('title', '/data/files/agenda.md');
    await expect(where.nth(0)).toHaveAttribute('title', '/Users/sam/Board/agenda.md');
    await expect(where.nth(1)).toHaveAttribute('title', `/Users/sam/${long}/Agenda.md`);
    // The long folder name is cut with an ellipsis and the row stays one line inside the menu.
    const cut = await where
      .nth(1)
      .evaluate((n) => ({ over: n.scrollWidth > n.clientWidth, ellipsis: window.getComputedStyle(n).textOverflow }));
    expect(cut).toEqual({ over: true, ellipsis: 'ellipsis' });
    const menu = await page.getByTestId('library-menu').boundingBox();
    const row = await items.nth(2).boundingBox();
    expect(row.x + row.width).toBeLessThanOrEqual(menu.x + menu.width);
    expect(row.height).toBeLessThan(40);
  });

  test('files with names of their own keep their rows as they are', async ({ page }) => {
    await open(page, { libraries: libraries([folder(1), file(1), file(2)]) });
    await page.getByTestId('library-switcher').click();
    await expect(page.getByTestId('source-item').locator('.source-kind')).toHaveText(['Folder', 'File', 'File']);
    await expect(page.getByTestId('source-folder')).toHaveCount(0);
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
      'FileOriginal missing',
      'Copy',
    ]);
    await expect(page.getByTestId('library-sources-status')).toHaveText(['Original missing']);
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
    await page.getByTestId('library-switcher').focus();
    await page.keyboard.press('Tab');
    await page.getByTestId('status-bar').screenshot({ path: `${shots}/up-to-date-keyboard-focus-${scheme}.png` });

    const many = await page.context().newPage();
    await many.emulateMedia({ colorScheme: scheme });
    await open(many, {
      libraries: libraries([file(1)]),
      addResult: {
        added: 0,
        skipped: [],
        already: [],
        kept: [],
        conflicts: [
          {
            path: '/Users/sam/Desktop/agenda.md',
            name: 'agenda.md',
            existing: [
              { id: 'file-1', path: '/Users/sam/Board/agenda.md', kind: 'file' },
              { id: 'file-2', path: '/Users/sam/Team/Agenda.md', kind: 'file' },
              { id: 'file:agenda.md', path: '/data/files/agenda.md', kind: 'copy' },
            ],
          },
        ],
      },
    });
    await many.getByTestId('add-button').click();
    await many.getByTestId('add-files').click();
    await many.getByTestId('replace-choice').nth(1).click();
    await many.screenshot({ path: `${shots}/replace-dialog-three-${scheme}.png` });

    const eight = await page.context().newPage();
    await eight.emulateMedia({ colorScheme: scheme });
    await open(eight, { libraries: libraries([...range(8, folder), ...range(900, file)]) });
    await eight.getByTestId('library-switcher').click();
    await eight.screenshot({ path: `${shots}/menu-8-folders-${scheme}.png` });

    const same = await page.context().newPage();
    await same.emulateMedia({ colorScheme: scheme });
    await open(same, {
      libraries: libraries([
        folder(1),
        { ...file(1), name: 'agenda.md', path: '/Users/sam/Board/agenda.md' },
        {
          ...file(2),
          name: 'Agenda.md',
          path: '/Users/sam/Minutes of the regional water board meetings/Agenda.md',
        },
        { ...file(3), name: 'budget.md', path: '/Users/sam/Board/budget.md' },
        { id: 'file:agenda.md', kind: 'copy', path: '/data/files/agenda.md', name: 'agenda.md', available: true },
      ]),
    });
    await same.getByTestId('library-switcher').click();
    await same.screenshot({ path: `${shots}/menu-same-name-${scheme}.png` });

    const manage = await page.context().newPage();
    await manage.emulateMedia({ colorScheme: scheme });
    await open(manage, {
      libraries: libraries([
        folder(1, 'Contracts'),
        folder(2, 'Minutes'),
        { ...folder(3, 'Archive'), path: '/Volumes/Backup/Archive', available: false, status: 'unavailable' },
        file(1, 'Desktop'),
        { ...file(2, 'Downloads'), available: false },
        file(3, 'Desktop'),
        { ...file(4), path: '/Volumes/Backup/memo-004.md', available: false, status: 'unavailable' },
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
