import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  addConversion,
  deleteConversion,
  listConversions,
  updateConversion,
  type ConversionList,
} from '@/items/api';
import { messageFrom, StaleWriteError } from '@/items/errors';
import { formatStoredFactor } from '@/items/format';
import { unitLabels } from '@/items/labels';
import type { BaseUnit, CatalogItem, UnitConversion } from '@/items/types';
import { validateConversion } from '@/items/validation';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';
const primaryButton =
  'rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60';
const secondaryButton =
  'rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

function ConversionRow({
  conversion,
  baseLabel,
  baseUnit,
  disabled,
  onSave,
  onDelete,
}: {
  conversion: UnitConversion;
  baseLabel: string;
  baseUnit: BaseUnit;
  disabled: boolean;
  onSave: (factor: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [factor, setFactor] = useState(() =>
    formatStoredFactor(conversion.storedFactor),
  );
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = validateConversion(conversion.unit, factor, baseUnit);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    void onSave(parsed.factor);
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-neutral-200 p-2">
      <p>
        1 {conversion.unit} = {formatStoredFactor(conversion.storedFactor)}{' '}
        {baseLabel}
      </p>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={onSubmit}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="sr-only">معامل {conversion.unit}</span>
          <input
            className={fieldClass}
            dir="ltr"
            inputMode="decimal"
            disabled={disabled}
            value={factor}
            onChange={(event) => setFactor(event.target.value)}
          />
        </label>
        <button className={primaryButton} type="submit" disabled={disabled}>
          حفظ المعامل
        </button>
        <button
          className={secondaryButton}
          type="button"
          disabled={disabled}
          onClick={() => void onDelete()}
        >
          احذف التحويل
        </button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

function storedFactorText(value: UnitConversion['storedFactor']): string {
  return typeof value === 'string' ? value : String(value);
}

export function ConversionsPanel({
  item,
  locked = false,
  onBusyChange,
  onItemStale,
}: {
  item: CatalogItem;
  /** Set by the page while an item save is in flight. */
  locked?: boolean;
  onBusyChange?: (busy: boolean) => void;
  /** The snapshot base unit no longer matches the item the page rendered. */
  onItemStale?: () => void | Promise<void>;
}) {
  const requestRef = useRef(0);
  const onItemStaleRef = useRef(onItemStale);
  const itemBaseUnitRef = useRef(item.baseUnit);
  useEffect(() => {
    onItemStaleRef.current = onItemStale;
    itemBaseUnitRef.current = item.baseUnit;
  }, [item.baseUnit, onItemStale]);
  const [rows, setRows] = useState<UnitConversion[] | null>(null);
  const [baseUnit, setBaseUnit] = useState<BaseUnit | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unit, setUnit] = useState('');
  const [factor, setFactor] = useState('');

  const applySnapshot = useCallback(
    async (
      next: ConversionList,
      requestId: number,
      cancelled: () => boolean,
    ) => {
      if (cancelled() || requestId !== requestRef.current) return;
      setRows(next.rows);
      setBaseUnit(next.baseUnit);
      setLoadError(null);
      if (next.baseUnit !== itemBaseUnitRef.current) {
        await onItemStaleRef.current?.();
      }
    },
    [],
  );

  const failLoad = useCallback(
    async (error: unknown, requestId: number, cancelled: () => boolean) => {
      if (cancelled() || requestId !== requestRef.current) return;
      setLoadError(messageFrom(error));
      if (error instanceof StaleWriteError) await onItemStaleRef.current?.();
    },
    [],
  );

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const next = await listConversions(item.id);
      await applySnapshot(next, requestId, () => false);
    } catch (error) {
      await failLoad(error, requestId, () => false);
    }
  }, [applySnapshot, failLoad, item.id]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    let cancelled = false;

    void (async () => {
      try {
        const next = await listConversions(item.id);
        await applySnapshot(next, requestId, () => cancelled);
      } catch (error) {
        await failLoad(error, requestId, () => cancelled);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applySnapshot, failLoad, item.id]);

  async function run(work: () => Promise<void>) {
    if (busy || locked) return;
    setBusy(true);
    onBusyChange?.(true);
    setActionError(null);
    try {
      await work();
      await load();
    } catch (error) {
      setActionError(messageFrom(error));
      if (error instanceof StaleWriteError) await load();
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!baseUnit) return;
    const parsed = validateConversion(unit, factor, baseUnit);
    if (!parsed.ok) {
      setActionError(parsed.error);
      return;
    }
    const expectedBaseUnit = baseUnit;
    void run(async () => {
      await addConversion(
        item.id,
        parsed.unit,
        parsed.factor,
        expectedBaseUnit,
      );
      setUnit('');
      setFactor('');
    });
  }

  if ((rows === null || baseUnit === null) && loadError) {
    return (
      <div className="flex flex-col gap-2">
        <p role="alert">{loadError}</p>
        <button
          className={secondaryButton}
          type="button"
          onClick={() => void load()}
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (rows === null || baseUnit === null) {
    return <p>جاري تحميل التحويلات…</p>;
  }

  const baseLabel = unitLabels[baseUnit];

  return (
    <div className="flex flex-col gap-3">
      {loadError ? (
        <div className="flex flex-col gap-2">
          <p role="alert">{loadError}</p>
          <button
            className={secondaryButton}
            type="button"
            onClick={() => void load()}
          >
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {rows.length === 0 && !loadError ? <p>مفيش تحويلات للصنف ده</p> : null}
      {rows.map((conversion) => (
        <ConversionRow
          key={`${conversion.unit}@${String(conversion.storedFactor)}@${baseUnit}`}
          conversion={conversion}
          baseLabel={baseLabel}
          baseUnit={baseUnit}
          disabled={busy || locked}
          onSave={(nextFactor) =>
            run(() =>
              updateConversion(
                item.id,
                conversion.unit,
                nextFactor,
                storedFactorText(conversion.storedFactor),
                baseUnit,
              ),
            )
          }
          onDelete={() =>
            run(() =>
              deleteConversion(
                item.id,
                conversion.unit,
                storedFactorText(conversion.storedFactor),
                baseUnit,
              ),
            )
          }
        />
      ))}
      <form className="flex flex-col gap-2" onSubmit={onAdd}>
        <label className="flex flex-col gap-1">
          اسم الوحدة
          <input
            className={fieldClass}
            autoComplete="off"
            disabled={busy || locked}
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          المعامل
          <input
            className={fieldClass}
            dir="ltr"
            inputMode="decimal"
            disabled={busy || locked}
            value={factor}
            onChange={(event) => setFactor(event.target.value)}
          />
        </label>
        <p className="text-sm text-neutral-600">
          1 من الوحدة دي = كام {baseLabel}
        </p>
        {actionError ? <p role="alert">{actionError}</p> : null}
        <button
          className={primaryButton}
          type="submit"
          disabled={busy || locked}
        >
          ضيف التحويل
        </button>
      </form>
    </div>
  );
}
