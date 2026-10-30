// The top bar of the main window (Session K): library switcher, Add, the Ask and Browse switch,
// the empty state and drag and drop, against the Ask page with a stub of the preload bridge.
import { test, expect } from '@playwright/test';
import { mockLibrary, pageUrl, watcherStatus } from './mocks.js';
import { folderSource, library, stubLibraries } from './libraries-stub.mjs';

const calls = (page) => page.evaluate(() => window.__libCalls.filter((c) => c[0] !== 'list'));

function twoLibraries(currentWork = false) {
  return {
    current: currentWork ? 'lib-1' : 'all-files',
    libraries: [
      library({ isCurrent: !currentWork, indexed: 12, sources: [folderSource('/Users/anna/Documents')] }),
      library({
        id: 'lib-1',
        name: 'Work',
        isDefault: false,
        isCurrent: currentWork,
        indexed: 3,
        sources: [
          folderSource('/Users/anna/Work'),
          { id: 'file:plan.pdf', kind: 'file', path: '/data/plan.pdf', name: 'plan.pdf', available: true },
        ],
      }),
    ],
  };
}

async function open(page, options) {
  await mockLibrary(page, { documents: 5 });
  await stubLibraries(page, options);
  await page.goto(pageUrl());
  await expect(page.getByTestId('library-name')).not.toHaveText('Library');
}

test.describe('top bar', () => {
  test('shows the current library with its count and state, lists the libraries and switches', async ({ page }) => {
    await open(page, { libraries: twoLibraries(), status: watcherStatus({ indexed: 12 }) });
    await expect(page.getByTestId('library-name')).toHaveText('All files');
    await expect(page.getByTestId('status-count')).toHaveText('12 documents indexed');
    await expect(page.getByTestId('status-state')).toHaveText('Up to date');
    await expect(page.getByTestId('view-search')).toHaveText('Ask');
    await expect(page.getByTestId('library-menu')).toBeHidden();

    await page.getByTestId('library-switcher').click();
    const options = page.getByTestId('library-option');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toHaveAttribute('aria-checked', 'true');
    await expect(options.nth(1)).toContainText('Work');
    await expect(options.nth(1)).toContainText('3 documents');
    // All files cannot be renamed or deleted.
    await expect(page.getByTestId('library-rename-form')).toBeHidden();
    await expect(page.getByTestId('library-delete')).toBeHidden();
    await expect(page.getByTestId('source-item')).toHaveText([/Documents\s*Folder\s*Remove/]);

    await options.nth(1).click();
    expect(await calls(page)).toEqual([['select', 'lib-1']]);

    await page.evaluate((s) => window.__watcher(s), watcherStatus({ state: 'working', pending: 2, indexed: 12 }));
    await expect(page.getByTestId('status-state')).toHaveText('Indexing, 2 left');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('library-menu')).toBeHidden();
  });

  test('creates, renames, deletes a library and removes a source', async ({ page }) => {
    await open(page, { libraries: twoLibraries(true) });
    await page.getByTestId('library-switcher').click();
    await page.getByTestId('library-new-name').fill('Projects');
    await page.getByTestId('library-create').click();
    await expect(page.getByTestId('library-new-name')).toHaveValue('');

    await expect(page.getByTestId('library-rename-name')).toHaveValue('Work');
    await page.getByTestId('library-rename-name').fill('Office');
    await page.getByTestId('library-rename-save').click();

    await page.getByTestId('source-item').filter({ hasText: 'plan.pdf' }).getByTestId('source-remove').click();

    page.once('dialog', (d) => d.dismiss());
    await page.getByTestId('library-delete').click();
    page.once('dialog', (d) => {
      expect(d.message()).toContain('Your original files and folders are not touched.');
      return d.accept();
    });
    await page.getByTestId('library-delete').click();

    await expect
      .poll(() => calls(page))
      .toEqual([
        ['create', 'Projects'],
        ['rename', 'lib-1', 'Office'],
        ['removeSource', 'file:plan.pdf'],
        ['remove', 'lib-1'],
      ]);
  });

  test('shows a refused change in the menu', async ({ page }) => {
    await open(page, { libraries: twoLibraries(), fail: { create: 'There is already a library called work.' } });
    await page.getByTestId('library-switcher').click();
    await page.getByTestId('library-new-name').fill('work');
    await page.getByTestId('library-new-name').press('Enter');
    await expect(page.getByTestId('library-error')).toHaveText('There is already a library called work.');
    await expect(page.getByTestId('library-new-name')).toHaveValue('work');
  });

  test('the Add button adds files or a folder and says what happened', async ({ page }) => {
    await open(page, {
      libraries: twoLibraries(),
      addResult: { added: 2, skipped: [{ name: 'photo.heic', reason: 'not a type AskFiles can read' }] },
    });
    await page.getByTestId('add-button').click();
    await expect(page.getByTestId('add-menu')).toBeVisible();
    await page.getByTestId('add-files').click();
    await expect(page.getByTestId('add-menu')).toBeHidden();
    await expect(page.getByTestId('add-result')).toHaveText(
      'Added 2 items. Not added: photo.heic (not a type AskFiles can read).',
    );
    await page.getByTestId('add-button').click();
    await page.getByTestId('add-folder').click();
    expect(await calls(page)).toEqual([['addFiles'], ['addFolder']]);
  });

  test('a library without sources shows one sentence and Add, in Ask and in Browse', async ({ page }) => {
    await open(page, { libraries: { current: 'all-files', libraries: [library()] } });
    const empty = page.getByTestId('library-empty-state');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('This library is empty. Add files or a folder to start.');
    await expect(page.getByTestId('search-view')).toBeHidden();

    await page.getByTestId('view-browse').click();
    await expect(page.getByTestId('view-browse')).toHaveAttribute('aria-pressed', 'true');
    await expect(empty).toBeVisible();
    await expect(page.getByTestId('browse-view')).toBeHidden();

    await page.getByTestId('empty-add').click();
    await page.getByTestId('empty-add-folder').click();
    expect(await calls(page)).toEqual([['addFolder']]);

    // Once a source arrives, the view the switch points at shows.
    await page.evaluate((v) => window.__librariesEvent(v), {
      current: 'all-files',
      libraries: [library({ sources: [{ id: 'folder-1', kind: 'folder', path: '/d', name: 'd', available: true }] })],
    });
    await expect(empty).toBeHidden();
    await expect(page.getByTestId('browse-view')).toBeVisible();
    await page.getByTestId('view-search').click();
    await expect(page.getByTestId('search-view')).toBeVisible();
  });

  test('dropping files anywhere in the window adds them to the current library', async ({ page }) => {
    await open(page, { libraries: twoLibraries() });
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'a.pdf'));
      dt.items.add(new File(['y'], 'b.docx'));
      document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    });
    await expect(page.locator('body')).toHaveAttribute('data-dropping', 'true');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'a.pdf'));
      dt.items.add(new File(['y'], 'b.docx'));
      document
        .querySelector('main')
        .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('body')).not.toHaveAttribute('data-dropping', 'true');
    await expect.poll(() => calls(page)).toEqual([['addPaths', ['/dropped/a.pdf', '/dropped/b.docx']]]);
    await expect(page.getByTestId('add-result')).toHaveText('Added 2 items.');
  });

  test('the bar stays in place while the view scrolls', async ({ page }) => {
    await open(page, { libraries: twoLibraries() });
    await page.evaluate(() => {
      const tall = document.createElement('div');
      tall.style.height = '4000px';
      document.getElementById('view-search').append(tall);
      document.getElementById('view-search').scrollTop = 3000;
    });
    expect(await page.evaluate(() => document.getElementById('view-search').scrollTop)).toBeGreaterThan(2000);
    const bar = await page.getByTestId('status-bar').boundingBox();
    expect(bar.y).toBe(0);
    await expect(page.getByTestId('library-switcher')).toBeInViewport();
  });
});

// Page states for the PR in light and dark mode:
//   SCREENSHOT_DIR=docs/screenshots/libraries npx playwright test topbar -g screenshot
const shots = process.env.SCREENSHOT_DIR;
for (const scheme of ['light', 'dark']) {
  test(`libraries screenshot ${scheme}`, async ({ page }) => {
    test.skip(!shots, 'SCREENSHOT_DIR not set');
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, { libraries: twoLibraries(true), status: watcherStatus({ indexed: 3 }) });
    await page.getByTestId('library-switcher').click();
    await page.screenshot({ path: `${shots}/library-menu-${scheme}.png` });
    await page.keyboard.press('Escape');
    await page.getByTestId('add-button').click();
    await page.screenshot({ path: `${shots}/add-menu-${scheme}.png` });

    const empty = await page.context().newPage();
    await empty.emulateMedia({ colorScheme: scheme });
    await open(empty, { libraries: { current: 'all-files', libraries: [library()] } });
    await empty.screenshot({ path: `${shots}/empty-${scheme}.png` });

    const settings = await page.context().newPage();
    await settings.emulateMedia({ colorScheme: scheme });
    const { settingsView } = await import('./libraries-stub.mjs');
    await stubLibraries(settings, { settings: settingsView(), libraries: twoLibraries(true) });
    await settings.goto(`${process.env.ASKFILES_PAGE_URL}/settings/index.html`);
    await settings.locator('html[data-ready="true"]').waitFor();
    await settings.screenshot({ path: `${shots}/settings-${scheme}.png`, fullPage: true });
  });
}
