import { expect, test } from './fixtures';
import { ownerEmail, ownerPassword } from './.test-owner';

test('owner signs in, sees their email, and signs out', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'The Shark' })).toBeVisible();
  await expect(page.getByText(ownerEmail)).toBeVisible();

  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole('heading', { name: 'تسجيل الدخول' }),
  ).toBeVisible();
});

test('a wrong password shows the generic error', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill('WrongPassword123');
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();

  await expect(page.getByText('البريد أو كلمة السر غلط')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});
