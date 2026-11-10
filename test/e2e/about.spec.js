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
  await expect(page.getByTestId('license')).toContainText('Apache License 2.0 (Apache-2.0)');
  await expect(page.getByTestId('license')).toContainText('github.com/yuan-phd/askfiles');
});

test('shows the app license text in the page from the link, and hides it again', async ({ page }) => {
  await page.route('**/LICENSE', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: 'Apache License\nVersion 2.0, January 2004' }),
  );
  await page.goto(`${process.env.ASKFILES_PAGE_URL}/about/index.html`);
  await expect(page.getByTestId('license-text')).toBeHidden();
  await page.getByTestId('license-link').click();
  await expect(page.getByTestId('license-text')).toContainText('Apache License');
  // The link stays on the About page rather than navigating to the plain text file.
  await expect(page).toHaveURL(/\/about\/index\.html$/);
  await page.getByTestId('license-link').click();
  await expect(page.getByTestId('license-text')).toBeHidden();
});

test('still lists the notices state when the file is missing', async ({ page }) => {
  await page.route('**/THIRD-PARTY-NOTICES', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto(`${process.env.ASKFILES_PAGE_URL}/about/index.html`);
  await expect(page.getByTestId('notices')).toHaveText('The notices file could not be read (404).');
  await expect(page.getByTestId('version')).toHaveText('Version');
});
