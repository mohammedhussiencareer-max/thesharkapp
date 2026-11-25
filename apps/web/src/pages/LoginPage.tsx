import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth-context';

const shell =
  'mx-auto flex min-h-dvh max-w-lg flex-col gap-4 ps-4 pe-4 pt-8 text-start';

export function LoginPage() {
  const {
    signIn,
    signOut,
    retryLogoutRevocation,
    logoutPending = false,
    logoutFailed = false,
    logoutRevocationFailed = false,
  } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const formBlocked = submitting || logoutPending || logoutFailed;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (logoutPending || logoutFailed) return;
    void (async () => {
      setSubmitting(true);
      setInvalid(false);
      const result = await signIn(email, password);
      setSubmitting(false);
      if (result === 'invalid') {
        setInvalid(true);
        return;
      }
      void navigate('/');
    })();
  }

  return (
    <main className={shell}>
      <p className="text-sm">The Shark</p>
      <h1 className="text-2xl font-semibold">تسجيل الدخول</h1>
      {logoutFailed ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded border border-red-300 bg-red-50 p-3 text-sm"
        >
          <p>تعذر إنهاء تسجيل الخروج على هذا الجهاز — أعد المحاولة</p>
          <button
            className="w-fit rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60"
            type="button"
            disabled={logoutPending}
            onClick={() => void signOut()}
          >
            {logoutPending ? 'جاري تسجيل الخروج…' : 'إعادة محاولة تسجيل الخروج'}
          </button>
        </div>
      ) : null}
      {logoutRevocationFailed && !logoutFailed ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm"
        >
          <p>
            تم تسجيل الخروج من هذا الجهاز، لكن تعذر إنهاء الجلسة على الأجهزة
            الأخرى — أعد المحاولة
          </p>
          <button
            className="w-fit rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60"
            type="button"
            disabled={logoutPending}
            onClick={() => void (retryLogoutRevocation ?? signOut)()}
          >
            {logoutPending
              ? 'جاري إنهاء الجلسات…'
              : 'إعادة محاولة إنهاء الجلسات الأخرى'}
          </button>
        </div>
      ) : null}
      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <label className="flex flex-col gap-1">
          البريد
          <input
            className="rounded border border-neutral-300 px-3 py-2"
            type="email"
            name="email"
            autoComplete="username"
            required
            disabled={formBlocked}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          كلمة السر
          <input
            className="rounded border border-neutral-300 px-3 py-2"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            minLength={12}
            disabled={formBlocked}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {invalid ? <p role="alert">البريد أو كلمة السر غلط</p> : null}
        <button
          className="rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60"
          type="submit"
          disabled={formBlocked}
        >
          {submitting ? 'جاري الدخول…' : 'تسجيل الدخول'}
        </button>
      </form>
    </main>
  );
}
