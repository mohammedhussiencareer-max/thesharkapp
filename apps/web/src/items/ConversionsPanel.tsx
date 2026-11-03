import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  addConversion,
  addCustomUnit,
  costingImpact,
  currentShiftStart,
  deleteConversion,
  listConversions,
  listCostingSchedule,
  listUnitOptions,
  updateConversion,
  type ConversionList,
} from '@/items/api';
import { EffectiveTimeFields } from '@/items/EffectiveTimeFields';
import {
  buildDatedWrite,
  defaultEffectiveMode,
  effectiveFromPayload,
  emptyScheduleToken,
  impactLine,
  needsBackdatedReason,
  nextVersionStart,
  type EffectiveMode,
} from '@/items/effective';
import { messageFrom, StaleWriteError } from '@/items/errors';
import { formatStoredFactor } from '@/items/format';
import { unitLabels } from '@/items/labels';
import type {
  BaseUnit,
  CatalogItem,
  CostingSchedule,
  CostingVersion,
  DatedWrite,
  UnitCatalogOption,
  UnitConversion,
} from '@/items/types';
import { validateConversion } from '@/items/validation';
import { formatCairo } from '@/lib/cairo';
import { cairoDateTimeLocalToIso } from '@/purchases/time';

const noVersions: readonly CostingVersion[] = [];

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';
const primaryButton =
  'rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60';
const secondaryButton =
  'rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

function storedFactorText(value: UnitConversion['storedFactor']): string {
  return typeof value === 'string' ? value : String(value);
}

function useRequestIds() {
  const ids = useRef(new Map<string, string>());
  return (key: string) => {
    const existing = ids.current.get(key);
    if (existing) return existing;
    const next = crypto.randomUUID();
    ids.current.set(key, next);
    return next;
  };
}

function useDatedTiming(
  itemId: string,
  shiftStart: string | null,
  versions: readonly CostingVersion[],
  token: string,
  disabled: boolean,
) {
  const requestId = useRequestIds();
  const [nowMs] = useState(() => Date.now());
  const [chosenMode, setChosenMode] = useState<EffectiveMode | null>(null);
  const mode = chosenMode ?? defaultEffectiveMode(shiftStart);
  const [customLocal, setCustomLocal] = useState('');
  const [reason, setReason] = useState('');
  const customIso =
    mode === 'custom' ? cairoDateTimeLocalToIso(customLocal) : null;
  const backdated = needsBackdatedReason(mode, shiftStart, customIso, nowMs);
  const from = backdated
    ? effectiveFromPayload(mode, shiftStart, customIso)
    : null;
  const to = from
    ? nextVersionStart(versions, from, new Date(nowMs).toISOString())
    : null;
  const impactKey = from ? `${from}|${to ?? ''}` : '';
  const [impactText, setImpactText] = useState<{
    key: string;
    text: string;
  } | null>(null);
  const shownImpact =
    impactText?.key === impactKey && impactText.text.length > 0
      ? impactText.text
      : null;

  useEffect(() => {
    if (!from || impactKey.length === 0) return;
    let cancelled = false;
    void costingImpact(from, to, itemId)
      .then((impact) => {
        if (cancelled) return;
        setImpactText({
          key: impactKey,
          text: impactLine(impact.orders, impact.shifts),
        });
      })
      .catch(() => {
        if (!cancelled) setImpactText({ key: impactKey, text: '' });
      });
    return () => {
      cancelled = true;
    };
  }, [from, impactKey, itemId, to]);

  function build(
    factorKey: string,
  ): { ok: true; write: DatedWrite } | { ok: false; error: string } {
    return buildDatedWrite({
      mode,
      shiftStart,
      customIso,
      versions,
      nowIso: new Date(nowMs).toISOString(),
      token,
      reason,
      requestId: requestId(
        `${factorKey}:${mode}:${customIso ?? ''}:${reason.trim()}`,
      ),
    });
  }

  const fields = (
    <EffectiveTimeFields
      mode={mode}
      shiftStart={shiftStart}
      customLocal={customLocal}
      reason={reason}
      backdated={backdated}
      impact={shownImpact}
      disabled={disabled}
      onMode={setChosenMode}
      onCustomLocal={setCustomLocal}
      onReason={setReason}
    />
  );

  return { fields, build };
}

function ConversionRow({
  conversion,
  baseLabel,
  baseUnit,
  disabled,
  shiftStart,
  versions,
  token,
  onSave,
  onDelete,
}: {
  conversion: UnitConversion;
  baseLabel: string;
  baseUnit: BaseUnit;
  disabled: boolean;
  shiftStart: string | null;
  versions: readonly CostingVersion[];
  token: string;
  onSave: (factor: string, timing: DatedWrite) => Promise<void>;
  onDelete: (timing: DatedWrite) => Promise<void>;
}) {
  const [factor, setFactor] = useState(() =>
    formatStoredFactor(conversion.storedFactor),
  );
  const [error, setError] = useState<string | null>(null);
  const timing = useDatedTiming(
    conversion.itemId,
    shiftStart,
    versions,
    token,
    disabled,
  );
  const name = conversion.label ?? conversion.unit;
  const when = conversion.effectiveFrom
    ? ` من ${formatCairo(conversion.effectiveFrom)}`
    : '';
  const automatic = conversion.source === 'implicit' ? ' تلقائي' : '';
  const readOnly = conversion.source === 'implicit';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = validateConversion(conversion.unit, factor, baseUnit);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const built = timing.build(parsed.factor);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    void onSave(parsed.factor, built.write);
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-neutral-200 p-2">
      <p>
        1 {name} = {formatStoredFactor(conversion.storedFactor)} {baseLabel}
        {when}
        {automatic}
      </p>
      {readOnly ? null : (
        <form
          className="flex flex-col gap-2"
          aria-label={`تحويل ${name}`}
          onSubmit={onSubmit}
        >
          {timing.fields}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
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
              onClick={() => {
                const built = timing.build('delete');
                if (!built.ok) {
                  setError(built.error);
                  return;
                }
                setError(null);
                void onDelete(built.write);
              }}
            >
              احذف التحويل
            </button>
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </form>
      )}
    </div>
  );
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
  onItemStale?: (itemId: string) => void | Promise<void>;
}) {
  const requestRef = useRef(0);
  const aliveRef = useRef(false);
  const onItemStaleRef = useRef(onItemStale);
  const itemBaseUnitRef = useRef(item.baseUnit);
  useEffect(() => {
    onItemStaleRef.current = onItemStale;
    itemBaseUnitRef.current = item.baseUnit;
  }, [item.baseUnit, onItemStale]);
  const [rows, setRows] = useState<UnitConversion[] | null>(null);
  const [baseUnit, setBaseUnit] = useState<BaseUnit | null>(null);
  const [schedule, setSchedule] = useState<CostingSchedule | null>(null);
  const [meta, setMeta] = useState<{
    itemId: string;
    shiftStart: string | null;
    unitOptions: UnitCatalogOption[];
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unit, setUnit] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [factor, setFactor] = useState('');
  const addCode = unit === '__new__' ? customCode.trim() : unit.trim();
  const addEntry = schedule?.conversions.find(
    (candidate) => candidate.unitCode === addCode,
  );
  const metaReady = meta?.itemId === item.id;
  const shiftStart = metaReady ? (meta?.shiftStart ?? null) : null;
  const unitOptions = metaReady ? (meta?.unitOptions ?? []) : [];
  const controlsDisabled = busy || locked || !metaReady || schedule === null;
  const addTiming = useDatedTiming(
    item.id,
    shiftStart,
    addEntry?.versions ?? noVersions,
    addEntry?.token ?? emptyScheduleToken,
    controlsDisabled,
  );

  const applySnapshot = useCallback(
    async (
      itemId: string,
      next: ConversionList,
      requestId: number,
      cancelled: () => boolean,
    ) => {
      if (!aliveRef.current || cancelled() || requestId !== requestRef.current)
        return;
      setRows(next.rows);
      setBaseUnit(next.baseUnit);
      setLoadError(null);
      if (next.baseUnit !== itemBaseUnitRef.current) {
        await onItemStaleRef.current?.(itemId);
      }
    },
    [],
  );

  const failLoad = useCallback(
    async (
      itemId: string,
      error: unknown,
      requestId: number,
      cancelled: () => boolean,
    ) => {
      if (!aliveRef.current || cancelled() || requestId !== requestRef.current)
        return;
      setLoadError(messageFrom(error));
      if (error instanceof StaleWriteError) {
        await onItemStaleRef.current?.(itemId);
      }
    },
    [],
  );

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const [next, nextSchedule] = await Promise.all([
        listConversions(item.id),
        listCostingSchedule(item.id),
      ]);
      if (!aliveRef.current || requestId !== requestRef.current) return;
      setSchedule(nextSchedule);
      await applySnapshot(item.id, next, requestId, () => false);
    } catch (error) {
      await failLoad(item.id, error, requestId, () => false);
    }
  }, [applySnapshot, failLoad, item.id]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    let cancelled = false;
    aliveRef.current = true;

    void (async () => {
      try {
        const [next, nextSchedule] = await Promise.all([
          listConversions(item.id),
          listCostingSchedule(item.id),
        ]);
        if (!aliveRef.current || cancelled || requestId !== requestRef.current)
          return;
        setSchedule(nextSchedule);
        await applySnapshot(item.id, next, requestId, () => cancelled);
      } catch (error) {
        await failLoad(item.id, error, requestId, () => cancelled);
      }
    })();

    return () => {
      cancelled = true;
      aliveRef.current = false;
    };
  }, [applySnapshot, failLoad, item.id]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([currentShiftStart(), listUnitOptions()])
      .then(([shift, options]) => {
        if (cancelled) return;
        setMeta({
          itemId: item.id,
          shiftStart: shift,
          unitOptions: options,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(messageFrom(error));
      });
    return () => {
      cancelled = true;
    };
  }, [item.id]);

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
    const code = unit === '__new__' ? customCode.trim() : unit.trim();
    if (unit === '__new__') {
      if (code.length < 1 || code.length > 20) {
        setActionError('كود الوحدة من حرف لحد 20');
        return;
      }
      const label = customLabel.trim();
      if (label.length < 1 || label.length > 40) {
        setActionError('اسم الوحدة من حرف لحد 40');
        return;
      }
    }
    const parsed = validateConversion(code, factor, baseUnit);
    if (!parsed.ok) {
      setActionError(parsed.error);
      return;
    }
    const built = addTiming.build(parsed.factor);
    if (!built.ok) {
      setActionError(built.error);
      return;
    }
    const expectedBaseUnit = baseUnit;
    const label = customLabel.trim();
    void run(async () => {
      const unitCode =
        unit === '__new__'
          ? await addCustomUnit(parsed.unit, label)
          : parsed.unit;
      await addConversion(
        item.id,
        unitCode,
        parsed.factor,
        expectedBaseUnit,
        built.write,
      );
      setUnit('');
      setCustomCode('');
      setCustomLabel('');
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
      {rows.map((conversion) => {
        const entry = schedule?.conversions.find(
          (candidate) => candidate.unitCode === conversion.unit,
        );
        return (
          <ConversionRow
            key={`${conversion.unit}@${String(conversion.storedFactor)}@${baseUnit}@${conversion.source ?? ''}`}
            conversion={conversion}
            baseLabel={baseLabel}
            baseUnit={baseUnit}
            disabled={controlsDisabled}
            shiftStart={shiftStart}
            versions={entry?.versions ?? noVersions}
            token={entry?.token ?? emptyScheduleToken}
            onSave={(nextFactor, timing) =>
              run(() =>
                updateConversion(
                  item.id,
                  conversion.unit,
                  nextFactor,
                  storedFactorText(conversion.storedFactor),
                  baseUnit,
                  timing,
                ),
              )
            }
            onDelete={(timing) =>
              run(() =>
                deleteConversion(
                  item.id,
                  conversion.unit,
                  storedFactorText(conversion.storedFactor),
                  baseUnit,
                  timing,
                ),
              )
            }
          />
        );
      })}
      {schedule &&
      schedule.conversions.some((entry) => entry.versions.length > 0) ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-base font-semibold">سجل التحويلات</h3>
          {schedule.conversions.map((entry) =>
            entry.versions.length === 0 ? null : (
              <div key={entry.unitCode}>
                <p>
                  {unitOptions.find((option) => option.code === entry.unitCode)
                    ?.labelAr ?? entry.unitCode}
                </p>
                <ul className="flex flex-col gap-1">
                  {entry.versions.map((version) => (
                    <li key={version.id}>
                      {`${version.valueText} من ${formatCairo(version.effectiveFrom)}${
                        version.effectiveTo
                          ? ` إلى ${formatCairo(version.effectiveTo)}`
                          : ''
                      }`}
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </div>
      ) : null}
      <form
        className="flex flex-col gap-2"
        aria-label="إضافة تحويل"
        onSubmit={onAdd}
      >
        <label className="flex flex-col gap-1">
          الوحدة
          <select
            className={fieldClass}
            disabled={controlsDisabled}
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
          >
            <option value="">اختار</option>
            {unitOptions.map((option) => (
              <option key={option.code} value={option.code}>
                {option.labelAr}
              </option>
            ))}
            <option value="__new__">وحدة جديدة</option>
          </select>
        </label>
        {unit === '__new__' ? (
          <>
            <label className="flex flex-col gap-1">
              كود الوحدة
              <input
                className={fieldClass}
                dir="ltr"
                autoComplete="off"
                disabled={controlsDisabled}
                value={customCode}
                onChange={(event) => setCustomCode(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              اسم الوحدة
              <input
                className={fieldClass}
                autoComplete="off"
                disabled={controlsDisabled}
                value={customLabel}
                onChange={(event) => setCustomLabel(event.target.value)}
              />
            </label>
          </>
        ) : null}
        <label className="flex flex-col gap-1">
          المعامل
          <input
            className={fieldClass}
            dir="ltr"
            inputMode="decimal"
            disabled={controlsDisabled}
            value={factor}
            onChange={(event) => setFactor(event.target.value)}
          />
        </label>
        {addTiming.fields}
        <p className="text-sm text-neutral-600">
          1 من الوحدة دي = كام {baseLabel}
        </p>
        {actionError ? <p role="alert">{actionError}</p> : null}
        <button
          className={primaryButton}
          type="submit"
          disabled={controlsDisabled}
        >
          ضيف التحويل
        </button>
      </form>
    </div>
  );
}
