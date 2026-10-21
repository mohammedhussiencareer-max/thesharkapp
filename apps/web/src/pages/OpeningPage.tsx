import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { messageFrom } from '@/items/errors';
import { listStockChoices, recordOpeningStock } from '@/purchases/api';
import { genericPurchaseError } from '@/purchases/errors';
import { OpeningGrid } from '@/purchases/OpeningGrid';
import type { OpeningDraft, StockChoice } from '@/purchases/types';

const shell =
  'mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 px-4 py-6 text-start';
const secondaryButton =
  'w-fit rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

export function OpeningPage() {
  const [items, setItems] = useState<StockChoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const [saving, setSaving] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [loads, setLoads] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const seqRef = useRef(0);
  const loadsRef = useRef(0);
  const busy = saving || needsReload || loads > 0;
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
        setNeedsReload(false);
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
    if (busy || loadsRef.current > 0) return;
    setSaving(true);
    setServerError(null);
    setSuccess(null);
    let saved = false;
    try {
      await recordOpeningStock(draft);
      saved = true;
      setNeedsReload(true);
      setFormEpoch((value) => value + 1);
      setSuccess('اتسجل الرصيد الافتتاحي');
      const next = await readChoices();
      if (next) {
        setItems(next);
        setLoadError(null);
        setNeedsReload(false);
      }
    } catch (error) {
      if (!saved) setServerError(messageFrom(error));
      else {
        setNeedsReload(true);
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
      {items !== null && candidates.length === 0 ? (
        <p>كل الأصناف ليها رصيد افتتاحي</p>
      ) : null}
      {items !== null && candidates.length > 0 ? (
        <OpeningGrid
          key={formEpoch}
          items={candidates}
          locked={busy}
          submitting={saving}
          serverError={serverError}
          onClearServerError={() => setServerError(null)}
          onSubmit={(draft) => void handleSubmit(draft)}
        />
      ) : null}
    </main>
  );
}
