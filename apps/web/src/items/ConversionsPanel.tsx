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
  currentShiftStart,
  deleteConversion,
  listConversions,
  listCostingSchedule,
  listUnitOptions,
  updateConversion,
  type ConversionList,
} from '@/items/api';
import { emptyScheduleToken } from '@/items/effective';
import {
  identityOutOfDateMessage,
  messageFrom,
  saveDetailsFirstMessage,
  StaleWriteError,
} from '@/items/errors';
import {
  beginAction,
  conversionSubject,
  hasAction,
  settleAction,
  unknownAction,
} from '@/items/request-id';
import { UnknownSave } from '@/items/UnknownSave';
import { useDatedTiming } from '@/items/useDatedTiming';
import { formatStoredFactor } from '@/items/format';
import { unitLabels } from '@/items/labels';
import {
  itemIdentity,
  type BaseUnit,
  type CatalogItem,
  type CostingSchedule,
  type CostingVersion,
  type DatedWrite,
  type UnitCatalogOption,
  type UnitConversion,
} from '@/items/types';
import { validateConversion } from '@/items/validation';
import { formatCairo } from '@/lib/cairo';

const noVersions: readonly CostingVersion[] = [];

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';
const primaryButton =
  'rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60';
const secondaryButton =
  'rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

function storedFactorText(value: UnitConversion['storedFactor']): string {
  return typeof value === 'string' ? value : String(value);
}

/**
 * One outstanding conversion, stored in the module map. Replay uses this
 * record alone: kind, arguments, request ids, and any stage already completed.
 */
type ConversionAction =
  | {
      kind: 'set_conversion';
      itemId: string;
      unit: string;
      factor: string;
      expectedFactor: string;
      baseUnit: BaseUnit;
      write: DatedWrite;
      via: 'add' | 'edit';
    }
  | {
      kind: 'remove_conversion';
      itemId: string;
      unit: string;
      expectedFactor: string;
      baseUnit: BaseUnit;
      write: DatedWrite;
    }
  | {
      kind: 'create_unit_then_conversion';
      itemId: string;
      inputCode: string;
      label: string;
      /** Server code once the custom unit exists. Null until that call returns. */
      createdCode: string | null;
      unitRequestId: string;
      factor: string;
      baseUnit: BaseUnit;
      write: DatedWrite;
    };

function actionSubject(action: ConversionAction): string {
  const unit =
    action.kind === 'create_unit_then_conversion'
      ? action.inputCode
      : action.unit;
  return conversionSubject(action.itemId, unit);
}

function ConversionRow({
  conversion,
  baseLabel,
  baseUnit,
  disabled,
  identityDirty,
  shiftStart,
  versions,
  token,
  onReplay,
}: {
  conversion: UnitConversion;
  baseLabel: string;
  baseUnit: BaseUnit;
  disabled: boolean;
  /** Fresh saves wait; a held retry still replays unchanged. */
  identityDirty: boolean;
  shiftStart: string | null;
  versions: readonly CostingVersion[];
  token: string;
  onReplay: (action: ConversionAction) => Promise<void>;
}) {
  const subject = conversionSubject(conversion.itemId, conversion.unit);
  const [factor, setFactor] = useState(() =>
    formatStoredFactor(conversion.storedFactor),
  );
  const [error, setError] = useState<string | null>(null);
  const [actionEpoch, setActionEpoch] = useState(0);
  const flight = useRef(false);
  const held =
    actionEpoch < 0 ? null : unknownAction<ConversionAction>(subject);
  const blocked = held !== null;
  const sectionDisabled = disabled || blocked;
  const timing = useDatedTiming(
    conversion.itemId,
    shiftStart,
    versions,
    token,
    sectionDisabled,
  );
  const name = conversion.label ?? conversion.unit;
  const when = conversion.effectiveFrom
    ? ` من ${formatCairo(conversion.effectiveFrom)}`
    : '';
  const automatic = conversion.source === 'implicit' ? ' تلقائي' : '';
  const readOnly = conversion.source === 'implicit';

  async function finish(action: ConversionAction) {
    if (flight.current) return;
    flight.current = true;
    try {
      await onReplay(action);
    } finally {
      flight.current = false;
      setActionEpoch((value) => value + 1);
    }
  }

  function begin(create: (write: DatedWrite) => ConversionAction) {
    if (
      disabled ||
      identityDirty ||
      blocked ||
      flight.current ||
      hasAction(subject)
    ) {
      return;
    }
    const built = timing.build();
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    const action = beginAction(subject, (requestId) =>
      create({ ...built.write, requestId }),
    );
    void finish(action);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      disabled ||
      identityDirty ||
      blocked ||
      flight.current ||
      hasAction(subject)
    ) {
      return;
    }
    const parsed = validateConversion(conversion.unit, factor, baseUnit);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const nextFactor = parsed.factor;
    begin((write) => ({
      kind: 'set_conversion',
      via: 'edit',
      itemId: conversion.itemId,
      unit: conversion.unit,
      factor: nextFactor,
      expectedFactor: storedFactorText(conversion.storedFactor),
      baseUnit,
      write,
    }));
  }

  function retry() {
    if (!held || disabled || flight.current) return;
    setError(null);
    void finish(held);
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
                disabled={sectionDisabled}
                value={factor}
                onChange={(event) => {
                  if (sectionDisabled) return;
                  setFactor(event.target.value);
                }}
              />
            </label>
            <button
              className={primaryButton}
              type="submit"
              disabled={sectionDisabled || identityDirty}
            >
              حفظ المعامل
            </button>
            <button
              className={secondaryButton}
              type="button"
              disabled={sectionDisabled || identityDirty}
              onClick={() =>
                begin((write) => ({
                  kind: 'remove_conversion',
                  itemId: conversion.itemId,
                  unit: conversion.unit,
                  expectedFactor: storedFactorText(conversion.storedFactor),
                  baseUnit,
                  write,
                }))
              }
            >
              احذف التحويل
            </button>
          </div>
          {held ? <UnknownSave disabled={disabled} onRetry={retry} /> : null}
          {error ? <p role="alert">{error}</p> : null}
        </form>
      )}
    </div>
  );
}

export function ConversionsPanel({
  item,
  locked = false,
  identityDirty = false,
  onBusyChange,
  onItemStale,
  onConversionSaved,
}: {
  item: CatalogItem;
  /** Set by the page while an item save is in flight. */
  locked?: boolean;
  /** The open editor holds a kind, base unit or parent that is not saved. */
  identityDirty?: boolean;
  onBusyChange?: (busy: boolean) => void;
  /** The snapshot base unit no longer matches the item the page rendered. */
  onItemStale?: (itemId: string) => void | Promise<void>;
  /** A write landed, so the item's configuration status may have changed. */
  onConversionSaved?: (itemId: string) => void | Promise<void>;
}) {
  const requestRef = useRef(0);
  const aliveRef = useRef(false);
  const onItemStaleRef = useRef(onItemStale);
  const itemBaseUnitRef = useRef(item.baseUnit);
  const identityKey = itemIdentity(item);
  const itemIdentityRef = useRef(identityKey);
  const addFlight = useRef(false);
  const replayFlight = useRef(new Set<string>());
  useEffect(() => {
    onItemStaleRef.current = onItemStale;
    itemBaseUnitRef.current = item.baseUnit;
    itemIdentityRef.current = identityKey;
  }, [identityKey, item.baseUnit, onItemStale]);
  const [rows, setRows] = useState<UnitConversion[] | null>(null);
  const [baseUnit, setBaseUnit] = useState<BaseUnit | null>(null);
  const [schedule, setSchedule] = useState<CostingSchedule | null>(null);
  const [meta, setMeta] = useState<{
    itemId: string;
    shiftStart: string | null;
    unitOptions: UnitCatalogOption[];
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaAttempt, setMetaAttempt] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionEpoch, setActionEpoch] = useState(0);
  const [unit, setUnit] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [factor, setFactor] = useState('');
  const [createdUnit, setCreatedUnit] = useState<{
    code: string;
    inputCode: string;
    label: string;
  } | null>(null);
  const addCode = unit === '__new__' ? customCode.trim() : unit.trim();
  const addEntry = schedule?.conversions.find(
    (candidate) => candidate.unitCode === addCode,
  );
  const metaReady = meta?.itemId === item.id;
  const shiftStart = metaReady ? (meta?.shiftStart ?? null) : null;
  const unitOptions = metaReady ? (meta?.unitOptions ?? []) : [];
  const controlsDisabled = busy || locked || !metaReady || schedule === null;
  // Fresh saves wait until the cached rows, the schedule and the item shown
  // agree on the identity. A held retry still replays unchanged.
  const snapshotMismatch =
    (baseUnit !== null && baseUnit !== item.baseUnit) ||
    (schedule !== null && schedule.identity !== identityKey);
  const savesBlocked = identityDirty || snapshotMismatch;
  const addSubject =
    addCode.length === 0 ? '' : conversionSubject(item.id, addCode);
  const addHeld =
    addSubject.length === 0 || actionEpoch < 0
      ? null
      : unknownAction<ConversionAction>(addSubject);
  const addBlocked = addHeld !== null;
  const addDisabled = controlsDisabled || addBlocked;
  const addTiming = useDatedTiming(
    item.id,
    shiftStart,
    addEntry?.versions ?? noVersions,
    addEntry?.token ?? schedule?.emptyToken ?? emptyScheduleToken,
    addDisabled,
  );

  const applySnapshot = useCallback(
    async (
      itemId: string,
      next: ConversionList,
      scheduleIdentity: string,
      requestId: number,
      cancelled: () => boolean,
    ) => {
      if (!aliveRef.current || cancelled() || requestId !== requestRef.current)
        return;
      setRows(next.rows);
      setBaseUnit(next.baseUnit);
      setLoadError(null);
      if (
        next.baseUnit !== itemBaseUnitRef.current ||
        scheduleIdentity !== itemIdentityRef.current
      ) {
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
      await applySnapshot(
        item.id,
        next,
        nextSchedule.identity,
        requestId,
        () => false,
      );
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
        await applySnapshot(
          item.id,
          next,
          nextSchedule.identity,
          requestId,
          () => cancelled,
        );
      } catch (error) {
        await failLoad(item.id, error, requestId, () => cancelled);
      }
    })();

    return () => {
      cancelled = true;
      aliveRef.current = false;
    };
  }, [applySnapshot, failLoad, identityKey, item.id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [shift, options] = await Promise.all([
          currentShiftStart(),
          listUnitOptions(),
        ]);
        if (cancelled) return;
        setMeta({ itemId: item.id, shiftStart: shift, unitOptions: options });
        setMetaError(null);
      } catch (error) {
        if (!cancelled) setMetaError(messageFrom(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.id, metaAttempt]);

  function retryLoad() {
    void load();
    setMetaAttempt((attempt) => attempt + 1);
  }

  async function run(work: () => Promise<void>): Promise<boolean> {
    if (busy || locked) return false;
    setBusy(true);
    onBusyChange?.(true);
    setActionError(null);
    try {
      await work();
      await load();
      await onConversionSaved?.(item.id);
      return true;
    } catch (error) {
      setActionError(messageFrom(error));
      if (error instanceof StaleWriteError) await load();
      throw error;
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  async function perform(action: ConversionAction): Promise<void> {
    switch (action.kind) {
      case 'remove_conversion':
        await deleteConversion(
          action.itemId,
          action.unit,
          action.expectedFactor,
          action.baseUnit,
          action.write,
        );
        return;
      case 'set_conversion':
        if (action.via === 'add') {
          await addConversion(
            action.itemId,
            action.unit,
            action.factor,
            action.baseUnit,
            action.write,
          );
          return;
        }
        await updateConversion(
          action.itemId,
          action.unit,
          action.factor,
          action.expectedFactor,
          action.baseUnit,
          action.write,
        );
        return;
      case 'create_unit_then_conversion': {
        let unitCode = action.createdCode;
        if (unitCode === null) {
          unitCode = await addCustomUnit(
            action.inputCode,
            action.label,
            action.unitRequestId,
          );
          action.createdCode = unitCode;
          setCreatedUnit({
            code: unitCode,
            inputCode: action.inputCode,
            label: action.label,
          });
          const options = await listUnitOptions();
          setMeta((current) =>
            current && current.itemId === action.itemId
              ? { ...current, unitOptions: options }
              : current,
          );
        }
        await addConversion(
          action.itemId,
          unitCode,
          action.factor,
          action.baseUnit,
          action.write,
        );
        return;
      }
      default: {
        const unreachable: never = action;
        return unreachable;
      }
    }
  }

  function clearSubmittedAdd(action: ConversionAction) {
    const clears =
      action.kind === 'create_unit_then_conversion' ||
      (action.kind === 'set_conversion' && action.via === 'add');
    if (!clears) return;
    if (action.kind === 'create_unit_then_conversion') setCreatedUnit(null);
    setUnit('');
    setCustomCode('');
    setCustomLabel('');
    setFactor('');
  }

  async function replay(action: ConversionAction): Promise<void> {
    const subject = actionSubject(action);
    if (replayFlight.current.has(subject)) return;
    replayFlight.current.add(subject);
    try {
      const accepted = await run(async () => {
        try {
          await perform(action);
          settleAction(subject, action.write.requestId);
          clearSubmittedAdd(action);
        } catch (error) {
          if (hasAction(subject)) {
            settleAction(subject, action.write.requestId, error);
          }
          throw error;
        }
      });
      if (
        accepted === false &&
        unknownAction<ConversionAction>(subject) === null
      ) {
        settleAction(subject, action.write.requestId);
      }
    } catch {
      // run already settled this action and showed the error.
    } finally {
      replayFlight.current.delete(subject);
      setActionEpoch((value) => value + 1);
    }
  }

  function send(action: ConversionAction) {
    if (addFlight.current) return;
    addFlight.current = true;
    void replay(action).finally(() => {
      addFlight.current = false;
    });
  }

  function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!baseUnit || controlsDisabled || savesBlocked || addFlight.current) {
      return;
    }
    const code = unit === '__new__' ? customCode.trim() : unit.trim();
    const subject = conversionSubject(item.id, code);
    if (hasAction(subject)) return;
    const freshUnit = unit === '__new__';
    const label = customLabel.trim();
    if (freshUnit) {
      if (code.length < 1 || code.length > 20) {
        setActionError('كود الوحدة من حرف لحد 20');
        return;
      }
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
    const built = addTiming.build();
    if (!built.ok) {
      setActionError(built.error);
      return;
    }
    const snapshotBaseUnit = baseUnit;
    const action = beginAction(subject, (requestId) => {
      const write = { ...built.write, requestId };
      if (freshUnit) {
        const createdCode =
          createdUnit &&
          createdUnit.inputCode === code &&
          createdUnit.label === label
            ? createdUnit.code
            : null;
        return {
          kind: 'create_unit_then_conversion' as const,
          itemId: item.id,
          inputCode: code,
          label,
          createdCode,
          unitRequestId: crypto.randomUUID(),
          factor: parsed.factor,
          baseUnit: snapshotBaseUnit,
          write,
        };
      }
      return {
        kind: 'set_conversion' as const,
        via: 'add' as const,
        itemId: item.id,
        unit: code,
        factor: parsed.factor,
        expectedFactor: parsed.factor,
        baseUnit: snapshotBaseUnit,
        write,
      };
    });
    send(action);
  }

  function retryAdd() {
    if (busy || locked || addFlight.current) return;
    const code = unit === '__new__' ? customCode.trim() : unit.trim();
    const action = unknownAction<ConversionAction>(
      conversionSubject(item.id, code),
    );
    if (!action) return;
    send(action);
  }

  const shownError = loadError ?? metaError;

  if ((rows === null || baseUnit === null) && shownError) {
    return (
      <div className="flex flex-col gap-2">
        <p role="alert">{shownError}</p>
        <button className={secondaryButton} type="button" onClick={retryLoad}>
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
      {shownError ? (
        <div className="flex flex-col gap-2">
          <p role="alert">{shownError}</p>
          <button className={secondaryButton} type="button" onClick={retryLoad}>
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {identityDirty ? (
        <p className="text-sm text-neutral-600">{saveDetailsFirstMessage}</p>
      ) : null}
      {snapshotMismatch ? (
        <p className="text-sm text-neutral-600">{identityOutOfDateMessage}</p>
      ) : null}
      {rows.length === 0 && !shownError ? <p>مفيش تحويلات للصنف ده</p> : null}
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
            identityDirty={savesBlocked}
            shiftStart={shiftStart}
            versions={entry?.versions ?? noVersions}
            token={entry?.token ?? schedule?.emptyToken ?? emptyScheduleToken}
            onReplay={replay}
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
            disabled={addDisabled}
            value={unit}
            onChange={(event) => {
              if (addDisabled) return;
              setUnit(event.target.value);
            }}
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
                disabled={addDisabled}
                value={customCode}
                onChange={(event) => {
                  if (addDisabled) return;
                  setCustomCode(event.target.value);
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              اسم الوحدة
              <input
                className={fieldClass}
                autoComplete="off"
                disabled={addDisabled}
                value={customLabel}
                onChange={(event) => {
                  if (addDisabled) return;
                  setCustomLabel(event.target.value);
                }}
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
            disabled={addDisabled}
            value={factor}
            onChange={(event) => {
              if (addDisabled) return;
              setFactor(event.target.value);
            }}
          />
        </label>
        {addTiming.fields}
        <p className="text-sm text-neutral-600">
          1 من الوحدة دي = كام {baseLabel}
        </p>
        {actionError ? <p role="alert">{actionError}</p> : null}
        {addHeld ? (
          <UnknownSave disabled={busy || locked} onRetry={retryAdd} />
        ) : null}
        <button
          className={primaryButton}
          type="submit"
          disabled={addDisabled || savesBlocked}
        >
          ضيف التحويل
        </button>
      </form>
    </div>
  );
}
