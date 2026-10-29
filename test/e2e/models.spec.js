import { test, expect } from '@playwright/test';

// In-page stand-in for window.askfiles.models with the behaviour of src/main/models: refuses to
// delete active models and reports pull progress.
async function stubModels(page) {
  await page.addInitScript(() => {
    const listeners = [];
    const models = [
      { name: 'qwen3:8b', sizeBytes: 5_225_387_677, modifiedAt: 'x', role: 'chat' },
      { name: 'bge-m3:567m', sizeBytes: 1_157_672_268, modifiedAt: 'x', role: 'embedding' },
      { name: 'qwen3:4b', sizeBytes: 2_497_293_444, modifiedAt: 'x', role: null },
    ];
    window.__calls = [];
    window.askfiles = {
      models: {
        list: async () => models.map((m) => ({ ...m })),
        onProgress: (cb) => listeners.push(cb),
        pull: async (tag) => {
          window.__calls.push(['pull', tag]);
          if (tag === 'nope:1b') throw new Error('pull nope:1b failed: file does not exist');
          for (const percent of [0, 40, 100]) {
            listeners.forEach((l) =>
              l({ model: tag, status: 'pulling', completedBytes: percent * 1e7, totalBytes: 1e9, percent }),
            );
          }
          models.push({ name: tag, sizeBytes: 1e9, modifiedAt: 'x', role: null });
        },
        remove: async (tag) => {
          window.__calls.push(['remove', tag]);
          models.splice(
            models.findIndex((m) => m.name === tag),
            1,
          );
        },
        switchChat: async (tag) => {
          window.__calls.push(['switchChat', tag]);
          for (const m of models) if (m.role === 'chat') m.role = null;
          models.find((m) => m.name === tag).role = 'chat';
        },
      },
    };
  });
  await page.goto(`${process.env.ASKFILES_PAGE_URL}/models/index.html`);
}

const row = (page, name) => page.locator(`[data-testid="model-row"][data-model="${name}"]`);
const calls = (page) => page.evaluate(() => window.__calls);

test('lists models with their roles; active ones have no actions', async ({ page }) => {
  await stubModels(page);
  await expect(page.getByTestId('model-row')).toHaveCount(3);
  await expect(row(page, 'qwen3:8b').getByTestId('role')).toHaveText('Answers');
  await expect(row(page, 'bge-m3:567m').getByTestId('role')).toHaveText('Indexing');
  await expect(row(page, 'bge-m3:567m')).toContainText('1.2 GB');
  await expect(row(page, 'qwen3:8b').getByRole('button')).toHaveCount(0);
  await expect(row(page, 'qwen3:4b').getByRole('button')).toHaveCount(2);
});

test('switches the answering model', async ({ page }) => {
  await stubModels(page);
  await row(page, 'qwen3:4b').getByTestId('use').click();
  await expect(row(page, 'qwen3:4b').getByTestId('role')).toHaveText('Answers');
  await expect(row(page, 'qwen3:8b').getByTestId('role')).toHaveCount(0);
  expect(await calls(page)).toEqual([['switchChat', 'qwen3:4b']]);
});

test('deletes only after a second click', async ({ page }) => {
  await stubModels(page);
  await row(page, 'qwen3:4b').getByTestId('delete').click();
  await expect(row(page, 'qwen3:4b').getByTestId('delete')).toHaveText('Really delete');
  expect(await calls(page)).toEqual([]);
  await row(page, 'qwen3:4b').getByTestId('delete').click();
  await expect(page.getByTestId('model-row')).toHaveCount(2);
  expect(await calls(page)).toEqual([['remove', 'qwen3:4b']]);
});

test('downloads by tag with progress, and shows a failed download', async ({ page }) => {
  await stubModels(page);
  await page.getByTestId('pull-tag').fill('qwen3:14b');
  await page.getByTestId('pull-submit').click();
  await expect(row(page, 'qwen3:14b')).toBeVisible();
  await expect(page.getByTestId('progress-bar')).toHaveAttribute('value', '100');
  await expect(page.getByTestId('progress-text')).toHaveText('qwen3:14b. Download: 1.0 GB of 1.0 GB (100%)');

  await page.getByTestId('pull-tag').fill('nope:1b');
  await page.getByTestId('pull-submit').click();
  await expect(page.getByTestId('message')).toHaveText('pull nope:1b failed: file does not exist');
  await expect(page.getByTestId('model-row')).toHaveCount(4);
});
