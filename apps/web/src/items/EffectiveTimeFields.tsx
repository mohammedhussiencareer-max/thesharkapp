import {
  impactErrorMessage,
  impactLoadingMessage,
  type EffectiveMode,
} from '@/items/effective';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';

export function EffectiveTimeFields({
  mode,
  shiftStart,
  customLocal,
  reason,
  backdated,
  impact,
  impactStatus,
  disabled,
  onMode,
  onCustomLocal,
  onReason,
  onRetryImpact,
}: {
  mode: EffectiveMode;
  shiftStart: string | null;
  customLocal: string;
  reason: string;
  backdated: boolean;
  impact: string | null;
  impactStatus: 'idle' | 'loading' | 'ready' | 'error';
  disabled: boolean;
  onMode: (mode: EffectiveMode) => void;
  onCustomLocal: (value: string) => void;
  onReason: (value: string) => void;
  onRetryImpact: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        وقت السريان
        <select
          className={fieldClass}
          disabled={disabled}
          value={mode}
          onChange={(event) => {
            const next = event.target.value;
            if (next === 'now' || next === 'shift' || next === 'custom') {
              onMode(next);
            }
          }}
        >
          <option value="now">الآن</option>
          {shiftStart ? <option value="shift">بداية الوردية</option> : null}
          <option value="custom">وقت محدد</option>
        </select>
      </label>
      {mode === 'custom' ? (
        <label className="flex flex-col gap-1">
          الوقت
          <input
            className={fieldClass}
            type="datetime-local"
            disabled={disabled}
            value={customLocal}
            onChange={(event) => onCustomLocal(event.target.value)}
          />
        </label>
      ) : null}
      {backdated ? (
        <label className="flex flex-col gap-1">
          سبب التغيير
          <input
            className={fieldClass}
            autoComplete="off"
            disabled={disabled}
            value={reason}
            onChange={(event) => onReason(event.target.value)}
          />
        </label>
      ) : null}
      {backdated && impactStatus === 'loading' ? (
        <p>{impactLoadingMessage}</p>
      ) : null}
      {backdated && impactStatus === 'error' ? (
        <div className="flex flex-col gap-2">
          <p role="alert">{impactErrorMessage}</p>
          {disabled ? null : (
            <button
              className="w-fit rounded border border-neutral-300 px-3 py-2"
              type="button"
              onClick={onRetryImpact}
            >
              إعادة المحاولة
            </button>
          )}
        </div>
      ) : null}
      {backdated && impactStatus === 'ready' && impact ? <p>{impact}</p> : null}
    </div>
  );
}
