import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const [locale, root] of [['en', ''], ['zh', '/zh']]) {
  const copy = JSON.parse(await readFile(
    new URL('../messages/' + locale + '/dashboard.json', import.meta.url), 'utf8',
  ));

  test('dashboard links and account values are localized: ' + locale, async ({ page }) => {
    await page.route('**/api/platform/v1/me', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'user-a', name: 'Test Creator', email: 'creator@example.test' },
        plan: 'free',
        creditBalance: '19',
      }),
    }));
    await page.goto(root + '/dashboard');
    await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();
    const navigation = page.getByRole('navigation', { name: copy.navigation });
    await expect(navigation.getByRole('link', { name: copy.primary.dashboard })).toHaveAttribute('aria-current', 'page');
    await expect(navigation.getByRole('link', { name: copy.primary.captions })).toHaveAttribute('href', root + '/captions');
    await expect(page.getByRole('link', { name: copy.actions.image.title })).toHaveAttribute('href', root + '/studio/image');
    await expect(page.getByRole('link', { name: copy.actions.workflow.title })).toHaveAttribute('href', root + '/studio/workflows');
    await expect(page.getByRole('link', { name: copy.actions.thumbnail.title })).toHaveAttribute('href', root + '/studio/design-agent');
    await expect(page.getByRole('link', { name: copy.actions.short.title })).toHaveCount(0);
    await expect(page.getByText(copy.soon, { exact: true })).toBeVisible();
    const overview = page.getByRole('region', { name: copy.overview });
    await expect(overview).toContainText('Test Creator');
    await expect(overview).toContainText('19');
    await expect(overview).toContainText(copy.plans.free);
  });

  test('dashboard distinguishes signed out and retryable errors: ' + locale, async ({ page }) => {
    let count = 0;
    await page.route('**/api/platform/v1/me', route => {
      count += 1;
      return route.fulfill(count === 1
        ? { status: 503, body: 'unavailable' }
        : { status: 401, body: '{"error":"unauthorized"}', contentType: 'application/json' });
    });
    await page.goto(root + '/dashboard');
    await expect(page.getByRole('alert')).toHaveText(copy.failed);
    await page.getByRole('button', { name: copy.retry }).click();
    await expect(page.getByText(copy.signedOut)).toBeVisible();
    await expect(page.getByRole('link', { name: copy.signIn })).toHaveAttribute('href', root + '/login');
  });
}
