import { test, expect } from '@playwright/test';

// The page reads first-run events from window.askfiles.setup (src/main/preload.ts). This stub
// records calls and lets the test push events, so the page runs exactly as in Electron minus the
// main process.
async function stubSetup(page) {
  await page.addInitScript(() => {
    const listeners = [];
    window.__calls = [];
    window.__emit = (e) => listeners.forEach((l) => l(e));
    window.askfiles = {
      setup: {
        onEvent: (cb) => {
          listeners.push(cb);
          return () => listeners.splice(listeners.indexOf(cb), 1);
        },
        start: async () => window.__calls.push('start'),
        retry: async () => window.__calls.push('retry'),
      },
    };
  });
  await page.goto(`${process.env.ASKFILES_PAGE_URL}/onboarding/index.html`);
}

const emit = (page, e) => page.evaluate((x) => window.__emit(x), e);
const calls = (page) => page.evaluate(() => window.__calls);
const state = (s, extra = {}) => ({ type: 'state', state: s, failedStep: null, error: null, attempt: 1, ...extra });
const setup = (s, extra = {}) => ({ type: 'setup', state: s, failedStep: null, error: null, ...extra });
const progress = (index, completedBytes, totalBytes, percent, model = 'qwen3:8b') => ({
  type: 'progress',
  model,
  index,
  count: 2,
  status: 'pulling',
  completedBytes,
  totalBytes,
  percent,
});

test('shows steps and download progress, and one retry button after a failed pull', async ({ page }) => {
  await stubSetup(page);
  await expect.poll(() => calls(page)).toEqual(['start']);
  await expect(page.getByTestId('progress-bar')).toBeHidden();
  await expect(page.getByTestId('retry')).toBeHidden();

  await emit(page, setup('models'));
  await emit(page, state('detectRam'));
  await emit(page, state('chooseTier'));
  await emit(page, {
    type: 'tier',
    ramGb: 16,
    label: '16 GB',
    belowMinimum: false,
    tierId: '16gb',
    chatModel: 'qwen3:8b',
    embeddingModel: 'bge-m3:567m',
  });
  await emit(page, state('pullModels'));
  await emit(page, progress(1, 2_600_000_000, 5_200_000_000, 50));

  await expect(page.getByTestId('tier')).toHaveText(
    'This Mac has 16 GB of memory. AskFiles picks the model that fits.',
  );
  await expect(page.getByTestId('step-detectRam')).toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('step-pullModels')).toHaveAttribute('data-status', 'active');
  await expect(page.getByTestId('step-writeConfig')).toHaveAttribute('data-status', 'pending');
  await expect(page.getByTestId('step-createLibrary')).toHaveAttribute('data-status', 'pending');
  await expect(page.getByTestId('progress-bar')).toHaveAttribute('value', '50');
  await expect(page.getByTestId('progress-text')).toHaveText('Download 2 of 2: 2.6 GB of 5.2 GB (50%)');

  await emit(
    page,
    state('error', { failedStep: 'pullModels', error: 'pull qwen3:8b failed: connection reset by peer' }),
  );
  await emit(page, setup('error', { failedStep: 'models', error: 'pull qwen3:8b failed: connection reset by peer' }));
  await expect(page.getByTestId('step-pullModels')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('error-text')).toHaveText('pull qwen3:8b failed: connection reset by peer');
  await expect(page.getByRole('button', { disabled: false })).toHaveCount(1);
  await page.getByTestId('retry').click();
  await expect(page.getByTestId('retry')).toBeDisabled();
  await expect.poll(() => calls(page)).toEqual(['start', 'retry']);

  await emit(page, setup('models'));
  await emit(page, state('retry', { attempt: 2 }));
  await expect(page.getByTestId('error')).toBeHidden();
  await emit(page, state('pullModels', { attempt: 2 }));
  await emit(page, progress(1, 5_200_000_000, 5_200_000_000, 100));
  for (const s of ['writeConfig', 'markOnboarded', 'done']) await emit(page, state(s, { attempt: 2 }));

  await expect(page.getByTestId('progress-text')).toHaveText('Download 2 of 2: 5.2 GB of 5.2 GB (100%)');
  for (const step of ['detectRam', 'chooseTier', 'pullModels', 'writeConfig', 'markOnboarded']) {
    await expect(page.getByTestId(`step-${step}`)).toHaveAttribute('data-status', 'done');
  }
  // The models are in place, but setup is not done until the library is prepared.
  await expect(page.getByTestId('done')).toBeHidden();
});

test('asks for no folder: the library step follows the models, then done', async ({ page }) => {
  await stubSetup(page);
  for (const s of ['detectRam', 'chooseTier', 'pullModels', 'writeConfig', 'markOnboarded', 'done']) {
    await emit(page, state(s));
  }
  await expect(page.getByTestId('step-chooseFolder')).toHaveCount(0);
  await expect(page.getByTestId('step-indexing')).toHaveCount(0);
  await expect(page.getByTestId('choose-folder')).toHaveCount(0);
  await emit(page, setup('createLibrary'));
  await expect(page.getByTestId('step-createLibrary')).toHaveAttribute('data-status', 'active');
  await expect(page.getByTestId('progress')).toBeHidden();
  await emit(page, setup('done'));
  await expect(page.getByTestId('done')).toHaveText('All set. Opening AskFiles.');
  await expect(page.getByTestId('step-createLibrary')).toHaveAttribute('data-status', 'done');
  expect(await calls(page)).toEqual(['start']);
});

test('shows a failed library step and retries it', async ({ page }) => {
  await stubSetup(page);
  await emit(page, setup('createLibrary'));
  await emit(page, setup('error', { failedStep: 'createLibrary', error: 'POST /v1/workspace/new failed (500): boom' }));
  await expect(page.getByTestId('step-createLibrary')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('error-text')).toHaveText('POST /v1/workspace/new failed (500): boom');
  await page.getByTestId('retry').click();
  await expect.poll(() => calls(page)).toEqual(['start', 'retry']);
});

test('warns on a machine below the lowest tier', async ({ page }) => {
  await stubSetup(page);
  await emit(page, {
    type: 'tier',
    ramGb: 7.9,
    label: '8 GB',
    belowMinimum: true,
    tierId: '8gb',
    chatModel: 'qwen3:4b',
    embeddingModel: 'bge-m3:567m',
  });
  await expect(page.getByTestId('tier')).toContainText('less than AskFiles is made for');
});

test('says so when the bridge is missing', async ({ page }) => {
  await page.goto(`${process.env.ASKFILES_PAGE_URL}/onboarding/index.html`);
  await expect(page.getByTestId('error-text')).toHaveText('The app could not start setup.');
  await expect(page.getByTestId('retry')).toBeDisabled();
});
