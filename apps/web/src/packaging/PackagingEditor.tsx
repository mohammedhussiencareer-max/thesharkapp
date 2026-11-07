import { useEffect, useRef, useState, type FormEvent } from 'react';
import { genericCatalogError, messageFrom } from '@/items/errors';
import {
  beginAction,
  hasAction,
  settleAction,
  subscribeHeldWrites,
  unknownAction,
} from '@/items/request-id';
import { UnknownSave } from '@/items/UnknownSave';
import { currentMinuteMs } from '@/items/effective';
import { useDatedTiming } from '@/items/useDatedTiming';
import { formatCairo } from '@/lib/cairo';
import { primaryButton } from '@/lib/page-style';
import { coverAt, quantityError } from '@/mapping/format';
import { sourceChangedMessage } from '@/mapping/labels';
import { setBasePackaging, setOrderTypePackaging } from '@/packaging/api';
import type {
  BasePackagingWrite,
  OrderTypePackagingWrite,
  PackagingHistoryRow,
  PackagingMode,
  PackagingPolicy,
  PackagingSchedule,
  PackagingVersion,
  PackagingWrite,
} from '@/packaging/types';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';

type DraftLine = {
  key: string;
  stockItemId: string;
  quantity: string;
  unit: string;
  capacity: string;
};

type EditorItem = { id: string; name: string; baseUnit: string };
type EditorUnit = { code: string; label: string };

function itemName(items: readonly EditorItem[], id: string): string {
  return items.find((item) => item.id === id)?.name ?? 'صنف تغليف';
}

function unitName(units: readonly EditorUnit[], code: string): string {
  return units.find((unit) => unit.code === code)?.label ?? code;
}

function policyText(
  version: PackagingVersion | null,
  items: readonly EditorItem[],
  units: readonly EditorUnit[],
): string {
  if (!version) return 'لسه متتراجعش';
  if (version.decision === 'none') return 'مفيش تغليف';
  if (version.lines.length === 0) return 'سطور تغليف';
  return version.lines
    .map((line) => {
      const capacity = line.capacityKg ? ` — سعة ${line.capacityKg} كيلو` : '';
      return `${itemName(items, line.stockItemId)} — ${line.quantity} ${unitName(units, line.unitCode)}${capacity}`;
    })
    .join('، ');
}

function blankLine(units: readonly EditorUnit[]): DraftLine {
  return {
    key: crypto.randomUUID(),
    stockItemId: '',
    quantity: '',
    unit: units[0]?.code ?? '',
    capacity: '',
  };
}

function draftsFrom(
  version: PackagingVersion | null,
  units: readonly EditorUnit[],
): DraftLine[] {
  if (!version || version.decision !== 'lines' || version.lines.length === 0) {
    return [blankLine(units)];
  }
  return version.lines.map((line) => ({
    key: crypto.randomUUID(),
    stockItemId: line.stockItemId,
    quantity: line.quantity,
    unit: line.unitCode,
    capacity: line.capacityKg ?? '',
  }));
}

function PackagingForm({
  schedule,
  items,
  units,
  shiftStart,
  allowCapacity,
  disabled,
  onError,
  onFinish,
}: {
  schedule: PackagingSchedule;
  items: readonly EditorItem[];
  units: readonly EditorUnit[];
  shiftStart: string | null;
  allowCapacity: boolean;
  disabled: boolean;
  onError: (message: string) => void;
  onFinish: (timing: {
    effectiveFrom: string | null;
    effectiveTo: string | null;
    reason: string | null;
    policy: PackagingPolicy | null;
  }) => void;
}) {
  const timing = useDatedTiming(
    undefined,
    shiftStart,
    schedule.versions,
    schedule.token,
    disabled,
  );
  const [mountNow] = useState(() => currentMinuteMs(Date.now()));
  const atMs = timing.instantMs ?? mountNow;
  const covering = coverAt(schedule.versions, atMs);
  const seedKey = `${covering?.id ?? ''}|${schedule.token}`;
  const [seeded, setSeeded] = useState({
    key: seedKey,
    versionId: covering?.id ?? null,
  });
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<PackagingMode>(covering?.decision ?? 'gap');
  const [lines, setLines] = useState<DraftLine[]>(() =>
    draftsFrom(covering, units),
  );

  if (seeded.key !== seedKey && !dirty) {
    setSeeded({ key: seedKey, versionId: covering?.id ?? null });
    setMode(covering?.decision ?? 'gap');
    setLines(draftsFrom(covering, units));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const built = timing.build();
    if (!built.ok) {
      onError(built.error);
      return;
    }
    const inForce = coverAt(schedule.versions, built.instantMs ?? atMs);
    if ((inForce?.id ?? null) !== seeded.versionId) {
      setMode(inForce?.decision ?? 'gap');
      setLines(draftsFrom(inForce, units));
      setSeeded({
        key: `${inForce?.id ?? ''}|${schedule.token}`,
        versionId: inForce?.id ?? null,
      });
      setDirty((inForce?.id ?? null) !== (covering?.id ?? null));
      onError(sourceChangedMessage);
      return;
    }
    let policy: PackagingPolicy | null = null;
    if (mode === 'none') policy = { none: true };
    if (mode === 'lines') {
      if (lines.length === 0) {
        onError('ضيف سطر تغليف');
        return;
      }
      const seen = new Set<string>();
      const builtLines = [];
      for (const line of lines) {
        if (!line.stockItemId) {
          onError('اختار صنف التغليف');
          return;
        }
        if (seen.has(line.stockItemId)) {
          onError('الصنف متكرر في التغليف');
          return;
        }
        seen.add(line.stockItemId);
        const quantity = quantityError(line.quantity);
        if (quantity) {
          onError(quantity);
          return;
        }
        if (!line.unit) {
          onError('اختار وحدة التغليف');
          return;
        }
        const next: {
          stock_item_id: string;
          quantity: string;
          unit: string;
          capacity_kg?: string;
        } = {
          stock_item_id: line.stockItemId,
          quantity: line.quantity.trim(),
          unit: line.unit,
        };
        if (allowCapacity && line.capacity.trim().length > 0) {
          const capacity = quantityError(line.capacity);
          if (capacity) {
            onError(capacity);
            return;
          }
          next.capacity_kg = line.capacity.trim();
        }
        builtLines.push(next);
      }
      policy = { lines: builtLines };
    }
    onError('');
    onFinish({
      effectiveFrom: built.write.effectiveFrom,
      effectiveTo: built.write.effectiveTo,
      reason: built.write.reason,
      policy,
    });
  }

  return (
    <form
      className="flex flex-col gap-3"
      aria-label={allowCapacity ? 'تغليف الصنف' : 'تغليف نوع الطلب'}
      onSubmit={submit}
    >
      <p>الساري: {policyText(covering, items, units)}</p>
      <label className="flex flex-col gap-1">
        القرار
        <select
          className={fieldClass}
          disabled={disabled}
          value={mode}
          onChange={(event) => {
            const next = event.target.value;
            if (next === 'lines' || next === 'none' || next === 'gap') {
              setDirty(true);
              setMode(next);
            }
          }}
        >
          <option value="lines">سطور تغليف</option>
          <option value="none">مفيش تغليف</option>
          <option value="gap">فضي</option>
        </select>
      </label>
      {mode === 'lines'
        ? lines.map((line, index) => (
            <div key={line.key} className="flex flex-col gap-2">
              <label className="flex flex-col gap-1">
                صنف التغليف
                <select
                  className={fieldClass}
                  disabled={disabled}
                  value={line.stockItemId}
                  onChange={(event) => {
                    const stockItemId = event.target.value;
                    setDirty(true);
                    setLines((current) =>
                      current.map((entry, entryIndex) =>
                        entryIndex === index
                          ? { ...entry, stockItemId }
                          : entry,
                      ),
                    );
                  }}
                >
                  <option value="">اختار صنف التغليف</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                كمية التغليف
                <input
                  className={fieldClass}
                  inputMode="decimal"
                  disabled={disabled}
                  value={line.quantity}
                  onChange={(event) => {
                    const quantity = event.target.value;
                    setDirty(true);
                    setLines((current) =>
                      current.map((entry, entryIndex) =>
                        entryIndex === index ? { ...entry, quantity } : entry,
                      ),
                    );
                  }}
                />
              </label>
              <label className="flex flex-col gap-1">
                وحدة التغليف
                <select
                  className={fieldClass}
                  disabled={disabled}
                  value={line.unit}
                  onChange={(event) => {
                    const unit = event.target.value;
                    setDirty(true);
                    setLines((current) =>
                      current.map((entry, entryIndex) =>
                        entryIndex === index ? { ...entry, unit } : entry,
                      ),
                    );
                  }}
                >
                  {units.map((unit) => (
                    <option key={unit.code} value={unit.code}>
                      {unit.label}
                    </option>
                  ))}
                </select>
              </label>
              {allowCapacity ? (
                <label className="flex flex-col gap-1">
                  سعة الكيلو
                  <input
                    className={fieldClass}
                    inputMode="decimal"
                    disabled={disabled}
                    value={line.capacity}
                    onChange={(event) => {
                      const capacity = event.target.value;
                      setDirty(true);
                      setLines((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, capacity } : entry,
                        ),
                      );
                    }}
                  />
                </label>
              ) : null}
              {lines.length > 1 ? (
                <button
                  className="w-fit underline"
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setDirty(true);
                    setLines((current) =>
                      current.filter((entry) => entry.key !== line.key),
                    );
                  }}
                >
                  شيل السطر
                </button>
              ) : null}
            </div>
          ))
        : null}
      {mode === 'lines' ? (
        <button
          className="w-fit underline"
          type="button"
          disabled={disabled}
          onClick={() => {
            setDirty(true);
            setLines((current) => [...current, blankLine(units)]);
          }}
        >
          ضيف سطر
        </button>
      ) : null}
      {timing.fields}
      <button className={primaryButton} type="submit" disabled={disabled}>
        احفظ التغليف
      </button>
    </form>
  );
}

function HistoryList({
  rows,
  items,
  units,
}: {
  rows: readonly PackagingHistoryRow[];
  items: readonly EditorItem[];
  units: readonly EditorUnit[];
}) {
  return (
    <section className="flex flex-col gap-2" aria-label="سجل التغليف">
      <h3 className="font-semibold">السجل</h3>
      {rows.length === 0 ? <p>لسه مفيش سجل</p> : null}
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              {formatCairo(row.effectiveFrom)}
              {row.effectiveTo
                ? ` ← ${formatCairo(row.effectiveTo)}`
                : ' ← مفتوح'}
              {' — '}
              {policyText(row, items, units)}
              {row.superseded ? ' — اتبدلت' : ' — سارية'}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function PackagingEditor({
  subjectKey,
  kind,
  orderType,
  posItemId,
  sizeKey,
  schedule,
  history,
  items,
  units,
  shiftStart,
  allowCapacity,
  onReload,
}: {
  subjectKey: string;
  kind: 'order_type' | 'base';
  orderType?: string | null;
  posItemId?: string;
  sizeKey?: JsonSize;
  schedule: PackagingSchedule;
  history: readonly PackagingHistoryRow[];
  items: readonly EditorItem[];
  units: readonly EditorUnit[];
  shiftStart: string | null;
  allowCapacity: boolean;
  onReload: () => Promise<void>;
}) {
  const [heldEpoch, setHeldEpoch] = useState(0);
  const [saving, setSaving] = useState(false);
  const flight = useRef(false);
  const held = heldEpoch < 0 ? null : unknownAction<PackagingWrite>(subjectKey);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const disabled = saving || held !== null;

  useEffect(
    () => subscribeHeldWrites(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  async function finish(write: PackagingWrite) {
    if (flight.current) return;
    flight.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    const requestId = write.requestId;
    try {
      try {
        if (kind === 'order_type') {
          const orderWrite: OrderTypePackagingWrite = {
            ...write,
            orderType: orderType ?? null,
          };
          await setOrderTypePackaging(orderWrite);
        } else {
          if (!posItemId || !sizeKey) throw new Error(genericCatalogError);
          const baseWrite: BasePackagingWrite = {
            ...write,
            posItemId,
            sizeKey,
          };
          await setBasePackaging(baseWrite);
        }
        settleAction(subjectKey, requestId);
      } catch (failure) {
        settleAction(subjectKey, requestId, failure);
        setError(messageFrom(failure));
        if (!hasAction(subjectKey)) await onReload();
        return;
      }
      await onReload();
      setNotice('التغليف اتحفظ');
    } catch (failure) {
      setError(messageFrom(failure));
    } finally {
      flight.current = false;
      setSaving(false);
    }
  }

  function hold(timing: {
    effectiveFrom: string | null;
    effectiveTo: string | null;
    reason: string | null;
    policy: PackagingPolicy | null;
  }) {
    const write = beginAction(subjectKey, (requestId) => ({
      requestId,
      effectiveFrom: timing.effectiveFrom,
      effectiveTo: timing.effectiveTo,
      token: schedule.token,
      reason: timing.reason,
      policy: timing.policy,
    }));
    void finish(write);
  }

  return (
    <section className="flex flex-col gap-3" aria-label="التغليف">
      <h3 className="text-lg font-semibold">التغليف</h3>
      {held ? (
        <UnknownSave disabled={saving} onRetry={() => void finish(held)} />
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <PackagingForm
        key={schedule.token}
        schedule={schedule}
        items={items}
        units={units}
        shiftStart={shiftStart}
        allowCapacity={allowCapacity}
        disabled={disabled}
        onError={(message) => setError(message.length > 0 ? message : null)}
        onFinish={hold}
      />
      <HistoryList rows={history} items={items} units={units} />
    </section>
  );
}

type JsonSize = BasePackagingWrite['sizeKey'];
