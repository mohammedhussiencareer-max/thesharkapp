import { expect, test } from './fixtures';

test('signed-out home redirects to login and stays RTL', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page).toHaveTitle('The Shark');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(
    page.getByRole('heading', { name: 'تسجيل الدخول' }),
  ).toBeVisible();
});
