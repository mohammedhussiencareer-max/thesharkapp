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
  impactLine,
  needsBackdatedReason,
  nextVersionStart,
  type EffectiveMode,
} from '@/items/effective';
import { messageFrom } from '@/items/errors';
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
  type CostingImpact,
  type CostingSchedule,
  type ItemDraft,
} from '@/items/types';
import { cairoDateTimeLocalToIso } from '@/purchases/time';
import {
  decimalsEqual,
  emptyItemForm,
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
}: {
  items: readonly CatalogItem[];
  editingId?: string;
  initial?: ItemFormValues;
  submitting: boolean;
  /** Another operation on the page is in flight; the form waits for it. */
  locked?: boolean;
  serverError: string | null;
  onClearServerError: () => void;
  onSubmit: (draft: ItemDraft) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [values, setValues] = useState(initial ?? emptyItemForm);
  const [errors, setErrors] = useState<ItemFormErrors>({});
  const [extraError, setExtraError] = useState<string | null>(null);
  const [shiftStart, setShiftStart] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<CostingSchedule | null>(null);
  const [mode, setMode] = useState<EffectiveMode>('now');
  const [customLocal, setCustomLocal] = useState('');
  const [lossReason, setLossReason] = useState('');
  const [impact, setImpact] = useState<{
    key: string;
    value: CostingImpact;
  } | null>(null);
  const [priceText, setPriceText] = useState(
    () => items.find((item) => item.id === editingId)?.openingPriceText ?? '',
  );
  const [priceReason, setPriceReason] = useState('');
  const [priceError, setPriceError] = useState<string | null>(null);
  const requestIds = useRef(new Map<string, string>());
  const timingTouched = useRef(false);
  const [nowMs] = useState(() => Date.now());
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

  function requestId(key: string): string {
    const existing = requestIds.current.get(key);
    if (existing) return existing;
    const next = crypto.randomUUID();
    requestIds.current.set(key, next);
    return next;
  }

  useEffect(() => {
    if (!editingId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [shift, nextSchedule] = await Promise.all([
          currentShiftStart(),
          listCostingSchedule(editingId),
        ]);
        if (cancelled) return;
        setShiftStart(shift);
        setSchedule(nextSchedule);
        if (!timingTouched.current) setMode(defaultEffectiveMode(shift));
      } catch (error) {
        if (!cancelled) setExtraError(messageFrom(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editingId]);

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
  const shownImpact = impact?.key === impactKey ? impact.value : null;

  useEffect(() => {
    if (!editingId || !lossFrom || impactKey.length === 0) return;
    let cancelled = false;
    void costingImpact(lossFrom, lossTo, editingId)
      .then((next) => {
        if (!cancelled) setImpact({ key: impactKey, value: next });
      })
      .catch(() => {
        if (!cancelled) {
          setImpact({
            key: impactKey,
            value: { orders: 0, shifts: 0, movements: null },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [editingId, impactKey, lossFrom, lossTo]);

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

  function onSubmitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateItemForm(values, { items, editingId });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    let draft: ItemDraft = result.draft;
    setPriceError(null);
    if (editingId) {
      if (initialLoss.trim() !== '' && values.lossPercent.trim() === '') {
        setErrors({
          lossPercent: 'اكتب نسبة الفاقد. صفر فاقد معتمد يتكتب 0.',
        });
        return;
      }
      if (lossDirty && draft.lossPct !== null) {
        if (!schedule) {
          setExtraError('لسه بنحمّل بيانات الفاقد');
          return;
        }
        const built = buildDatedWrite({
          mode,
          shiftStart,
          customIso: lossCustomIso,
          versions: schedule.lossVersions,
          nowIso: new Date(nowMs).toISOString(),
          token: schedule.lossToken,
          reason: lossReason,
          requestId: requestId(
            `loss:${draft.lossPct}:${mode}:${lossCustomIso ?? ''}:${lossReason.trim()}`,
          ),
        });
        if (!built.ok) {
          setExtraError(built.error);
          return;
        }
        draft = { ...draft, lossWrite: built.write };
      }
      const parsedPrice = parseUnitCost(priceText);
      if (!parsedPrice.ok) {
        setPriceError(parsedPrice.error);
        return;
      }
      const hadPrice = Boolean(editing?.openingPriceText);
      if ('empty' in parsedPrice) {
        if (hadPrice) {
          setPriceError('اكتب السعر الافتتاحي المعتمد للوحدة');
          return;
        }
      } else if (!decimalsEqual(priceText, editing?.openingPriceText ?? '')) {
        const price = parsedPrice.text;
        if (price === '0' && priceReason.trim() === '') {
          setPriceError('اكتب سبب إن السعر صفر');
          return;
        }
        draft = {
          ...draft,
          openingWrite: {
            price,
            reason: price === '0' ? priceReason.trim() : null,
            expectedId: editing?.openingPriceId ?? null,
            requestId: requestId(`price:${price}:${priceReason.trim()}`),
          },
        };
      }
    }
    onSubmit(draft);
  }

  return (
    <form
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded border border-neutral-300 p-3"
      noValidate
      onSubmit={onSubmitForm}
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
              onChange={(event) => change({ parentItemId: event.target.value })}
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
            الصنف ده اتحدد أو عليه حركات، فالنوع والوحدة الأساسية والأب متقفلين
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
              shownImpact
                ? impactLine(shownImpact.orders, shownImpact.shifts)
                : null
            }
            disabled={submitting || locked}
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
        <button
          className={primaryButton}
          type="submit"
          disabled={submitting || locked}
        >
          {submitting ? 'جاري الحفظ…' : 'حفظ'}
        </button>
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
  );
}
