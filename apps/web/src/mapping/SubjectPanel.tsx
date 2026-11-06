import { useEffect, useRef, useState, type FormEvent } from 'react';
import { currentMinuteMs, type SchedulePoint } from '@/items/effective';
import { messageFrom } from '@/items/errors';
import {
  beginAction,
  hasAction,
  settleAction,
  subscribeHeldWrites,
  unknownAction,
} from '@/items/request-id';
import { UnknownSave } from '@/items/UnknownSave';
import { useDatedTiming } from '@/items/useDatedTiming';
import { formatCairo } from '@/lib/cairo';
import { primaryButton } from '@/lib/page-style';
import {
  setBaseMapping,
  setException,
  setOptionMapping,
  setOptionPolicy,
} from '@/mapping/api';
import {
  coverAt,
  familyPoints,
  quantityError,
  sizeLabel,
  subjectTitle,
} from '@/mapping/format';
import {
  familyLabel,
  issueLabel,
  policyLabel,
  savedExceptionMessage,
  savedMappingMessage,
  savedOptionMessage,
  savedPolicyMessage,
  sourceChangedMessage,
  statusLabel,
  targetKindLabel,
  targetModeLabels,
} from '@/mapping/labels';
import { baseSubject, optionSubject } from '@/mapping/subjects';
import type {
  BaseMappingWrite,
  DatedWrite,
  ExceptionWrite,
  HistoryRow,
  MappingCatalog,
  MappingTarget,
  ObservedBase,
  OptionMappingWrite,
  OptionPolicy,
  PolicyWrite,
  ScheduleVersion,
  SubjectDetail,
  TargetMode,
} from '@/mapping/types';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';

type BaseHeld =
  | { kind: 'mapping'; write: BaseMappingWrite }
  | { kind: 'policy'; write: PolicyWrite }
  | { kind: 'exception'; write: ExceptionWrite };

const baseModes: TargetMode[] = ['recipe', 'stock', 'gap'];
const optionModes: TargetMode[] = [
  'recipe',
  'stock',
  'unmapped',
  'no_stock',
  'gap',
];

function useFamilyTiming(
  versions: readonly ScheduleVersion[],
  family: ScheduleVersion['family'],
  token: string,
  shiftStart: string | null,
  disabled: boolean,
) {
  const points: SchedulePoint[] = familyPoints(versions, family);
  const timing = useDatedTiming(undefined, shiftStart, points, token, disabled);
  const [mountNow] = useState(() => currentMinuteMs(Date.now()));
  const atMs = timing.instantMs ?? mountNow;
  const covering = coverAt(
    versions.filter((version) => version.family === family),
    atMs,
  );
  return { timing, covering, atMs };
}

function unitLabel(catalog: MappingCatalog, code: string | null): string {
  if (!code) return '';
  return catalog.units.find((unit) => unit.code === code)?.label ?? code;
}

function itemName(catalog: MappingCatalog, id: string | null): string {
  if (!id) return 'صنف';
  return catalog.items.find((item) => item.id === id)?.name ?? 'صنف';
}

function recipeName(catalog: MappingCatalog, id: string | null): string {
  if (!id) return 'وصفة';
  return catalog.recipes.find((recipe) => recipe.id === id)?.name ?? 'وصفة';
}

function describeVersion(row: HistoryRow, catalog: MappingCatalog): string {
  if (row.family === 'option_policy') {
    return row.optionPolicy ? policyLabel(row.optionPolicy) : 'فضي';
  }
  if (row.family === 'exception') return row.exceptionReason ?? 'فضي';
  if (row.targetKind === 'recipe') return recipeName(catalog, row.recipeId);
  if (row.targetKind === 'stock') {
    return `${itemName(catalog, row.stockItemId)} — ${row.quantityPerBasis ?? ''} ${unitLabel(catalog, row.unitCode)}`;
  }
  if (row.targetKind) return targetKindLabel(row.targetKind);
  return 'فضي';
}

function HistoryList({
  rows,
  catalog,
}: {
  rows: readonly HistoryRow[];
  catalog: MappingCatalog;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label="سجل الربط">
      <h3 className="font-semibold">السجل</h3>
      {rows.length === 0 ? <p>لسه مفيش سجل</p> : null}
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              {familyLabel(row.family)} {formatCairo(row.effectiveFrom)}
              {row.effectiveTo
                ? ` ← ${formatCairo(row.effectiveTo)}`
                : ' ← مفتوح'}
              {' — '}
              {describeVersion(row, catalog)}
              {row.superseded ? ' — اتبدلت' : ' — سارية'}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function TargetFields({
  modes,
  mode,
  recipeId,
  stockItemId,
  quantity,
  unit,
  catalog,
  disabled,
  onMode,
  onRecipe,
  onItem,
  onQuantity,
  onUnit,
}: {
  modes: readonly TargetMode[];
  mode: TargetMode;
  recipeId: string;
  stockItemId: string;
  quantity: string;
  unit: string;
  catalog: MappingCatalog;
  disabled: boolean;
  onMode: (mode: TargetMode) => void;
  onRecipe: (id: string) => void;
  onItem: (id: string) => void;
  onQuantity: (value: string) => void;
  onUnit: (code: string) => void;
}) {
  return (
    <>
      <label className="flex flex-col gap-1">
        نوع الربط
        <select
          className={fieldClass}
          disabled={disabled}
          value={mode}
          onChange={(event) => {
            const next = event.target.value;
            if (modes.some((entry) => entry === next))
              onMode(next as TargetMode);
          }}
        >
          {modes.map((entry) => (
            <option key={entry} value={entry}>
              {targetModeLabels[entry]}
            </option>
          ))}
        </select>
      </label>
      {mode === 'recipe' ? (
        <label className="flex flex-col gap-1">
          الوصفة
          <select
            className={fieldClass}
            disabled={disabled}
            value={recipeId}
            onChange={(event) => onRecipe(event.target.value)}
          >
            <option value="">اختار الوصفة</option>
            {catalog.recipes.map((recipe) => (
              <option key={recipe.id} value={recipe.id}>
                {recipe.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {mode === 'stock' ? (
        <>
          <label className="flex flex-col gap-1">
            الصنف
            <select
              className={fieldClass}
              disabled={disabled}
              value={stockItemId}
              onChange={(event) => onItem(event.target.value)}
            >
              <option value="">اختار الصنف</option>
              {catalog.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            الكمية
            <input
              className={fieldClass}
              dir="ltr"
              inputMode="decimal"
              disabled={disabled}
              value={quantity}
              onChange={(event) => onQuantity(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            الوحدة
            <select
              className={fieldClass}
              disabled={disabled}
              value={unit}
              onChange={(event) => onUnit(event.target.value)}
            >
              <option value="">اختار الوحدة</option>
              {catalog.units.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}
    </>
  );
}

function fieldsFromVersion(
  version: ScheduleVersion | null | undefined,
  allowed: readonly TargetMode[],
  emptyMode: TargetMode,
): {
  mode: TargetMode;
  recipeId: string;
  stockItemId: string;
  quantity: string;
  unit: string;
} {
  return {
    mode: allowed.find((entry) => entry === version?.targetKind) ?? emptyMode,
    recipeId: version?.recipeId ?? '',
    stockItemId: version?.stockItemId ?? '',
    quantity: version?.quantityPerBasis ?? '1',
    unit: version?.unitCode ?? '',
  };
}

function targetFromDraft(
  mode: TargetMode,
  recipeId: string,
  stockItemId: string,
  quantity: string,
  unit: string,
): { ok: true; target: MappingTarget | null } | { ok: false; error: string } {
  if (mode === 'gap') return { ok: true, target: null };
  if (mode === 'unmapped' || mode === 'no_stock') {
    return { ok: true, target: { kind: mode } };
  }
  if (mode === 'recipe') {
    if (!recipeId) return { ok: false, error: 'اختار الوصفة' };
    return { ok: true, target: { kind: 'recipe', recipeId } };
  }
  if (!stockItemId) return { ok: false, error: 'اختار الصنف' };
  const quantityMessage = quantityError(quantity);
  if (quantityMessage) return { ok: false, error: quantityMessage };
  if (!unit) return { ok: false, error: 'اختار الوحدة' };
  return {
    ok: true,
    target: {
      kind: 'stock',
      stockItemId,
      quantity: quantity.trim(),
      unit,
    },
  };
}

function datedFrom(
  timing: ReturnType<typeof useDatedTiming>,
  token: string,
):
  | { ok: true; write: DatedWrite; instantMs: number | null }
  | { ok: false; error: string } {
  const built = timing.build();
  if (!built.ok) return built;
  return {
    ok: true,
    instantMs: built.instantMs,
    write: {
      requestId: '',
      effectiveFrom: built.write.effectiveFrom,
      effectiveTo: built.write.effectiveTo,
      token,
      reason: built.write.reason,
    },
  };
}

export function SubjectPanel({
  base,
  detail,
  catalog,
  onReload,
}: {
  base: ObservedBase;
  detail: SubjectDetail;
  catalog: MappingCatalog;
  onReload: () => Promise<void>;
}) {
  const subject = baseSubject(base.posItemId, base.sizeKeyText);
  const [heldEpoch, setHeldEpoch] = useState(0);
  const [saving, setSaving] = useState(false);
  const flight = useRef(false);
  const held = heldEpoch < 0 ? null : unknownAction<BaseHeld>(subject);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ id: string; nonce: number } | null>(
    null,
  );
  const [resetEpoch, setResetEpoch] = useState(0);
  const disabled = saving || held !== null;

  useEffect(
    () => subscribeHeldWrites(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  async function finish(action: BaseHeld) {
    if (flight.current) return;
    flight.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    const requestId = action.write.requestId;
    try {
      try {
        if (action.kind === 'mapping') await setBaseMapping(action.write);
        else if (action.kind === 'policy') await setOptionPolicy(action.write);
        else await setException(action.write);
        settleAction(subject, requestId);
        setResetEpoch((value) => value + 1);
      } catch (failure) {
        settleAction(subject, requestId, failure);
        setError(messageFrom(failure));
        if (!hasAction(subject)) await onReload();
        return;
      }
      await onReload();
      setNotice(
        action.kind === 'mapping'
          ? savedMappingMessage
          : action.kind === 'policy'
            ? savedPolicyMessage
            : savedExceptionMessage,
      );
    } catch (failure) {
      setError(messageFrom(failure));
    } finally {
      flight.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded border border-neutral-200 p-3">
      <h2 className="text-xl font-semibold">
        {subjectTitle(base)} — {sizeLabel(base.sizeKey)}
      </h2>
      <p>
        آخر سطر: {statusLabel(detail.resolution.status)} — {base.saleCount}{' '}
        عملية
      </p>
      {detail.resolution.issues.length > 0 ? (
        <ul aria-label="أسباب النقص">
          {detail.resolution.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>
              {issueLabel(issue.code)}
              {issue.expandIssue ? ` (${issueLabel(issue.expandIssue)})` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {detail.resolution.requirements.length > 0 ? (
        <ul aria-label="الكميات الخام">
          {detail.resolution.requirements.map((row) => (
            <li key={row.stockItemId}>
              {itemName(catalog, row.stockItemId)}: {row.quantity}{' '}
              {unitLabel(catalog, row.baseUnit)}
            </li>
          ))}
        </ul>
      ) : null}
      {held ? (
        <UnknownSave disabled={saving} onRetry={() => void finish(held)} />
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <BaseMappingForm
        base={base}
        detail={detail}
        catalog={catalog}
        disabled={disabled}
        picked={picked}
        resetEpoch={resetEpoch}
        onError={setError}
        onFinish={(action) => void finish(action)}
      />
      <section className="flex flex-col gap-2" aria-label="اقتراحات">
        <h3 className="font-semibold">اقتراحات</h3>
        {detail.suggestions.length === 0 ? <p>مفيش اقتراح بالاسم</p> : null}
        <ul className="flex flex-col gap-2">
          {detail.suggestions.map((suggestion) => (
            <li key={suggestion.recipeId}>
              {suggestion.name}
              {suggestion.via === 'binding' ? ' — من رابط الاستيراد' : ''}
              <button
                className={`${primaryButton} ms-2`}
                type="button"
                disabled={disabled}
                onClick={() =>
                  setPicked({ id: suggestion.recipeId, nonce: Date.now() })
                }
              >
                استخدم الوصفة
              </button>
            </li>
          ))}
        </ul>
      </section>
      <PolicyForm
        base={base}
        detail={detail}
        catalog={catalog}
        disabled={disabled}
        resetEpoch={resetEpoch}
        onError={setError}
        onFinish={(action) => void finish(action)}
      />
      <ExceptionForm
        base={base}
        detail={detail}
        catalog={catalog}
        disabled={disabled}
        resetEpoch={resetEpoch}
        onError={setError}
        onFinish={(action) => void finish(action)}
      />
      <HistoryList rows={detail.history} catalog={catalog} />
      <section className="flex flex-col gap-3">
        <h3 className="font-semibold">اختيارات ظهرت على السطور</h3>
        {detail.options.length === 0 ? <p>مفيش اختيارات</p> : null}
        {detail.options.map((option) =>
          option.optionValue.trim().length === 0 ? (
            <p key="blank">اختيار فاضي ظهر {option.seenCount} مرة ومش بيتحدد</p>
          ) : (
            <OptionBlock
              key={option.optionValue}
              base={base}
              optionValue={option.optionValue}
              seenCount={option.seenCount}
              detail={detail}
              catalog={catalog}
              onReload={onReload}
            />
          ),
        )}
      </section>
    </section>
  );
}

function BaseMappingForm({
  base,
  detail,
  catalog,
  disabled,
  picked,
  resetEpoch,
  onError,
  onFinish,
}: {
  base: ObservedBase;
  detail: SubjectDetail;
  catalog: MappingCatalog;
  disabled: boolean;
  picked: { id: string; nonce: number } | null;
  resetEpoch: number;
  onError: (message: string | null) => void;
  onFinish: (action: BaseHeld) => void;
}) {
  const subject = baseSubject(base.posItemId, base.sizeKeyText);
  const { timing, covering, atMs } = useFamilyTiming(
    detail.schedule.versions,
    'mapping',
    detail.schedule.token,
    catalog.shiftStart,
    disabled,
  );
  const seedKey = `${covering?.id ?? ''}|${detail.schedule.token}`;
  const [seeded, setSeeded] = useState({
    key: seedKey,
    versionId: covering?.id ?? null,
  });
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<TargetMode>(
    covering?.targetKind === 'recipe' ? 'recipe' : 'stock',
  );
  const [recipeId, setRecipeId] = useState(covering?.recipeId ?? '');
  const [stockItemId, setStockItemId] = useState(covering?.stockItemId ?? '');
  const [quantity, setQuantity] = useState(covering?.quantityPerBasis ?? '1');
  const [unit, setUnit] = useState(covering?.unitCode ?? '');
  const [seenEpoch, setSeenEpoch] = useState(resetEpoch);
  const [appliedNonce, setAppliedNonce] = useState<number | null>(null);

  if (seenEpoch !== resetEpoch) {
    setSeenEpoch(resetEpoch);
    setDirty(false);
  }

  if (seeded.key !== seedKey && !dirty) {
    const next = fieldsFromVersion(covering, baseModes, 'stock');
    setSeeded({ key: seedKey, versionId: covering?.id ?? null });
    setMode(next.mode);
    setRecipeId(next.recipeId);
    setStockItemId(next.stockItemId);
    setQuantity(next.quantity);
    setUnit(next.unit);
  }

  if (picked && appliedNonce !== picked.nonce) {
    setAppliedNonce(picked.nonce);
    setMode('recipe');
    setRecipeId(picked.id);
    setDirty(true);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || hasAction(subject)) return;
    const dated = datedFrom(timing, detail.schedule.token);
    if (!dated.ok) {
      onError(dated.error);
      return;
    }
    const inForce = coverAt(
      detail.schedule.versions.filter(
        (version) => version.family === 'mapping',
      ),
      dated.instantMs ?? atMs,
    );
    if ((inForce?.id ?? null) !== seeded.versionId) {
      const next = fieldsFromVersion(inForce, baseModes, 'stock');
      setMode(next.mode);
      setRecipeId(next.recipeId);
      setStockItemId(next.stockItemId);
      setQuantity(next.quantity);
      setUnit(next.unit);
      setSeeded({
        key: `${inForce?.id ?? ''}|${detail.schedule.token}`,
        versionId: inForce?.id ?? null,
      });
      setDirty((inForce?.id ?? null) !== (covering?.id ?? null));
      onError(sourceChangedMessage);
      return;
    }
    const target = targetFromDraft(mode, recipeId, stockItemId, quantity, unit);
    if (!target.ok) {
      onError(target.error);
      return;
    }
    onError(null);
    const action = beginAction<BaseHeld>(subject, (requestId) => ({
      kind: 'mapping',
      write: {
        ...dated.write,
        requestId,
        posItemId: base.posItemId,
        sizeKey: base.sizeKey,
        target: target.target,
      },
    }));
    onFinish(action);
  }

  const summary =
    covering?.targetKind === 'recipe'
      ? recipeName(catalog, covering.recipeId)
      : covering?.targetKind === 'stock'
        ? `${itemName(catalog, covering.stockItemId)} — ${covering.quantityPerBasis ?? ''} ${unitLabel(catalog, covering.unitCode)}`
        : 'مفيش ربط ساري';

  return (
    <form
      className="flex flex-col gap-3"
      aria-label="ربط الصنف"
      onSubmit={onSubmit}
    >
      <h3 className="font-semibold">الربط</h3>
      <p>الساري: {summary}</p>
      <p>سطر الوزن بيتطبق لكل كيلو. السطر الثابت بيضرب كمية البيع.</p>
      <TargetFields
        modes={baseModes}
        mode={mode}
        recipeId={recipeId}
        stockItemId={stockItemId}
        quantity={quantity}
        unit={unit}
        catalog={catalog}
        disabled={disabled}
        onMode={(next) => {
          setDirty(true);
          setMode(next);
        }}
        onRecipe={(id) => {
          setDirty(true);
          setRecipeId(id);
        }}
        onItem={(id) => {
          setDirty(true);
          setStockItemId(id);
          const item = catalog.items.find((entry) => entry.id === id);
          if (
            item &&
            catalog.units.some((entry) => entry.code === item.baseUnit)
          ) {
            setUnit(item.baseUnit);
          }
        }}
        onQuantity={(value) => {
          setDirty(true);
          setQuantity(value);
        }}
        onUnit={(code) => {
          setDirty(true);
          setUnit(code);
        }}
      />
      {timing.fields}
      <button className={primaryButton} type="submit" disabled={disabled}>
        احفظ الربط
      </button>
    </form>
  );
}

function PolicyForm({
  base,
  detail,
  catalog,
  disabled,
  resetEpoch,
  onError,
  onFinish,
}: {
  base: ObservedBase;
  detail: SubjectDetail;
  catalog: MappingCatalog;
  disabled: boolean;
  resetEpoch: number;
  onError: (message: string | null) => void;
  onFinish: (action: BaseHeld) => void;
}) {
  const subject = baseSubject(base.posItemId, base.sizeKeyText);
  const { timing, covering, atMs } = useFamilyTiming(
    detail.schedule.versions,
    'option_policy',
    detail.schedule.token,
    catalog.shiftStart,
    disabled,
  );
  const seedKey = `${covering?.id ?? ''}|${detail.schedule.token}`;
  const [seeded, setSeeded] = useState({
    key: seedKey,
    versionId: covering?.id ?? null,
  });
  const [dirty, setDirty] = useState(false);
  const [policy, setPolicy] = useState<OptionPolicy | ''>(
    covering?.optionPolicy ?? '',
  );
  const [seenEpoch, setSeenEpoch] = useState(resetEpoch);

  if (seenEpoch !== resetEpoch) {
    setSeenEpoch(resetEpoch);
    setDirty(false);
  }

  if (seeded.key !== seedKey && !dirty) {
    setSeeded({ key: seedKey, versionId: covering?.id ?? null });
    setPolicy(covering?.optionPolicy ?? '');
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || hasAction(subject)) return;
    const dated = datedFrom(timing, detail.schedule.token);
    if (!dated.ok) {
      onError(dated.error);
      return;
    }
    const inForce = coverAt(
      detail.schedule.versions.filter(
        (version) => version.family === 'option_policy',
      ),
      dated.instantMs ?? atMs,
    );
    if ((inForce?.id ?? null) !== seeded.versionId) {
      setSeeded({
        key: `${inForce?.id ?? ''}|${detail.schedule.token}`,
        versionId: inForce?.id ?? null,
      });
      setDirty(false);
      setPolicy(inForce?.optionPolicy ?? '');
      onError(sourceChangedMessage);
      return;
    }
    onError(null);
    const action = beginAction<BaseHeld>(subject, (requestId) => ({
      kind: 'policy',
      write: {
        ...dated.write,
        requestId,
        posItemId: base.posItemId,
        sizeKey: base.sizeKey,
        policy: policy === '' ? null : policy,
      },
    }));
    onFinish(action);
  }

  return (
    <form
      className="flex flex-col gap-3"
      aria-label="سياسة الاختيارات"
      onSubmit={onSubmit}
    >
      <h3 className="font-semibold">سياسة الاختيارات</h3>
      <p>
        السارية:{' '}
        {covering?.optionPolicy ? policyLabel(covering.optionPolicy) : 'مفيش'}
      </p>
      <label className="flex flex-col gap-1">
        السياسة
        <select
          className={fieldClass}
          disabled={disabled}
          value={policy}
          onChange={(event) => {
            const next = event.target.value;
            if (
              next !== '' &&
              next !== 'none_expected' &&
              next !== 'exactly_one' &&
              next !== 'additive'
            ) {
              return;
            }
            setDirty(true);
            setPolicy(next);
          }}
        >
          <option value="">فضي</option>
          <option value="none_expected">من غير اختيار</option>
          <option value="exactly_one">اختيار واحد</option>
          <option value="additive">اختيارات بتتضاف</option>
        </select>
      </label>
      {timing.fields}
      <button className={primaryButton} type="submit" disabled={disabled}>
        احفظ السياسة
      </button>
    </form>
  );
}

function ExceptionForm({
  base,
  detail,
  catalog,
  disabled,
  resetEpoch,
  onError,
  onFinish,
}: {
  base: ObservedBase;
  detail: SubjectDetail;
  catalog: MappingCatalog;
  disabled: boolean;
  resetEpoch: number;
  onError: (message: string | null) => void;
  onFinish: (action: BaseHeld) => void;
}) {
  const subject = baseSubject(base.posItemId, base.sizeKeyText);
  const { timing, covering, atMs } = useFamilyTiming(
    detail.schedule.versions,
    'exception',
    detail.schedule.token,
    catalog.shiftStart,
    disabled,
  );
  const seedKey = `${covering?.id ?? ''}|${detail.schedule.token}`;
  const [seeded, setSeeded] = useState({
    key: seedKey,
    versionId: covering?.id ?? null,
  });
  const [dirty, setDirty] = useState(false);
  const [reason, setReason] = useState(covering?.exceptionReason ?? '');
  const [seenEpoch, setSeenEpoch] = useState(resetEpoch);

  if (seenEpoch !== resetEpoch) {
    setSeenEpoch(resetEpoch);
    setDirty(false);
  }

  if (seeded.key !== seedKey && !dirty) {
    setSeeded({ key: seedKey, versionId: covering?.id ?? null });
    setReason(covering?.exceptionReason ?? '');
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || hasAction(subject)) return;
    const trimmed = reason.trim();
    if (trimmed.length > 500) {
      onError('سبب الاستثناء طويل أوي');
      return;
    }
    const dated = datedFrom(timing, detail.schedule.token);
    if (!dated.ok) {
      onError(dated.error);
      return;
    }
    const inForce = coverAt(
      detail.schedule.versions.filter(
        (version) => version.family === 'exception',
      ),
      dated.instantMs ?? atMs,
    );
    if ((inForce?.id ?? null) !== seeded.versionId) {
      setSeeded({
        key: `${inForce?.id ?? ''}|${detail.schedule.token}`,
        versionId: inForce?.id ?? null,
      });
      setDirty(false);
      setReason(inForce?.exceptionReason ?? '');
      onError(sourceChangedMessage);
      return;
    }
    onError(null);
    const action = beginAction<BaseHeld>(subject, (requestId) => ({
      kind: 'exception',
      write: {
        ...dated.write,
        requestId,
        posItemId: base.posItemId,
        sizeKey: base.sizeKey,
        exceptionReason: trimmed.length === 0 ? null : trimmed,
      },
    }));
    onFinish(action);
  }

  return (
    <form
      className="flex flex-col gap-3"
      aria-label="استثناء من المخزون"
      onSubmit={onSubmit}
    >
      <h3 className="font-semibold">استثناء</h3>
      <p>الصنف ده ملوش مخزون، زي خدمة أو رسوم. السبب الفاضي بيمسح الاستثناء.</p>
      <p>الساري: {covering?.exceptionReason ?? 'مفيش'}</p>
      <label className="flex flex-col gap-1">
        سبب الاستثناء
        <textarea
          className={fieldClass}
          disabled={disabled}
          value={reason}
          onChange={(event) => {
            setDirty(true);
            setReason(event.target.value);
          }}
        />
      </label>
      {timing.fields}
      <button className={primaryButton} type="submit" disabled={disabled}>
        احفظ الاستثناء
      </button>
    </form>
  );
}

function OptionBlock({
  base,
  optionValue,
  seenCount,
  detail,
  catalog,
  onReload,
}: {
  base: ObservedBase;
  optionValue: string;
  seenCount: number;
  detail: SubjectDetail;
  catalog: MappingCatalog;
  onReload: () => Promise<void>;
}) {
  const global = detail.optionBindings.find(
    (binding) =>
      binding.scope === 'global' && binding.optionValue === optionValue,
  );
  const scoped = detail.optionBindings.find(
    (binding) =>
      binding.scope === 'item' && binding.optionValue === optionValue,
  );
  return (
    <section className="flex flex-col gap-3 rounded border border-neutral-200 p-3">
      <h3 className="font-semibold">
        {optionValue} — {seenCount} مرة
      </h3>
      {global ? (
        <OptionMappingForm
          formLabel={`ربط الاختيار العام ${optionValue}`}
          title="ربط عام"
          scope="global"
          base={base}
          optionValue={optionValue}
          schedule={global.schedule}
          history={
            detail.optionHistory.find(
              (entry) => entry.subjectId === global.schedule.subjectId,
            )?.rows ?? []
          }
          catalog={catalog}
          onReload={onReload}
        />
      ) : null}
      {scoped ? (
        <OptionMappingForm
          formLabel={`ربط الاختيار للصنف ${optionValue}`}
          title="تخصيص للصنف ده"
          scope="item"
          base={base}
          optionValue={optionValue}
          schedule={scoped.schedule}
          history={
            detail.optionHistory.find(
              (entry) => entry.subjectId === scoped.schedule.subjectId,
            )?.rows ?? []
          }
          catalog={catalog}
          onReload={onReload}
        />
      ) : null}
    </section>
  );
}

function OptionMappingForm({
  formLabel,
  title,
  scope,
  base,
  optionValue,
  schedule,
  history,
  catalog,
  onReload,
}: {
  formLabel: string;
  title: string;
  scope: 'global' | 'item';
  base: ObservedBase;
  optionValue: string;
  schedule: SubjectDetail['schedule'];
  history: readonly HistoryRow[];
  catalog: MappingCatalog;
  onReload: () => Promise<void>;
}) {
  const subject = optionSubject(
    scope,
    scope === 'item' ? base.posItemId : '',
    scope === 'item' ? base.sizeKeyText : '',
    optionValue,
  );
  const [heldEpoch, setHeldEpoch] = useState(0);
  const [saving, setSaving] = useState(false);
  const flight = useRef(false);
  const held =
    heldEpoch < 0 ? null : unknownAction<OptionMappingWrite>(subject);
  const disabled = saving || held !== null;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { timing, covering, atMs } = useFamilyTiming(
    schedule.versions,
    'mapping',
    schedule.token,
    catalog.shiftStart,
    disabled,
  );
  const seedKey = `${covering?.id ?? ''}|${schedule.token}`;
  const [seeded, setSeeded] = useState({
    key: seedKey,
    versionId: covering?.id ?? null,
  });
  const [dirty, setDirty] = useState(false);
  const initialMode: TargetMode =
    covering?.targetKind === 'recipe' ||
    covering?.targetKind === 'stock' ||
    covering?.targetKind === 'unmapped' ||
    covering?.targetKind === 'no_stock'
      ? covering.targetKind
      : 'gap';
  const [mode, setMode] = useState<TargetMode>(initialMode);
  const [recipeId, setRecipeId] = useState(covering?.recipeId ?? '');
  const [stockItemId, setStockItemId] = useState(covering?.stockItemId ?? '');
  const [quantity, setQuantity] = useState(covering?.quantityPerBasis ?? '1');
  const [unit, setUnit] = useState(covering?.unitCode ?? '');

  useEffect(
    () => subscribeHeldWrites(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  if (seeded.key !== seedKey && !dirty) {
    const next = fieldsFromVersion(covering, optionModes, 'gap');
    setSeeded({ key: seedKey, versionId: covering?.id ?? null });
    setMode(next.mode);
    setRecipeId(next.recipeId);
    setStockItemId(next.stockItemId);
    setQuantity(next.quantity);
    setUnit(next.unit);
  }

  async function finish(write: OptionMappingWrite) {
    if (flight.current) return;
    flight.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      try {
        await setOptionMapping(write);
        settleAction(subject, write.requestId);
        setDirty(false);
      } catch (failure) {
        settleAction(subject, write.requestId, failure);
        setError(messageFrom(failure));
        if (!hasAction(subject)) await onReload();
        return;
      }
      await onReload();
      setNotice(savedOptionMessage);
    } catch (failure) {
      setError(messageFrom(failure));
    } finally {
      flight.current = false;
      setSaving(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || hasAction(subject)) return;
    const dated = datedFrom(timing, schedule.token);
    if (!dated.ok) {
      setError(dated.error);
      return;
    }
    const inForce = coverAt(
      schedule.versions.filter((version) => version.family === 'mapping'),
      dated.instantMs ?? atMs,
    );
    if ((inForce?.id ?? null) !== seeded.versionId) {
      const next = fieldsFromVersion(inForce, optionModes, 'gap');
      setMode(next.mode);
      setRecipeId(next.recipeId);
      setStockItemId(next.stockItemId);
      setQuantity(next.quantity);
      setUnit(next.unit);
      setSeeded({
        key: `${inForce?.id ?? ''}|${schedule.token}`,
        versionId: inForce?.id ?? null,
      });
      setDirty((inForce?.id ?? null) !== (covering?.id ?? null));
      setError(sourceChangedMessage);
      return;
    }
    const target = targetFromDraft(mode, recipeId, stockItemId, quantity, unit);
    if (!target.ok) {
      setError(target.error);
      return;
    }
    const action = beginAction<OptionMappingWrite>(subject, (requestId) => ({
      ...dated.write,
      requestId,
      scope,
      posItemId: scope === 'item' ? base.posItemId : null,
      sizeKey: scope === 'item' ? base.sizeKey : null,
      optionValue,
      target: target.target,
    }));
    void finish(action);
  }

  return (
    <form
      className="flex flex-col gap-3"
      aria-label={formLabel}
      onSubmit={onSubmit}
    >
      <h4 className="font-semibold">{title}</h4>
      <p>
        {scope === 'global'
          ? 'الربط العام بينطبق على كل الأصناف، إلا لو الصنف ليه تخصيص.'
          : 'التخصيص غير المربوط أو من غير مخزون بيمنع الرجوع للعام. الفضي بيرجع للعام.'}
      </p>
      {held ? (
        <UnknownSave disabled={saving} onRetry={() => void finish(held)} />
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <TargetFields
        modes={optionModes}
        mode={mode}
        recipeId={recipeId}
        stockItemId={stockItemId}
        quantity={quantity}
        unit={unit}
        catalog={catalog}
        disabled={disabled}
        onMode={(next) => {
          setDirty(true);
          setMode(next);
        }}
        onRecipe={(id) => {
          setDirty(true);
          setRecipeId(id);
        }}
        onItem={(id) => {
          setDirty(true);
          setStockItemId(id);
          const item = catalog.items.find((entry) => entry.id === id);
          if (
            item &&
            catalog.units.some((entry) => entry.code === item.baseUnit)
          ) {
            setUnit(item.baseUnit);
          }
        }}
        onQuantity={(value) => {
          setDirty(true);
          setQuantity(value);
        }}
        onUnit={(code) => {
          setDirty(true);
          setUnit(code);
        }}
      />
      {timing.fields}
      <button className={primaryButton} type="submit" disabled={disabled}>
        احفظ ربط الاختيار
      </button>
      <HistoryList rows={history} catalog={catalog} />
    </form>
  );
}
