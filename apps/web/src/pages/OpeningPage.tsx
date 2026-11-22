import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { messageFrom } from '@/items/errors';
import {
  clearHeldWrite,
  clearPostedReload,
  getHeldWrite,
  setHeldWritePhase,
  storageWriteFailedMessage,
  subscribeHeldWritesStore,
  tryPutHeldWrite,
} from '@/lib/held-writes';
import { isOnline, offlineWriteMessage, useOnline } from '@/lib/online';
import { isPayloadRefusal, isUnknownOutcome } from '@/lib/write-outcome';
import {
  listStockChoices,
  listUnitsAt,
  recordOpeningStock,
} from '@/purchases/api';
import {
  ConversionChangedError,
  genericPurchaseError,
} from '@/purchases/errors';
import { OpeningGrid } from '@/purchases/OpeningGrid';
import type { OpeningDraft, StockChoice } from '@/purchases/types';

const OPENING_SUBJECT = 'opening:new';

const shell =
  'mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 px-4 py-6 text-start';
const secondaryButton =
  'w-fit rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

export function OpeningPage() {
  const online = useOnline();
  const [items, setItems] = useState<StockChoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const [saving, setSaving] = useState(false);
  const [localNeedsReload, setLocalNeedsReload] = useState(false);
  const [loads, setLoads] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const [unitsNonce, setUnitsNonce] = useState(0);
  const [heldEpoch, setHeldEpoch] = useState(0);
  const seqRef = useRef(0);
  const loadsRef = useRef(0);

  useEffect(
    () => subscribeHeldWritesStore(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  const stored =
    heldEpoch < 0 ? null : getHeldWrite<OpeningDraft>(OPENING_SUBJECT);
  const pending = stored?.phase === 'unknown' ? stored.payload : null;
  const inflight = stored?.phase === 'inflight';
  const postedReload = stored?.phase === 'posted_reload';
  const needsReload = localNeedsReload || postedReload;
  const busy = saving || inflight || needsReload || loads > 0;
  const writeLocked = busy || !online;
  const candidates = (items ?? []).filter((item) => !item.hasMovements);

  async function readChoices(): Promise<StockChoice[] | null> {
    const seq = ++seqRef.current;
    loadsRef.current += 1;
    setLoads(loadsRef.current);
    try {
      const next = await listStockChoices();
      return seq === seqRef.current ? next : null;
    } catch (error) {
      if (seq !== seqRef.current) return null;
      throw error;
    } finally {
      loadsRef.current -= 1;
      setLoads(loadsRef.current);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await readChoices();
        if (cancelled || !next) return;
        setItems(next);
        setLoadError(null);
        clearPostedReload(OPENING_SUBJECT);
        setLocalNeedsReload(false);
      } catch (error) {
        if (cancelled) return;
        setLoadError(messageFrom(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadId]);

  function retry() {
    if (saving || loadsRef.current > 0) return;
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  async function handleSubmit(draft: OpeningDraft) {
    if (busy || loadsRef.current > 0 || !isOnline()) return;
    const prior = getHeldWrite<OpeningDraft>(OPENING_SUBJECT);
    const wasPinned =
      prior !== null &&
      prior.requestId === draft.requestId &&
      prior.phase === 'unknown';
    const pin = tryPutHeldWrite(OPENING_SUBJECT, {
      requestId: draft.requestId,
      payload: draft,
      phase: 'inflight',
      kind: 'opening',
    });
    if (!pin.ok) {
      if (pin.reason === 'storage') {
        setServerError(storageWriteFailedMessage);
      }
      return;
    }
    setSaving(true);
    setServerError(null);
    setSuccess(null);
    let saved = false;
    try {
      await recordOpeningStock(draft);
      saved = true;
      setHeldWritePhase(OPENING_SUBJECT, draft.requestId, 'posted_reload');
      setLocalNeedsReload(true);
      setFormEpoch((value) => value + 1);
      setSuccess('اتسجل الرصيد الافتتاحي');
      const next = await readChoices();
      if (next) {
        setItems(next);
        setLoadError(null);
        clearPostedReload(OPENING_SUBJECT);
        setLocalNeedsReload(false);
      }
    } catch (error) {
      if (!saved) {
        setServerError(messageFrom(error));
        if (error instanceof ConversionChangedError) {
          clearHeldWrite(OPENING_SUBJECT, draft.requestId);
          // Same items and timestamp. Block the next save until this
          // lookup replaces the factor the server just rejected.
          setUnitsNonce((value) => value + 1);
          try {
            const next = await readChoices();
            if (next) setItems(next);
          } catch (reloadError) {
            setLoadError(messageFrom(reloadError));
          }
        } else if (wasPinned) {
          if (isPayloadRefusal(error)) {
            clearHeldWrite(OPENING_SUBJECT, draft.requestId);
          } else {
            setHeldWritePhase(OPENING_SUBJECT, draft.requestId, 'unknown');
          }
        } else if (isUnknownOutcome(error)) {
          setHeldWritePhase(OPENING_SUBJECT, draft.requestId, 'unknown');
        } else {
          clearHeldWrite(OPENING_SUBJECT, draft.requestId);
        }
      } else {
        setLocalNeedsReload(true);
        setLoadError(messageFrom(error));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className={shell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">الرصيد الافتتاحي</h1>
      {!online ? <p role="status">{offlineWriteMessage}</p> : null}
      {success ? <p role="status">{success}</p> : null}
      {loading && items === null ? <p>جاري تحميل الأصناف…</p> : null}
      {items === null && !loading ? (
        <div className="flex flex-col gap-3">
          <p role="alert">{loadError ?? genericPurchaseError}</p>
          <button
            className={secondaryButton}
            type="button"
            disabled={saving || loads > 0}
            onClick={retry}
          >
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {items !== null && loadError ? (
        <div className="flex flex-col gap-2">
          <p role="alert">{loadError}</p>
          <button
            className={secondaryButton}
            type="button"
            disabled={saving || loads > 0}
            onClick={retry}
          >
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {items !== null && candidates.length === 0 && pending === null ? (
        <p>كل الأصناف ليها رصيد افتتاحي</p>
      ) : null}
      {items !== null && (candidates.length > 0 || pending !== null) ? (
        <OpeningGrid
          key={formEpoch}
          items={candidates}
          allItems={items}
          locked={writeLocked}
          submitting={saving}
          serverError={serverError}
          pending={pending}
          onClearServerError={() => setServerError(null)}
          onSubmit={(draft) => void handleSubmit(draft)}
          resolveUnits={listUnitsAt}
          reloadKey={unitsNonce}
        />
      ) : null}
    </main>
  );
}
