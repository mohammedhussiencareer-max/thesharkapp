import { expect, test } from '@playwright/test';

test('home has the title and is RTL', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('The Shark');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'The Shark' })).toBeVisible();
});
