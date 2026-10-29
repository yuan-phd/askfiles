import { test, expect } from '@playwright/test';

test('shows the version from the bridge, the credits and the third-party notices', async ({ page }) => {
  await page.addInitScript(() => {
    window.askfiles = { app: { info: async () => ({ name: 'AskFiles', version: '0.1.0' }) } };
  });
  // The app serves the notices file at the root of askfiles://app; the test server only has the pages.
  await page.route('**/THIRD-PARTY-NOTICES', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: 'THIRD-PARTY NOTICES\n\n- a@1.0.0  MIT' }),
  );
  await page.goto(`${process.env.ASKFILES_PAGE_URL}/about/index.html`);
  await expect(page.getByTestId('version')).toHaveText('Version 0.1.0');
  await expect(page.getByTestId('credits')).toContainText('Ollama');
  await expect(page.getByTestId('notices')).toContainText('a@1.0.0  MIT');
});

test('still lists the notices state when the file is missing', async ({ page }) => {
  await page.route('**/THIRD-PARTY-NOTICES', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto(`${process.env.ASKFILES_PAGE_URL}/about/index.html`);
  await expect(page.getByTestId('notices')).toHaveText('The notices file could not be read (404).');
  await expect(page.getByTestId('version')).toHaveText('Version');
});
