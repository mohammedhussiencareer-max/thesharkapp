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
import { heldWrite, holdWrite, settleRequest } from '@/items/request-id';
import { CostingChangedError, messageFrom } from '@/items/errors';
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
  type CatalogItem,
  type CostingSchedule,
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
}: {
  items: readonly CatalogItem[];
  editingId?: string;
  initial?: ItemFormValues;
  submitting: boolean;
  /** Another operation on the page is in flight; the form waits for it. */
  locked?: boolean;
  serverError: string | null;
  onClearServerError: () => void;
  onSubmit: (action: ItemSave) => Promise<void>;
  onCancel: () => void;
  /** Bumped after a stale details reload. Resets details only. */
  detailsKey?: number;
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
  // Actual clock for the backdating rule. A null start is still the server's
  // current minute. An explicit time, including the shift start, is backdated
  // when it is earlier than this instant.
  const [mountNow] = useState(() => Date.now());
  const [submitNow, setSubmitNow] = useState<number | null>(null);
  const [refreshingSchedule, setRefreshingSchedule] = useState(false);
  const nowMs = submitNow ?? mountNow;
  const title = editingId ? 'تعديل الصنف' : 'صنف جديد';
  const editing = items.find((item) => item.id === editingId);
  const identityLocked = editing?.identityLocked === true;
  const initialLoss = initial?.lossPercent ?? '';
  const lossDirty =
    editingId !== undefined && values.lossPercent.trim() !== initialLoss.trim();
  const parsedPrice = parseUnitCost(priceText);
  const zeroPrice =
    parsedPrice.ok && !('empty' in parsedPrice) && parsedPrice.text === '0';
  const parents = items
    .filter((item) => item.kind === 'fish_mixed')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));

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
      } catch (error) {
        if (!cancelled && request === scheduleLoad.current) {
          setExtraError(messageFrom(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editingId]);

  async function reloadLossSchedule(): Promise<void> {
    if (!editingId) return;
    const request = ++scheduleLoad.current;
    try {
      const next = await listCostingSchedule(editingId);
      if (request !== scheduleLoad.current) return;
      setSchedule(next);
    } catch (error) {
      if (request === scheduleLoad.current) setExtraError(messageFrom(error));
    }
  }

  const lossCustomIso =
    mode === 'custom' ? cairoDateTimeLocalToIso(customLocal) : null;
  const lossBackdated =
    editingId !== undefined &&
    lossDirty &&
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

  async function finish(intent: string, work: () => Promise<void>) {
    try {
      await work();
      settleRequest(intent);
    } catch (error) {
      settleRequest(intent, error);
    }
  }

  async function finishLoss(intent: string, work: () => Promise<void>) {
    setRefreshingSchedule(true);
    try {
      await work();
      settleRequest(intent);
      await reloadLossSchedule();
    } catch (error) {
      settleRequest(intent, error);
      if (error instanceof CostingChangedError) await reloadLossSchedule();
    } finally {
      setRefreshingSchedule(false);
    }
  }

  function saveCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateItemForm(values, { items, editingId });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    void onSubmit({ kind: 'create', draft: result.draft }).catch(
      () => undefined,
    );
  }

  function saveDetails() {
    const result = validateItemForm(values, {
      items,
      editingId,
      includeLoss: false,
    });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    void onSubmit({ kind: 'details', draft: result.draft }).catch(
      () => undefined,
    );
  }

  function lossIntent(lossPct: string): string {
    return JSON.stringify({
      item: editingId,
      lossPct,
      mode,
      customLocal,
      reason: lossReason.trim(),
    });
  }

  function saveLoss() {
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
    if (!lossDirty || refreshingSchedule) return;
    if (!schedule) {
      setExtraError('لسه بنحمّل بيانات الفاقد');
      return;
    }
    const lossPct = checked.ok
      ? checked.draft.lossPct
      : lossPercentToFraction(values.lossPercent);
    if (!lossPct) return;
    const intent = lossIntent(lossPct);
    const stored = heldWrite(intent);
    if (stored) {
      void finishLoss(intent, () =>
        onSubmit({ kind: 'loss', lossPct, write: stored }),
      );
      return;
    }
    const now = Date.now();
    setSubmitNow(now);
    const nowIso = new Date(now).toISOString();
    const backdatedNow = needsBackdatedReason(
      mode,
      shiftStart,
      lossCustomIso,
      now,
    );
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
    const write = holdWrite(intent, (requestId) => ({
      ...built.write,
      requestId,
    }));
    void finishLoss(intent, () => onSubmit({ kind: 'loss', lossPct, write }));
  }

  function savePrice() {
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
    const reason = price === '0' ? priceReason.trim() : null;
    const intent = JSON.stringify({
      item: editingId,
      price,
      reason,
      expectedId: editing?.openingPriceId ?? null,
    });
    const requestId = holdWrite(intent, (id) => ({
      effectiveFrom: null,
      effectiveTo: null,
      token: '',
      reason,
      requestId: id,
    })).requestId;
    void finish(intent, () =>
      onSubmit({
        kind: 'price',
        price,
        reason,
        expectedId: editing?.openingPriceId ?? null,
        requestId,
      }),
    );
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
              disabled={submitting || locked}
              value={values.name}
              onChange={(event) => change({ name: event.target.value })}
            />
          </label>
          {errors.name ? <p role="alert">{errors.name}</p> : null}
        </div>
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            النوع
            <select
              className={fieldClass}
              disabled={submitting || locked || identityLocked}
              value={values.kind}
              onChange={onKind}
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
                disabled={submitting || locked || identityLocked}
                value={values.parentItemId}
                onChange={(event) =>
                  change({ parentItemId: event.target.value })
                }
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
              disabled={submitting || locked || identityLocked}
              value={values.baseUnit}
              onChange={(event) => {
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
          {identityLocked ? (
            <p className="text-sm text-neutral-600">
              الصنف ده اتحدد أو عليه حركات، فالنوع والوحدة الأساسية والأب
              متقفلين
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            الجرد
            <select
              className={fieldClass}
              disabled={submitting || locked}
              value={values.countFrequency}
              onChange={(event) => {
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
              disabled={submitting || locked}
              value={values.lossPercent}
              onChange={(event) => change({ lossPercent: event.target.value })}
            />
          </label>
          <p className="text-sm text-neutral-600">
            {editing && values.lossPercent.trim() === ''
              ? 'مش متحدد. اكتب 0 لو الفاقد المعتمد صفر.'
              : 'اكتبها نسبة مئوية من 0 لحد 99.999. سيبها فاضية لو لسه مش متحدد.'}
          </p>
          {errors.lossPercent ? <p role="alert">{errors.lossPercent}</p> : null}
          {editingId && lossDirty ? (
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
              disabled={submitting || locked}
              onRetryImpact={() => setImpactAttempt((value) => value + 1)}
              onMode={(next) => {
                timingTouched.current = true;
                setExtraError(null);
                setMode(next);
              }}
              onCustomLocal={(value) => {
                timingTouched.current = true;
                setExtraError(null);
                setCustomLocal(value);
              }}
              onReason={(value) => {
                timingTouched.current = true;
                setExtraError(null);
                setLossReason(value);
              }}
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
                disabled={submitting || locked}
                value={priceText}
                onChange={(event) => {
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
                  disabled={submitting || locked}
                  value={priceReason}
                  onChange={(event) => {
                    setPriceError(null);
                    setPriceReason(event.target.value);
                  }}
                />
              </label>
            ) : null}
            {priceError ? <p role="alert">{priceError}</p> : null}
          </div>
        ) : null}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            disabled={submitting || locked}
            checked={values.active}
            onChange={(event) => change({ active: event.target.checked })}
          />
          شغال
        </label>
        <div className="flex flex-wrap gap-2">
          {editingId ? (
            <>
              <button
                className={primaryButton}
                type="button"
                disabled={submitting || locked}
                onClick={saveDetails}
              >
                حفظ البيانات
              </button>
              <button
                className={primaryButton}
                type="button"
                disabled={submitting || locked || refreshingSchedule}
                onClick={saveLoss}
              >
                حفظ الفاقد
              </button>
              <button
                className={primaryButton}
                type="button"
                disabled={submitting || locked}
                onClick={savePrice}
              >
                حفظ السعر
              </button>
            </>
          ) : (
            <button
              className={primaryButton}
              type="submit"
              disabled={submitting || locked}
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
