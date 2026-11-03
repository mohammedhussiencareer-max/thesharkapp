import { useEffect, useState } from 'react';
import { cairoDateTimeLocalToIso } from '@/purchases/time';
import type { StockChoice, UnitOption } from '@/purchases/types';

type UnitLookup = Record<string, UnitOption[]>;

type UnitLookupResult = {
  key: string;
  ids: string;
  overlay: UnitLookup | null;
};

export function useResolvedUnits(
  items: readonly StockChoice[],
  atLocal: string,
  resolveUnits?: (
    itemIds: readonly string[],
    atIso: string,
  ) => Promise<UnitLookup>,
): { items: readonly StockChoice[]; loading: boolean } {
  const ids = items.map((item) => item.id).join('\n');
  // The same Cairo parse the purchase and opening writers use, so the lookup
  // sees the units that will be in force for the submitted instant. A new
  // mount (navigation) fetches again.
  const at = cairoDateTimeLocalToIso(atLocal);
  const key = `${ids}\n${at ?? ''}`;
  const [result, setResult] = useState<UnitLookupResult | null>(null);

  useEffect(() => {
    if (!resolveUnits || !at) return;
    let cancelled = false;
    const itemIds = ids.length === 0 ? [] : ids.split('\n');
    void resolveUnits(itemIds, at)
      .then((next) => {
        if (!cancelled) setResult({ key, ids, overlay: next });
      })
      .catch(() => {
        if (!cancelled) setResult({ key, ids, overlay: null });
      });
    return () => {
      cancelled = true;
    };
  }, [resolveUnits, at, ids, key]);

  if (!resolveUnits || !at) return { items, loading: false };
  const ready = result?.key === key;
  const loading = !ready;
  const overlay = ready
    ? result.overlay
    : result?.ids === ids
      ? result.overlay
      : null;
  if (!overlay) return { items, loading };
  return {
    loading,
    items: items.map((item) =>
      overlay[item.id] === undefined
        ? item
        : { ...item, conversions: overlay[item.id] ?? [] },
    ),
  };
}
