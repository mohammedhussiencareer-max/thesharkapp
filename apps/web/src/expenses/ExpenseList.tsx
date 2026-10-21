import { useState } from 'react';
import { fieldClass, kindLabels } from '@/expenses/labels';
import { entryStatusLabel } from '@/expenses/status';
import type { ExpenseLine } from '@/expenses/types';
import { validateVoidReason } from '@/expenses/validation';
import { formatIsoDate, formatMonth } from '@/lib/cairo';
import { formatEgpText } from '@/lib/money';
import { secondaryButton } from '@/lib/page-style';

function whenLabel(line: ExpenseLine): string {
  if (line.expenseDate) return formatIsoDate(line.expenseDate);
  if (line.periodMonth) return formatMonth(line.periodMonth);
  return '';
}

export function ExpenseList({
  entries,
  disabled,
  pendingReasons = new Map<string, string>(),
  onVoid,
}: {
  entries: readonly ExpenseLine[];
  disabled: boolean;
  /** Reasons of voids sent without a confirmed reply, keyed by entry id. */
  pendingReasons?: ReadonlyMap<string, string>;
  onVoid: (id: string, reason: string) => void;
}) {
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  function openVoid(id: string) {
    if (disabled) return;
    setVoidingId(id);
    // A void whose reply was lost is retried with the same reason, so the
    // server replays it instead of refusing a different payload.
    setReason(pendingReasons.get(id) ?? '');
    setReasonError(null);
  }

  function confirmVoid() {
    if (disabled || voidingId === null) return;
    const error = validateVoidReason(reason);
    if (error) {
      setReasonError(error);
      return;
    }
    const id = voidingId;
    const text = reason.trim();
    setVoidingId(null);
    setReason('');
    setReasonError(null);
    onVoid(id, text);
  }

  if (entries.length === 0) {
    return <p>مفيش مصاريف في الشهر ده</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {entries.map((line) => {
        const label = `${line.categoryName} ${formatEgpText(line.amount)} ${whenLabel(line)}`;
        const open = voidingId === line.id;
        const pending = pendingReasons.has(line.id);
        return (
          <li key={line.id}>
            <article
              className="flex flex-col gap-2 rounded border border-neutral-200 p-3"
              aria-label={label}
            >
              <h3 className="font-semibold">{line.categoryName}</h3>
              <p>{formatEgpText(line.amount)}</p>
              <p>{whenLabel(line)}</p>
              <p>{kindLabels[line.categoryKind]}</p>
              <p>{entryStatusLabel(line)}</p>
              {line.hours && line.hourlyRate ? (
                <p>
                  {line.hours} ساعة × {line.hourlyRate}
                </p>
              ) : null}
              {line.driverLabel ? <p>{line.driverLabel}</p> : null}
              {line.paidOn ? <p>اتدفع {formatIsoDate(line.paidOn)}</p> : null}
              {line.note ? <p>{line.note}</p> : null}
              {line.voidReason ? <p>سبب الإلغاء: {line.voidReason}</p> : null}
              {!line.voided ? (
                <button
                  className={secondaryButton}
                  type="button"
                  disabled={disabled}
                  onClick={() => openVoid(line.id)}
                >
                  إلغاء المصروف
                </button>
              ) : null}
              {open ? (
                <div className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1">
                    سبب الإلغاء
                    <input
                      className={fieldClass}
                      value={reason}
                      disabled={disabled}
                      readOnly={pending}
                      onChange={(event) => {
                        setReason(event.target.value);
                        setReasonError(null);
                      }}
                    />
                  </label>
                  {pending ? (
                    <p>
                      الإلغاء اللي فات ممكن يكون اتسجل — هيتبعت تاني بنفس السبب
                    </p>
                  ) : null}
                  {reasonError ? <p role="alert">{reasonError}</p> : null}
                  <button
                    className={secondaryButton}
                    type="button"
                    disabled={disabled}
                    onClick={confirmVoid}
                  >
                    تأكيد الإلغاء
                  </button>
                </div>
              ) : null}
            </article>
          </li>
        );
      })}
    </ul>
  );
}
