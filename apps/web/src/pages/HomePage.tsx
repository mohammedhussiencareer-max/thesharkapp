import { Link } from 'react-router-dom';

export function HomePage({
  email,
  onSignOut,
}: {
  email: string;
  onSignOut: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col gap-2 ps-4 pe-4 pt-8 text-start">
      <h1 className="text-2xl font-semibold">The Shark</h1>
      <p>المخزون والمكسب اليومي</p>
      <p>{email}</p>
      <Link
        className="inline-flex w-fit rounded bg-neutral-900 px-3 py-2 text-white"
        to="/sales"
      >
        المبيعات
      </Link>
      <Link
        className="inline-flex w-fit rounded bg-neutral-900 px-3 py-2 text-white"
        to="/items"
      >
        الأصناف
      </Link>
      <Link
        className="inline-flex w-fit rounded bg-neutral-900 px-3 py-2 text-white"
        to="/opening"
      >
        الرصيد الافتتاحي
      </Link>
      <Link
        className="inline-flex w-fit rounded bg-neutral-900 px-3 py-2 text-white"
        to="/purchases"
      >
        المشتريات
      </Link>
      <Link
        className="inline-flex w-fit rounded bg-neutral-900 px-3 py-2 text-white"
        to="/sorting"
      >
        الفرز
      </Link>
      <Link
        className="inline-flex w-fit rounded bg-neutral-900 px-3 py-2 text-white"
        to="/expenses"
      >
        المصاريف
      </Link>
      <button type="button" onClick={onSignOut}>
        تسجيل الخروج
      </button>
    </main>
  );
}
