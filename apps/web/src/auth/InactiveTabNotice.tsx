import { primaryButton } from '@/lib/page-style';

export function InactiveTabNotice({
  takingOver = false,
  onTakeOver,
}: {
  takingOver?: boolean;
  onTakeOver: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 ps-4 pe-4 py-8 text-start">
      <p className="text-sm">The Shark</p>
      <h1 className="text-2xl font-semibold">التطبيق مفتوح في تبويب تاني</h1>
      <button
        className={primaryButton}
        type="button"
        disabled={takingOver}
        onClick={onTakeOver}
      >
        استخدمه هنا
      </button>
    </main>
  );
}
