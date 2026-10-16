import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth-context';

const shell =
  'mx-auto flex min-h-dvh max-w-lg flex-col gap-4 ps-4 pe-4 pt-8 text-start';

export function RequireOwner({ children }: { children: ReactNode }) {
  const { status, signOut, retry } = useAuth();

  if (status === 'loading' || status === 'checking') {
    return (
      <main className={shell}>
        <p>جاري التحقق…</p>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main className={shell}>
        <p role="alert">تعذر التحقق من صلاحية الحساب</p>
        <button type="button" onClick={retry}>
          إعادة المحاولة
        </button>
      </main>
    );
  }

  if (status === 'denied') {
    return (
      <main className={shell}>
        <h1 className="text-2xl font-semibold">الحساب ده مش مسموح له يدخل</h1>
        <button type="button" onClick={() => void signOut()}>
          تسجيل الخروج
        </button>
      </main>
    );
  }

  if (status !== 'owner') {
    return <Navigate to="/login" replace />;
  }

  return children;
}
