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
  onVoid,
}: {
  entries: readonly ExpenseLine[];
  disabled: boolean;
  onVoid: (id: string, reason: string) => void;
}) {
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  function openVoid(id: string) {
    if (disabled) return;
    setVoidingId(id);
    setReason('');
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
                      onChange={(event) => {
                        setReason(event.target.value);
                        setReasonError(null);
                      }}
                    />
                  </label>
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
