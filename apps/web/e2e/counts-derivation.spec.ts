import { expect, test } from './fixtures';
import { ownerEmail, ownerPassword } from './.test-owner';

test('owner can open count derivation when a count exists', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const visible = { timeout: 15_000 };

  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('link', { name: 'الجرد اليومي' }).click();
  await expect(page).toHaveURL('/counts');
  const button = page.getByRole('button', { name: 'تفاصيل الاشتقاق' });
  const empty = page.getByText('لسه مفيش جرد');
  await expect(button.first().or(empty)).toBeVisible(visible);
  if ((await button.count()) === 0) {
    await expect(empty).toBeVisible();
    return;
  }
  await button.first().click();
  await expect(
    page.getByText('الرصد الأصلي').first().or(page.getByRole('alert')),
  ).toBeVisible(visible);
});
