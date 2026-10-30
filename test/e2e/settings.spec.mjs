// Settings page (Session K, part 4) and the Developer page, with a stub of the preload bridge.
import { test, expect } from '@playwright/test';
import { library, settingsView, stubLibraries } from './libraries-stub.mjs';

const url = (page) => `${process.env.ASKFILES_PAGE_URL}/${page}/index.html`;
const calls = (page) => page.evaluate(() => window.__libCalls.filter((c) => !['list', 'settingsGet'].includes(c[0])));
const libs = { current: 'lib-1', libraries: [library({ id: 'lib-1', name: 'Work', isDefault: false })] };

test.describe('settings page', () => {
  test('shows the four controls with one line each and saves each change', async ({ page }) => {
    await stubLibraries(page, { settings: settingsView(), libraries: libs });
    await page.goto(url('settings'));
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('fieldset legend')).toHaveText([
      'Answer scope',
      'Answer model',
      'Context length',
      'Reindex this library',
    ]);
    await expect(page.locator('fieldset .note')).toHaveCount(4);
    await expect(page.getByTestId('scope-balanced')).toBeChecked();
    await expect(page.getByTestId('model-better')).toBeChecked();
    await expect(page.getByTestId('model-faster-detail')).toHaveText('(qwen3:4b)');
    await expect(page.getByTestId('context-choices').locator('label')).toHaveText(['4K', '8K (recommended)', '16K']);
    await expect(page.getByTestId('context-8192')).toBeChecked();
    await expect(page.getByTestId('reindex-library')).toHaveText('Work');

    await page.getByTestId('scope-strict').check();
    await expect(page.getByTestId('status')).toHaveText('Saved.');
    await page.getByTestId('model-faster').check();
    await expect(page.getByTestId('status')).toHaveText('Saved.');
    await page.getByTestId('context-16384').check();
    await expect(page.getByTestId('context-16384')).toBeChecked();
    await page.getByTestId('context-8192').check();
    await expect(page.getByTestId('context-8192')).toBeChecked();
    await page.getByTestId('reindex').click();
    await expect(page.getByTestId('status')).toContainText('Reindexing started');
    await expect
      .poll(() => calls(page))
      .toEqual([
        ['settingsSet', { answerScope: 'strict' }],
        ['settingsSet', { answerModel: 'faster' }],
        ['settingsSet', { contextLength: 16384 }],
        ['settingsSet', { contextLength: null }],
        ['reindex'],
      ]);
  });

  test('offers no Faster model on a Mac in the lowest tier and shows a refused change', async ({ page }) => {
    await stubLibraries(page, {
      settings: settingsView({
        models: { faster: null, better: { choice: 'better', model: 'qwen3:4b', tierLabel: '8 GB' } },
      }),
      libraries: libs,
      fail: { settingsSet: 'the search engine is not running' },
    });
    await page.goto(url('settings'));
    await expect(page.getByTestId('model-faster')).toBeDisabled();
    await expect(page.getByTestId('model-faster-detail')).toHaveText('(not available on this Mac)');
    // A refused change puts the check back where it was.
    await page.getByTestId('scope-broad').click();
    await expect(page.getByTestId('message')).toHaveText('the search engine is not running');
    await expect(page.getByTestId('scope-balanced')).toBeChecked();
  });

  test('says where settings live when opened outside the app', async ({ page }) => {
    await page.goto(url('settings'));
    await expect(page.getByTestId('message')).toHaveText('Settings are available in the AskFiles app.');
  });
});

test.describe('developer page', () => {
  test('shows the data directory and the raw preset values', async ({ page }) => {
    await stubLibraries(page, {
      developer: {
        dataDir: '/Users/anna/Library/Application Support/AskFiles',
        presetsFile: '/Applications/AskFiles.app/Contents/Resources/app.asar/config/presets.json',
        settings: { answerScope: 'balanced', answerModel: 'faster', contextLength: null },
        effectivePreset: { id: '16gb', chatModel: 'qwen3:4b', contextLength: 8192 },
        machinePreset: { id: '16gb', chatModel: 'qwen3:8b', contextLength: 8192 },
      },
    });
    await page.goto(url('developer'));
    await expect(page.getByTestId('data-dir')).toHaveText('/Users/anna/Library/Application Support/AskFiles');
    await expect(page.getByTestId('effective-preset')).toContainText('"chatModel": "qwen3:4b"');
    await expect(page.getByTestId('machine-preset')).toContainText('"chatModel": "qwen3:8b"');
    // The Models page has no menu entry; the Developer page is the way in.
    await page.getByTestId('open-models').click();
    await expect.poll(() => page.evaluate(() => window.__libCalls.map((c) => c[0]))).toContain('openModels');
  });

  test('shows the refusal when the developer switch is off', async ({ page }) => {
    await stubLibraries(page, { fail: { developerInfo: 'the developer page is off' } });
    await page.goto(url('developer'));
    await expect(page.getByTestId('message')).toHaveText('the developer page is off');
  });
});
