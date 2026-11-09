import { useState } from 'react';
import { UnknownSave } from '@/items/UnknownSave';
import { isBaseUnit } from '@/items/types';
import { formatCairo } from '@/lib/cairo';
import { primaryButton, secondaryButton } from '@/lib/page-style';
import { formatCairoDateTime } from '@/purchases/time';
import type { StockChoice } from '@/purchases/types';
import {
  documentKindLabels,
  documentSubject,
  moneyText,
  reasonLabels,
  type FormStart,
} from '@/waste/format';
import type { HistoryEntry } from '@/waste/types';
import { useWasteAction } from '@/waste/useWasteAction';
import { WasteForm } from '@/waste/WasteForm';
import { WasteLines } from '@/waste/WasteLines';
import { WasteNoticeView } from '@/waste/WasteNotice';

function Num({ value }: { value: string }) {
  return <span dir="ltr">{value}</span>;
}

function startFrom(entry: HistoryEntry): FormStart {
  const local = formatCairoDateTime(entry.occurredAt).replace(' ', 'T');
  return {
    values: {
      at: local,
      reason: entry.reason === 'cancel_after_preparation' ? '' : entry.reason,
      explanation: entry.explanation ?? '',
      lines: entry.lines.map((line, index) => ({
        key: `l${index}`,
        itemId: line.itemId,
        quantity: line.inputQuantity,
        unit: line.inputUnit,
      })),
    },
    original: { local, iso: entry.occurredAt },
  };
}

/** Active items plus the ones this document used, which may be inactive now. */
function choicesFor(
  choices: readonly StockChoice[],
  entry: HistoryEntry,
): StockChoice[] {
  const known = new Set(choices.map((choice) => choice.id));
  const extra: StockChoice[] = entry.lines
    .filter((line) => !known.has(line.itemId))
    .map((line) => ({
      id: line.itemId,
      name: line.name,
      kind: 'ingredient',
      baseUnit: isBaseUnit(line.baseUnit) ? line.baseUnit : 'kg',
      parentItemId: null,
      active: false,
      hasMovements: true,
      conversions: [],
    }));
  return [...choices, ...extra];
}

function stateLabel(entry: HistoryEntry): string {
  if (entry.isVoid) return 'ملغي';
  return entry.isCurrent ? 'الحالي' : 'اتصحّح';
}

type Mode = 'idle' | 'correct' | 'void';

function EntryActions({
  entry,
  choices,
  names,
  reload,
}: {
  entry: HistoryEntry;
  choices: readonly StockChoice[];
  names: Readonly<Record<string, string>>;
  reload: () => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>('idle');
  const action = useWasteAction(documentSubject(entry.id), {
    reload,
    onSaved: () => setMode('idle'),
  });
  const canChange = entry.isCurrent && !entry.isVoid;
  if (!canChange && !action.held && !action.notice) return null;
  const locked = action.saving || action.held !== null;

  return (
    <div className="flex flex-col gap-2">
      {action.held ? (
        <UnknownSave disabled={action.saving} onRetry={action.retry} />
      ) : null}
      {action.notice ? (
        <WasteNoticeView notice={action.notice} names={names} />
      ) : null}
      {canChange && mode === 'idle' ? (
        <div className="flex flex-wrap gap-2">
          <button
            className={secondaryButton}
            type="button"
            disabled={locked}
            onClick={() => {
              action.clearNotice();
              setMode('correct');
            }}
          >
            تصحيح
          </button>
          <button
            className={secondaryButton}
            type="button"
            disabled={locked}
            onClick={() => {
              action.clearNotice();
              setMode('void');
            }}
          >
            إلغاء السجل
          </button>
        </div>
      ) : null}
      {canChange && mode === 'correct' ? (
        <WasteForm
          choices={choicesFor(choices, entry)}
          action={action}
          start={startFrom(entry)}
          predecessorId={entry.id}
          label={`تصحيح السجل رقم ${entry.id}`}
          submitLabel="حفظ التصحيح"
          onCancel={() => setMode('idle')}
        />
      ) : null}
      {canChange && mode === 'void' ? (
        <div className="flex flex-col gap-2">
          <p>السجل ده هيتلغي والكمية هترجع للمخزون. متأكد؟</p>
          <div className="flex flex-wrap gap-2">
            <button
              className={primaryButton}
              type="button"
              disabled={locked}
              onClick={() =>
                action.send((requestId) => ({
                  requestId,
                  document: { kind: 'void', predecessorId: entry.id },
                }))
              }
            >
              تأكيد الإلغاء
            </button>
            <button
              className={secondaryButton}
              type="button"
              disabled={locked}
              onClick={() => setMode('idle')}
            >
              رجوع
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EntryCard({
  entry,
  choices,
  names,
  reload,
}: {
  entry: HistoryEntry;
  choices: readonly StockChoice[];
  names: Readonly<Record<string, string>>;
  reload: () => Promise<void>;
}) {
  return (
    <article
      className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
      aria-label={`سجل رقم ${entry.id}`}
    >
      <header className="flex flex-col gap-1">
        <h3 className="font-semibold">
          {documentKindLabels[entry.kind]} — {stateLabel(entry)}
        </h3>
        <p>
          {formatCairo(entry.occurredAt)} — {reasonLabels[entry.reason]}
        </p>
        {entry.explanation ? <p>الشرح: {entry.explanation}</p> : null}
        <p>
          اتسجل في {formatCairo(entry.createdAt)}
          {entry.predecessorId ? ` — بدل السجل رقم ${entry.predecessorId}` : ''}
          {entry.successorId ? ` — اتصحّح بالسجل رقم ${entry.successorId}` : ''}
        </p>
      </header>
      {entry.lines.length > 0 ? (
        <WasteLines
          label="السطور"
          lines={entry.lines.map((line) => ({ ...line }))}
        />
      ) : null}
      <p>
        قيمة الهالك: <Num value={moneyText(entry.value)} />
      </p>
      <EntryActions
        entry={entry}
        choices={choices}
        names={names}
        reload={reload}
      />
    </article>
  );
}

export function WasteHistory({
  entries,
  choices,
  names,
  reload,
}: {
  entries: readonly HistoryEntry[];
  choices: readonly StockChoice[];
  names: Readonly<Record<string, string>>;
  reload: () => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry) => (
        <EntryCard
          key={entry.id}
          entry={entry}
          choices={choices}
          names={names}
          reload={reload}
        />
      ))}
    </div>
  );
}
