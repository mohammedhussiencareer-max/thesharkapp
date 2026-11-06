import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { EffectiveTimeFields } from '@/items/EffectiveTimeFields';
import {
  costingImpact,
  currentShiftStart,
  listCostingSchedule,
} from '@/items/api';
import {
  buildDatedWrite,
  defaultEffectiveMode,
  effectiveFromPayload,
  impactErrorMessage,
  impactLine,
  impactPendingMessage,
  needsBackdatedReason,
  nextVersionStart,
  type EffectiveMode,
} from '@/items/effective';
import {
  identityOutOfDateMessage,
  isConfirmedConfigurationChange,
  messageFrom,
  saveDetailsFirstMessage,
} from '@/items/errors';
import {
  beginAction,
  createSubject,
  hasAction,
  hasItemConfigurationAction,
  lossSubject,
  priceSubject,
  settleAction,
  subscribeHeldWrites,
  unknownAction,
} from '@/items/request-id';
import { UnknownSave } from '@/items/UnknownSave';
import {
  frequencyOptions,
  kindOptions,
  unitOptions,
  defaultsForKind,
} from '@/items/labels';
import {
  isBaseUnit,
  isCountFrequency,
  isStockKind,
  itemIdentity,
  type CatalogItem,
  type CostingSchedule,
  type DatedWrite,
  type ItemDraft,
  type ItemSave,
} from '@/items/types';

import { cairoDateTimeLocalToIso } from '@/purchases/time';
import {
  decimalsEqual,
  emptyItemForm,
  lossPercentToFraction,
  parseUnitCost,
  validateItemForm,
  type ItemFormErrors,
  type ItemFormValues,
} from '@/items/validation';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';
const primaryButton =
  'rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60';
const secondaryButton =
  'rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

type LossAction = { lossPct: string; write: DatedWrite };
type PriceAction = {
  price: string;
  reason: string | null;
  expectedId: string | null;
  identity: string;
  requestId: string;
};

export function ItemForm({
  items,
  editingId,
  initial,
  submitting,
  locked = false,
  serverError,
  onClearServerError,
  onSubmit,
  onCancel,
  detailsKey = 0,
  onIdentityDirtyChange,
  onItemStale,
}: {
  items: readonly CatalogItem[];
  editingId?: string;
  initial?: ItemFormValues;
  submitting: boolean;
  /** Another operation on the page is in flight; the form waits for it. */
  locked?: boolean;
  serverError: string | null;
  onClearServerError: () => void;
  onSubmit: (action: ItemSave) => Promise<boolean>;
  onCancel: () => void;
  /** Bumped after a stale details reload. Resets details only. */
  detailsKey?: number;
  /** True while kind, base unit or parent differs from the saved item. */
  onIdentityDirtyChange?: (dirty: boolean) => void;
  /** The costing schedule is for a different identity than the shown item. */
  onItemStale?: (itemId: string) => void | Promise<void>;
}) {
  const titleId = useId();
  const [values, setValues] = useState(initial ?? emptyItemForm);
  const [seenDetails, setSeenDetails] = useState(detailsKey);
  if (seenDetails !== detailsKey) {
    setSeenDetails(detailsKey);
    // A stale details reload refreshes name, kind, and the other detail
    // fields. Loss and price stay, including a value whose write outcome
    // is still unknown.
    setValues((current) => ({
      ...(initial ?? emptyItemForm()),
      lossPercent: current.lossPercent,
    }));
  }
  const [errors, setErrors] = useState<ItemFormErrors>({});
  const [extraError, setExtraError] = useState<string | null>(null);
  const [shiftStart, setShiftStart] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<CostingSchedule | null>(null);
  const [mode, setMode] = useState<EffectiveMode>('now');
  const [customLocal, setCustomLocal] = useState('');
  const [lossReason, setLossReason] = useState('');
  const [datedLoss, setDatedLoss] = useState(false);
  const [impact, setImpact] = useState<
    | { status: 'ready'; key: string; orders: number; shifts: number }
    | { status: 'error'; key: string }
    | null
  >(null);
  const [impactAttempt, setImpactAttempt] = useState(0);
  const [priceText, setPriceText] = useState(
    () => items.find((item) => item.id === editingId)?.openingPriceText ?? '',
  );
  const [priceReason, setPriceReason] = useState('');
  const [priceError, setPriceError] = useState<string | null>(null);
  const timingTouched = useRef(false);
  const scheduleLoad = useRef(0);
  const onItemStaleRef = useRef(onItemStale);
  const lossFlight = useRef(false);
  const priceFlight = useRef(false);
  const createFlight = useRef(false);
  // Actual clock for the backdating rule. A null start is still the server's
  // current minute. An explicit time, including the shift start, is backdated
  // when it is earlier than this instant.
  const [mountNow] = useState(() => Date.now());
  const [submitNow, setSubmitNow] = useState<number | null>(null);
  const [refreshingSchedule, setRefreshingSchedule] = useState(false);
  const [actionEpoch, setActionEpoch] = useState(0);
  const [heldEpoch, setHeldEpoch] = useState(0);
  const [submittedDraft, setSubmittedDraft] = useState<ItemDraft | null>(null);
  const nowMs = submitNow ?? mountNow;
  const title = editingId ? 'تعديل الصنف' : 'صنف جديد';
  const editing = items.find((item) => item.id === editingId);
  const identityLocked = editing?.identityLocked === true;
  // A configuration write is approved for the saved identity. While the
  // editor shows a different one, no fresh price, loss or conversion goes out.
  const identityDirty =
    editing !== undefined &&
    (values.kind !== editing.kind ||
      values.baseUnit !== editing.baseUnit ||
      values.parentItemId !== (editing.parentItemId ?? ''));
  const editingIdentity = editing ? itemIdentity(editing) : '';
  // The schedule and its tokens belong to the identity the database holds. A
  // fresh write waits until that is the identity the owner is looking at.
  const scheduleMismatch =
    editing !== undefined &&
    schedule !== null &&
    schedule.identity !== editingIdentity;
  const identityTick = heldEpoch;
  const identityPending =
    editingId === undefined || identityTick < 0
      ? false
      : hasItemConfigurationAction(editingId);
  const initialLoss = initial?.lossPercent ?? '';
  const lossDirty =
    editingId !== undefined && values.lossPercent.trim() !== initialLoss.trim();
  const heldNow = actionEpoch;
  const lossHeld =
    editingId === undefined || heldNow < 0
      ? null
      : unknownAction<LossAction>(lossSubject(editingId));
  const priceHeld =
    editingId === undefined || heldNow < 0
      ? null
      : unknownAction<PriceAction>(priceSubject(editingId));
  const createHeld =
    submittedDraft === null || heldNow < 0
      ? null
      : unknownAction<string>(createSubject(submittedDraft));
  const lossBlocked = lossHeld !== null;
  const priceBlocked = priceHeld !== null;
  const createBlocked = createHeld !== null;
  const detailsDisabled = submitting || locked || createBlocked;
  const lossDisabled = submitting || locked || lossBlocked || createBlocked;
  const priceDisabled = submitting || locked || priceBlocked;
  const parsedPrice = parseUnitCost(priceText);
  const zeroPrice =
    parsedPrice.ok && !('empty' in parsedPrice) && parsedPrice.text === '0';
  const parents = items
    .filter((item) => item.kind === 'fish_mixed')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));

  useEffect(
    () => subscribeHeldWrites(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  useEffect(() => {
    onIdentityDirtyChange?.(identityDirty);
    return () => onIdentityDirtyChange?.(false);
  }, [identityDirty, onIdentityDirtyChange]);

  useEffect(() => {
    onItemStaleRef.current = onItemStale;
  }, [onItemStale]);

  // A new displayed identity re-reads the schedule. A schedule for another
  // identity than the one this read was issued for means the shown item is
  // behind: reload it, which re-runs this read.
  useEffect(() => {
    if (!editingId) return;
    const request = ++scheduleLoad.current;
    let cancelled = false;
    void (async () => {
      try {
        const [shift, nextSchedule] = await Promise.all([
          currentShiftStart(),
          listCostingSchedule(editingId),
        ]);
        if (cancelled || request !== scheduleLoad.current) return;
        setShiftStart(shift);
        setSchedule(nextSchedule);
        if (!timingTouched.current) setMode(defaultEffectiveMode(shift));
        if (nextSchedule.identity !== editingIdentity) {
          void onItemStaleRef.current?.(editingId);
        }
      } catch (error) {
        if (!cancelled && request === scheduleLoad.current) {
          setExtraError(messageFrom(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editingId, editingIdentity]);

  async function reloadLossSchedule(expectedIdentity?: string): Promise<void> {
    if (!editingId) return;
    const request = ++scheduleLoad.current;
    try {
      const next = await listCostingSchedule(editingId);
      if (request !== scheduleLoad.current) return;
      setSchedule(next);
      if (
        expectedIdentity !== undefined &&
        next.identity !== expectedIdentity
      ) {
        void onItemStaleRef.current?.(editingId);
      }
    } catch (error) {
      if (request === scheduleLoad.current) setExtraError(messageFrom(error));
    }
  }

  const lossCustomIso =
    mode === 'custom' ? cairoDateTimeLocalToIso(customLocal) : null;
  const canDateLoss = editingId !== undefined && initialLoss.trim() !== '';
  const lossTimingOpen = lossDirty || (canDateLoss && datedLoss);
  const lossBackdated =
    editingId !== undefined &&
    lossTimingOpen &&
    needsBackdatedReason(mode, shiftStart, lossCustomIso, nowMs);
  const lossFrom = lossBackdated
    ? effectiveFromPayload(mode, shiftStart, lossCustomIso)
    : null;
  const lossTo = lossFrom
    ? nextVersionStart(
        schedule?.lossVersions ?? [],
        lossFrom,
        new Date(nowMs).toISOString(),
      )
    : null;
  const impactKey = lossFrom ? `${lossFrom}|${lossTo ?? ''}` : '';
  const shownImpact = impact?.key === impactKey ? impact : null;

  useEffect(() => {
    if (!editingId || !lossFrom || impactKey.length === 0) return;
    let cancelled = false;
    void costingImpact(lossFrom, lossTo, editingId)
      .then((next) => {
        if (!cancelled) {
          setImpact({
            status: 'ready',
            key: impactKey,
            orders: next.orders,
            shifts: next.shifts,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setImpact({ status: 'error', key: impactKey });
      });
    return () => {
      cancelled = true;
    };
  }, [editingId, impactAttempt, impactKey, lossFrom, lossTo]);

  function change(patch: Partial<ItemFormValues>) {
    onClearServerError();
    setExtraError(null);
    setValues((current) => ({ ...current, ...patch }));
    setErrors({});
  }

  function onKind(event: ChangeEvent<HTMLSelectElement>) {
    if (identityLocked || identityPending) return;
    const kind = event.target.value;
    if (!isStockKind(kind)) return;
    const defaults = defaultsForKind(kind);
    change({
      kind,
      baseUnit: defaults.baseUnit,
      countFrequency: defaults.countFrequency,
      parentItemId: kind === 'fish_size' ? values.parentItemId : '',
    });
  }

  async function finishLoss(action: LossAction) {
    if (!editingId || lossFlight.current) return;
    lossFlight.current = true;
    const subject = lossSubject(editingId);
    setRefreshingSchedule(true);
    try {
      const accepted = await onSubmit({
        kind: 'loss',
        lossPct: action.lossPct,
        write: action.write,
      });
      // A refused send never reached the database. A retry whose page is
      // busy still has an unknown outcome and must keep its payload.
      if (accepted !== true) {
        if (unknownAction<LossAction>(subject) === null) {
          settleAction(subject, action.write.requestId);
        }
        return;
      }
      settleAction(subject, action.write.requestId);
      setDatedLoss(false);
      await reloadLossSchedule();
    } catch (error) {
      settleAction(subject, action.write.requestId, error);
      if (isConfirmedConfigurationChange(error)) await reloadLossSchedule();
    } finally {
      lossFlight.current = false;
      setRefreshingSchedule(false);
      setActionEpoch((value) => value + 1);
    }
  }

  async function finishPrice(action: PriceAction) {
    if (!editingId || priceFlight.current) return;
    priceFlight.current = true;
    const subject = priceSubject(editingId);
    try {
      const accepted = await onSubmit({
        kind: 'price',
        price: action.price,
        reason: action.reason,
        expectedId: action.expectedId,
        identity: action.identity,
        requestId: action.requestId,
      });
      if (accepted !== true) {
        if (unknownAction<PriceAction>(subject) === null) {
          settleAction(subject, action.requestId);
        }
        return;
      }
      settleAction(subject, action.requestId);
    } catch (error) {
      settleAction(subject, action.requestId, error);
      // The held price keeps the identity it was submitted with. A confirmed
      // conflict retires that hold; the next fresh action reads this reload.
      if (isConfirmedConfigurationChange(error)) await reloadLossSchedule();
    } finally {
      priceFlight.current = false;
      setActionEpoch((value) => value + 1);
    }
  }

  function saveCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (detailsDisabled || createFlight.current) return;
    if (submittedDraft && hasAction(createSubject(submittedDraft))) return;
    const result = validateItemForm(values, { items, editingId });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    createFlight.current = true;
    setSubmittedDraft(result.draft);
    void onSubmit({ kind: 'create', draft: result.draft })
      .catch(() => undefined)
      .finally(() => {
        createFlight.current = false;
        setActionEpoch((value) => value + 1);
      });
  }

  function retryCreate() {
    if (!submittedDraft || submitting || locked || createFlight.current) return;
    if (unknownAction<string>(createSubject(submittedDraft)) === null) return;
    createFlight.current = true;
    void onSubmit({ kind: 'create', draft: submittedDraft })
      .catch(() => undefined)
      .finally(() => {
        createFlight.current = false;
        setActionEpoch((value) => value + 1);
      });
  }

  function saveDetails() {
    if (detailsDisabled) return;
    const result = validateItemForm(values, {
      items,
      editingId,
      includeLoss: false,
    });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    const identityChanged =
      editing !== undefined &&
      (result.draft.baseUnit !== editing.baseUnit ||
        result.draft.kind !== editing.kind ||
        result.draft.parentItemId !== editing.parentItemId);
    void onSubmit({ kind: 'details', draft: result.draft })
      .then((accepted) => {
        if (accepted === true && identityChanged) {
          return reloadLossSchedule(itemIdentity(result.draft));
        }
        return undefined;
      })
      .catch(() => undefined);
  }

  function retryLoss() {
    if (
      !editingId ||
      submitting ||
      locked ||
      refreshingSchedule ||
      lossFlight.current
    ) {
      return;
    }
    const action = unknownAction<LossAction>(lossSubject(editingId));
    if (!action) return;
    void finishLoss(action);
  }

  function saveLoss() {
    if (
      !editingId ||
      submitting ||
      locked ||
      identityDirty ||
      scheduleMismatch ||
      refreshingSchedule ||
      lossFlight.current ||
      hasAction(lossSubject(editingId))
    ) {
      return;
    }
    if (initialLoss.trim() !== '' && values.lossPercent.trim() === '') {
      setErrors({
        lossPercent: 'اكتب نسبة الفاقد. صفر فاقد معتمد يتكتب 0.',
      });
      return;
    }
    const checked = validateItemForm(
      { ...values, name: values.name.trim() || 'صنف' },
      { items, editingId },
    );
    const lossError = checked.ok ? null : checked.errors.lossPercent;
    if (lossError) {
      setErrors({ lossPercent: lossError });
      return;
    }
    if (!lossTimingOpen) return;
    if (!schedule) {
      setExtraError('لسه بنحمّل بيانات الفاقد');
      return;
    }
    const lossPct = checked.ok
      ? checked.draft.lossPct
      : lossPercentToFraction(values.lossPercent);
    if (!lossPct) return;
    const now = Date.now();
    setSubmitNow(now);
    const nowIso = new Date(now).toISOString();
    const backdatedNow = needsBackdatedReason(
      mode,
      shiftStart,
      lossCustomIso,
      now,
    );
    if (!lossDirty && !backdatedNow) {
      setExtraError('اختار وقت سريان قبل الوقت الحالي');
      return;
    }
    if (backdatedNow && lossReason.trim().length === 0) {
      setExtraError('اكتب سبب التغيير بأثر رجعي');
      return;
    }
    const built = buildDatedWrite({
      mode,
      shiftStart,
      customIso: lossCustomIso,
      versions: schedule.lossVersions,
      nowIso,
      token: schedule.lossToken,
      reason: lossReason,
      requestId: '00000000-0000-4000-8000-000000000000',
    });
    if (!built.ok) {
      setExtraError(built.error);
      return;
    }
    if (backdatedNow) {
      const key = `${built.write.effectiveFrom ?? ''}|${built.write.effectiveTo ?? ''}`;
      if (shownImpact?.status !== 'ready' || shownImpact.key !== key) {
        setExtraError(
          shownImpact?.status === 'error' && shownImpact.key === key
            ? impactErrorMessage
            : impactPendingMessage,
        );
        return;
      }
    }
    const action = beginAction(lossSubject(editingId), (requestId) => ({
      lossPct,
      write: { ...built.write, requestId },
    }));
    void finishLoss(action);
  }

  function retryPrice() {
    if (!editingId || submitting || locked || priceFlight.current) return;
    const action = unknownAction<PriceAction>(priceSubject(editingId));
    if (!action) return;
    void finishPrice(action);
  }

  function savePrice() {
    if (
      !editingId ||
      submitting ||
      locked ||
      identityDirty ||
      scheduleMismatch ||
      priceFlight.current ||
      hasAction(priceSubject(editingId))
    ) {
      return;
    }
    setPriceError(null);
    const parsed = parseUnitCost(priceText);
    if (!parsed.ok) {
      setPriceError(parsed.error);
      return;
    }
    const hadPrice = Boolean(editing?.openingPriceText);
    if ('empty' in parsed) {
      if (hadPrice) setPriceError('اكتب السعر الافتتاحي المعتمد للوحدة');
      return;
    }
    if (decimalsEqual(priceText, editing?.openingPriceText ?? '')) return;
    const price = parsed.text;
    if (price === '0' && priceReason.trim() === '') {
      setPriceError('اكتب سبب إن السعر صفر');
      return;
    }
    const identity = schedule?.identity;
    if (!identity) {
      setPriceError('لسه بنحمّل بيانات السعر');
      return;
    }
    const reason = price === '0' ? priceReason.trim() : null;
    const action = beginAction(priceSubject(editingId), (requestId) => ({
      price,
      reason,
      expectedId: editing?.openingPriceId ?? null,
      identity,
      requestId,
    }));
    void finishPrice(action);
  }

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded border border-neutral-300 p-3"
    >
      <form
        aria-label={title}
        className="flex flex-col gap-3"
        noValidate
        onSubmit={editingId ? (event) => event.preventDefault() : saveCreate}
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        {serverError ? <p role="alert">{serverError}</p> : null}
        {extraError ? <p role="alert">{extraError}</p> : null}
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            الاسم
            <input
              className={fieldClass}
              name="item-name"
              autoComplete="off"
              disabled={detailsDisabled}
              value={values.name}
              onChange={(event) => {
                if (detailsDisabled) return;
                change({ name: event.target.value });
              }}
            />
          </label>
          {errors.name ? <p role="alert">{errors.name}</p> : null}
        </div>
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            النوع
            <select
              className={fieldClass}
              disabled={detailsDisabled || identityLocked || identityPending}
              value={values.kind}
              onChange={(event) => {
                if (detailsDisabled || identityLocked || identityPending)
                  return;
                onKind(event);
              }}
            >
              {kindOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {errors.kind ? <p role="alert">{errors.kind}</p> : null}
        </div>
        {values.kind === 'fish_size' ? (
          <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1">
              السمك المخلوط
              <select
                className={fieldClass}
                disabled={detailsDisabled || identityLocked || identityPending}
                value={values.parentItemId}
                onChange={(event) => {
                  if (detailsDisabled || identityLocked || identityPending) {
                    return;
                  }
                  change({ parentItemId: event.target.value });
                }}
              >
                <option value="">اختار</option>
                {parents.map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {parent.name}
                    {parent.active ? '' : ' (موقوف)'}
                  </option>
                ))}
              </select>
            </label>
            {errors.parentItemId ? (
              <p role="alert">{errors.parentItemId}</p>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            الوحدة الأساسية
            <select
              className={fieldClass}
              disabled={detailsDisabled || identityLocked || identityPending}
              value={values.baseUnit}
              onChange={(event) => {
                if (detailsDisabled || identityLocked || identityPending)
                  return;
                const baseUnit = event.target.value;
                if (!isBaseUnit(baseUnit)) return;
                change({ baseUnit });
              }}
            >
              {unitOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {errors.baseUnit ? <p role="alert">{errors.baseUnit}</p> : null}
          {identityPending ? (
            <p className="text-sm text-neutral-600">
              في حفظ للتكلفة لسه معلّق، فالنوع والوحدة الأساسية والأب متقفلين
            </p>
          ) : identityLocked ? (
            <p className="text-sm text-neutral-600">
              الصنف ده اتحدد أو عليه حركات، فالنوع والوحدة الأساسية والأب
              متقفلين
            </p>
          ) : null}
          {identityDirty ? (
            <p className="text-sm text-neutral-600">
              {saveDetailsFirstMessage}
            </p>
          ) : null}
          {scheduleMismatch ? (
            <p className="text-sm text-neutral-600">
              {identityOutOfDateMessage}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            الجرد
            <select
              className={fieldClass}
              disabled={detailsDisabled}
              value={values.countFrequency}
              onChange={(event) => {
                if (detailsDisabled) return;
                const countFrequency = event.target.value;
                if (!isCountFrequency(countFrequency)) return;
                change({ countFrequency });
              }}
            >
              {frequencyOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {errors.countFrequency ? (
            <p role="alert">{errors.countFrequency}</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            نسبة الفاقد
            <input
              className={fieldClass}
              dir="ltr"
              inputMode="decimal"
              disabled={lossDisabled}
              value={values.lossPercent}
              onChange={(event) => {
                if (lossDisabled) return;
                change({ lossPercent: event.target.value });
              }}
            />
          </label>
          <p className="text-sm text-neutral-600">
            {editing && values.lossPercent.trim() === ''
              ? 'مش متحدد. اكتب 0 لو الفاقد المعتمد صفر.'
              : 'اكتبها نسبة مئوية من 0 لحد 99.999. سيبها فاضية لو لسه مش متحدد.'}
          </p>
          {errors.lossPercent ? <p role="alert">{errors.lossPercent}</p> : null}
          {canDateLoss && !lossDirty ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={lossDisabled}
                checked={datedLoss}
                onChange={(event) => {
                  if (lossDisabled) return;
                  setExtraError(null);
                  setDatedLoss(event.target.checked);
                }}
              />
              اعتمد النسبة الحالية من وقت سابق
            </label>
          ) : null}
          {editingId && lossTimingOpen ? (
            <EffectiveTimeFields
              mode={mode}
              shiftStart={shiftStart}
              customLocal={customLocal}
              reason={lossReason}
              backdated={lossBackdated}
              impact={
                shownImpact?.status === 'ready'
                  ? impactLine(shownImpact.orders, shownImpact.shifts)
                  : null
              }
              impactStatus={
                !lossBackdated
                  ? 'idle'
                  : shownImpact === null
                    ? 'loading'
                    : shownImpact.status
              }
              disabled={lossDisabled}
              onRetryImpact={() => setImpactAttempt((value) => value + 1)}
              onMode={(next) => {
                if (lossDisabled) return;
                timingTouched.current = true;
                setExtraError(null);
                setMode(next);
              }}
              onCustomLocal={(value) => {
                if (lossDisabled) return;
                timingTouched.current = true;
                setExtraError(null);
                setCustomLocal(value);
              }}
              onReason={(value) => {
                if (lossDisabled) return;
                timingTouched.current = true;
                setExtraError(null);
                setLossReason(value);
              }}
            />
          ) : null}
          {lossHeld ? (
            <UnknownSave
              disabled={submitting || locked || refreshingSchedule}
              onRetry={retryLoss}
            />
          ) : null}
        </div>
        {editingId ? (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              السعر الافتتاحي المعتمد للوحدة
              <input
                className={fieldClass}
                dir="ltr"
                inputMode="decimal"
                disabled={priceDisabled}
                value={priceText}
                onChange={(event) => {
                  if (priceDisabled) return;
                  onClearServerError();
                  setPriceError(null);
                  setPriceText(event.target.value);
                }}
              />
            </label>
            {zeroPrice ? (
              <label className="flex flex-col gap-1">
                سبب إن السعر صفر
                <input
                  className={fieldClass}
                  autoComplete="off"
                  disabled={priceDisabled}
                  value={priceReason}
                  onChange={(event) => {
                    if (priceDisabled) return;
                    setPriceError(null);
                    setPriceReason(event.target.value);
                  }}
                />
              </label>
            ) : null}
            {priceError ? <p role="alert">{priceError}</p> : null}
            {priceHeld ? (
              <UnknownSave
                disabled={submitting || locked}
                onRetry={retryPrice}
              />
            ) : null}
          </div>
        ) : null}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            disabled={detailsDisabled}
            checked={values.active}
            onChange={(event) => {
              if (detailsDisabled) return;
              change({ active: event.target.checked });
            }}
          />
          شغال
        </label>
        {createHeld ? (
          <UnknownSave disabled={submitting || locked} onRetry={retryCreate} />
        ) : null}
        <div className="flex flex-wrap gap-2">
          {editingId ? (
            <>
              <button
                className={primaryButton}
                type="button"
                disabled={detailsDisabled}
                onClick={saveDetails}
              >
                حفظ البيانات
              </button>
              <button
                className={primaryButton}
                type="button"
                disabled={
                  lossDisabled ||
                  refreshingSchedule ||
                  identityDirty ||
                  scheduleMismatch
                }
                onClick={saveLoss}
              >
                حفظ الفاقد
              </button>
              <button
                className={primaryButton}
                type="button"
                disabled={priceDisabled || identityDirty || scheduleMismatch}
                onClick={savePrice}
              >
                حفظ السعر
              </button>
            </>
          ) : (
            <button
              className={primaryButton}
              type="submit"
              disabled={detailsDisabled}
            >
              حفظ
            </button>
          )}
          <button
            className={secondaryButton}
            type="button"
            disabled={submitting || locked}
            onClick={onCancel}
          >
            إلغاء
          </button>
        </div>
      </form>
    </section>
  );
}
