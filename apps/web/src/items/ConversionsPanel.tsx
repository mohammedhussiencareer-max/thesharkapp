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
} from '@/items/api';
import { messageFrom } from '@/items/errors';
import { formatFactorInput, formatQty } from '@/items/format';
import { unitLabels } from '@/items/labels';
import type { CatalogItem, UnitConversion } from '@/items/types';
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
  baseUnit: CatalogItem['baseUnit'];
  disabled: boolean;
  onSave: (factor: number) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [factor, setFactor] = useState(() =>
    formatFactorInput(conversion.factorToBase),
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
        1 {conversion.unit} = {formatQty(conversion.factorToBase)} {baseLabel}
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

export function ConversionsPanel({ item }: { item: CatalogItem }) {
  const requestRef = useRef(0);
  const [rows, setRows] = useState<UnitConversion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unit, setUnit] = useState('');
  const [factor, setFactor] = useState('');
  const baseLabel = unitLabels[item.baseUnit];

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const next = await listConversions(item.id);
      if (requestId !== requestRef.current) return;
      setRows(next);
      setLoadError(null);
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setLoadError(messageFrom(error));
    }
  }, [item.id]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    let cancelled = false;

    void (async () => {
      try {
        const next = await listConversions(item.id);
        if (cancelled || requestId !== requestRef.current) return;
        setRows(next);
        setLoadError(null);
      } catch (error) {
        if (cancelled || requestId !== requestRef.current) return;
        setLoadError(messageFrom(error));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [item.id]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      await load();
    } catch (error) {
      setActionError(messageFrom(error));
    } finally {
      setBusy(false);
    }
  }

  function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = validateConversion(unit, factor, item.baseUnit);
    if (!parsed.ok) {
      setActionError(parsed.error);
      return;
    }
    void run(async () => {
      await addConversion(item.id, parsed.unit, parsed.factor);
      setUnit('');
      setFactor('');
    });
  }

  if (rows === null && loadError) {
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

  if (rows === null) {
    return <p>جاري تحميل التحويلات…</p>;
  }

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
          key={`${conversion.unit}@${conversion.factorToBase}`}
          conversion={conversion}
          baseLabel={baseLabel}
          baseUnit={item.baseUnit}
          disabled={busy}
          onSave={(nextFactor) =>
            run(() => updateConversion(item.id, conversion.unit, nextFactor))
          }
          onDelete={() => run(() => deleteConversion(item.id, conversion.unit))}
        />
      ))}
      <form className="flex flex-col gap-2" onSubmit={onAdd}>
        <label className="flex flex-col gap-1">
          اسم الوحدة
          <input
            className={fieldClass}
            autoComplete="off"
            disabled={busy}
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
            disabled={busy}
            value={factor}
            onChange={(event) => setFactor(event.target.value)}
          />
        </label>
        <p className="text-sm text-neutral-600">
          1 من الوحدة دي = كام {baseLabel}
        </p>
        {actionError ? <p role="alert">{actionError}</p> : null}
        <button className={primaryButton} type="submit" disabled={busy}>
          ضيف التحويل
        </button>
      </form>
    </div>
  );
}
