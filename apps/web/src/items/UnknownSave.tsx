import { unknownSaveMessage } from '@/items/request-id';

const retryButton =
  'w-fit rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

/** The only control for a subject whose last save might already be stored. */
export function UnknownSave({
  disabled,
  onRetry,
}: {
  disabled: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p>{unknownSaveMessage}</p>
      <button
        className={retryButton}
        type="button"
        disabled={disabled}
        onClick={onRetry}
      >
        إعادة المحاولة
      </button>
    </div>
  );
}
