import { useCallback, useEffect, useState } from 'react';
import { cairoDateTimeLocalToIso } from '@/purchases/time';
import type { StockChoice, UnitOption } from '@/purchases/types';

type UnitLookup = Record<string, UnitOption[]>;

/** A failed dated lookup is not an empty schedule. */
export const unitLookupErrorMessage =
  'مش قادرين نجيب وحدات الوقت ده. حاول تاني.';

type LookupState = {
  key: string;
  ids: string;
  overlay: UnitLookup | null;
  error: string | null;
};

/**
 * Dated units for the instant the purchase or opening form will submit.
 * `ready` is true only after the lookup for that instant succeeds.
 * A failure keeps `ready` false and exposes `error` plus `retry`.
 * `reloadKey` forces the same items and instant to be fetched again.
 */
export function useResolvedUnits(
  items: readonly StockChoice[],
  atLocal: string,
  resolveUnits?: (
    itemIds: readonly string[],
    atIso: string,
  ) => Promise<UnitLookup>,
  reloadKey = 0,
): {
  items: readonly StockChoice[];
  loading: boolean;
  error: string | null;
  ready: boolean;
  retry: () => void;
} {
  const ids = items.map((item) => item.id).join('\n');
  const at = cairoDateTimeLocalToIso(atLocal);
  const key = `${reloadKey}\n${ids}\n${at ?? ''}`;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<LookupState | null>(null);
  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!resolveUnits || !at) return;
    let cancelled = false;
    const itemIds = ids.length === 0 ? [] : ids.split('\n');
    void resolveUnits(itemIds, at)
      .then((next) => {
        if (!cancelled) setResult({ key, ids, overlay: next, error: null });
      })
      .catch(() => {
        if (!cancelled) {
          setResult({
            key,
            ids,
            overlay: null,
            error: unitLookupErrorMessage,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [resolveUnits, at, ids, key, attempt]);

  if (!resolveUnits || !at) {
    return { items, loading: false, error: null, ready: true, retry };
  }

  const matched = result?.key === key ? result : null;
  const ready =
    matched !== null && matched.error === null && matched.overlay !== null;
  const failed = matched !== null && matched.error !== null;
  const loading = !ready && !failed;
  // While a new instant is still loading, keep the last successful overlay for
  // the same items so the selected unit does not flicker. A failure is never
  // an overlay: callers must not submit until `ready`.
  const display = ready
    ? matched.overlay
    : !failed &&
        result !== null &&
        result.ids === ids &&
        result.error === null &&
        result.overlay !== null
      ? result.overlay
      : null;

  if (!display) {
    return {
      items,
      loading,
      error: failed ? matched.error : null,
      ready: false,
      retry,
    };
  }

  return {
    loading,
    error: null,
    ready,
    retry,
    items: items.map((item) =>
      display[item.id] === undefined
        ? item
        : { ...item, conversions: display[item.id] ?? [] },
    ),
  };
}
