import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { messageFrom } from '@/items/errors';
import {
  abortClaimBeforeDispatch,
  canDispatchHeldWrite,
  captureWriteSession,
  claimFreshHeldWrite,
  claimReplayHeldWrite,
  clearHeldWrite,
  clearPostedReload,
  clearPostedReloadSnapshot,
  getHeldWrite,
  hasDurableHeldWrite,
  PURCHASE_SUBJECT,
  setHeldWritePhase,
  snapshotPostedReloads,
  storageWriteFailedMessage,
  subscribeHeldWritesStore,
  type PostedReloadSnapshot,
} from '@/lib/held-writes';
import {
  isOnline,
  offlineMoneyMessage,
  offlineWriteMessage,
  useReconnectReload,
} from '@/lib/online';
import { isPayloadRefusal, isUnknownOutcome } from '@/lib/write-outcome';
import {
  getPurchaseById,
  listPurchases,
  listStockChoices,
  listUnitsAt,
  recordPurchase,
} from '@/purchases/api';
import {
  divRound,
  formatDec,
  isZero,
  mulRound,
  parseUserDecimal,
} from '@/purchases/decimal';
import {
  ConversionChangedError,
  genericPurchaseError,
} from '@/purchases/errors';
import { PurchaseForm } from '@/purchases/PurchaseForm';
import { PurchaseList } from '@/purchases/PurchaseList';
import type {
  Purchase,
  PurchaseDraft,
  StockChoice,
  StoredPurchaseDraft,
} from '@/purchases/types';
import {
  cairoDateStartIso,
  cairoNextDateStartIso,
  dateRangeError,
} from '@/purchases/time';

const shell =
  'mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 px-4 py-6 text-start';
const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';
const secondaryButton =
  'w-fit rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

type Snapshot = { choices: StockChoice[]; purchases: Purchase[] };

async function verifyPostedPurchases(
  items: PostedReloadSnapshot,
): Promise<void> {
  if (items.length === 0 || typeof getPurchaseById !== 'function') return;
  await Promise.all(
    items.map(async (item) => {
      const id =
        item.readTarget && item.readTarget !== '*'
          ? item.readTarget
          : undefined;
      const verified = await getPurchaseById({
        ...(id ? { id } : {}),
        requestId: item.requestId,
      });
      if (!verified) {
        throw new Error(genericPurchaseError);
      }
    }),
  );
}

/** Persist only retry fields (no itemName, baseQuantity, or unitCost) in localStorage. */
function toStoredPurchaseDraft(draft: PurchaseDraft): StoredPurchaseDraft {
  return {
    requestId: draft.requestId,
    purchasedAt: draft.purchasedAt,
    supplier: draft.supplier,
    invoiceNo: draft.invoiceNo,
    note: draft.note,
    lines: draft.lines.map((line) => ({
      itemId: line.itemId,
      quantity: line.quantity,
      unit: line.unit,
      amountPaid: line.amountPaid,
      baseUnit: line.baseUnit,
      expectedFactor: line.expectedFactor,
    })),
  };
}

/** Restore item labels from live catalog (or in-memory cache) and recompute display math. */
function hydratePurchaseDraft(
  stored: StoredPurchaseDraft | null,
  choices: readonly StockChoice[],
  knownNames: ReadonlyMap<string, string>,
): PurchaseDraft | null {
  if (!stored) return null;
  const byId = new Map<string, string>(knownNames);
  for (const choice of choices) byId.set(choice.id, choice.name);
  return {
    requestId: stored.requestId,
    purchasedAt: stored.purchasedAt,
    supplier: stored.supplier,
    invoiceNo: stored.invoiceNo,
    note: stored.note,
    lines: stored.lines.map((line) => {
      const qty = parseUserDecimal(line.quantity);
      const factor = parseUserDecimal(line.expectedFactor);
      const amount = parseUserDecimal(line.amountPaid);
      const base = qty && factor ? mulRound(qty, factor, 6) : null;
      const baseQuantity = base ? formatDec(base) : line.quantity;
      let unitCost = '0';
      if (amount && !isZero(amount) && base && !isZero(base)) {
        const cost = divRound(amount, base, 6);
        if (cost) unitCost = formatDec(cost);
      }
      return {
        ...line,
        itemName: byId.get(line.itemId) ?? line.itemId,
        baseQuantity,
        unitCost,
      };
    }),
  };
}

export function PurchasesPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
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
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filterError, setFilterError] = useState<string | null>(null);
  // In-memory-only item names for hydrated pending drafts if a choice disappears.
  const [knownNames, setKnownNames] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const seqRef = useRef(0);
  const loadsRef = useRef(0);
  const filterRef = useRef({ from: '', to: '' });

  const online = useReconnectReload(() => {
    if (!saving && loadsRef.current === 0) {
      setLoading(true);
      setLoadError(null);
      setLoadId((value) => value + 1);
    }
  });

  function rememberChoiceNames(
    list: readonly { id: string; name?: string }[],
  ): void {
    setKnownNames((current) => {
      let changed = false;
      const next = new Map(current);
      for (const entry of list) {
        if (entry.name && next.get(entry.id) !== entry.name) {
          next.set(entry.id, entry.name);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }

  useEffect(
    () => subscribeHeldWritesStore(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  const choices = snapshot?.choices ?? [];
  const stored =
    heldEpoch < 0 ? null : getHeldWrite<StoredPurchaseDraft>(PURCHASE_SUBJECT);
  const pending = hydratePurchaseDraft(
    stored?.phase === 'unknown' ? stored.payload : null,
    choices,
    knownNames,
  );
  const inflight = stored?.phase === 'inflight';
  const postedReload =
    heldEpoch >= 0 &&
    snapshotPostedReloads({ subject: PURCHASE_SUBJECT }).length > 0;
  const needsReload = localNeedsReload || postedReload;
  const editingLocked = saving || inflight || needsReload;
  const filterLocked =
    saving || inflight || (needsReload && filterError === null);
  const busy = editingLocked || loads > 0;
  const writeLocked = busy || !online;

  async function readSnapshot(options?: {
    verifyPins?: PostedReloadSnapshot;
  }): Promise<{ choices: StockChoice[]; purchases: Purchase[] | null } | null> {
    const verifyPins = options?.verifyPins ?? [];
    const range = dateRangeError(filterRef.current.from, filterRef.current.to);
    const fromIso =
      !range && filterRef.current.from
        ? cairoDateStartIso(filterRef.current.from)
        : null;
    const toExclusive =
      !range && filterRef.current.to
        ? cairoNextDateStartIso(filterRef.current.to)
        : null;
    const dateError =
      range ??
      ((filterRef.current.from && !fromIso) ||
      (filterRef.current.to && !toExclusive)
        ? 'التاريخ مش مظبوط'
        : null);
    if (dateError) {
      setFilterError(dateError);
      if (verifyPins.length === 0) {
        return null;
      }
      const seq = ++seqRef.current;
      loadsRef.current += 1;
      setLoads(loadsRef.current);
      try {
        const [nextChoices] = await Promise.all([
          listStockChoices(),
          verifyPostedPurchases(verifyPins),
        ]);
        return seq === seqRef.current
          ? { choices: nextChoices, purchases: null }
          : null;
      } catch (error) {
        if (seq !== seqRef.current) return null;
        throw error;
      } finally {
        loadsRef.current -= 1;
        setLoads(loadsRef.current);
      }
    }
    setFilterError(null);
    const seq = ++seqRef.current;
    loadsRef.current += 1;
    setLoads(loadsRef.current);
    try {
      const [nextChoices, purchases] = await Promise.all([
        listStockChoices(),
        listPurchases({
          from: fromIso ?? undefined,
          toExclusive: toExclusive ?? undefined,
        }),
        verifyPostedPurchases(verifyPins),
      ]);
      return seq === seqRef.current
        ? { choices: nextChoices, purchases }
        : null;
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
    const pendingReloads = snapshotPostedReloads({ subject: PURCHASE_SUBJECT });
    void (async () => {
      try {
        const next = await readSnapshot({ verifyPins: pendingReloads });
        if (cancelled || !next) return;
        setSnapshot((current) => ({
          choices: next.choices,
          purchases: next.purchases ?? current?.purchases ?? [],
        }));
        rememberChoiceNames(next.choices);
        setLoadError(null);
        await clearPostedReloadSnapshot(pendingReloads);
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

  async function reloadChoices() {
    const seq = ++seqRef.current;
    loadsRef.current += 1;
    setLoads(loadsRef.current);
    try {
      const nextChoices = await listStockChoices();
      if (seq !== seqRef.current) return;
      rememberChoiceNames(nextChoices);
      setSnapshot((current) =>
        current ? { ...current, choices: nextChoices } : current,
      );
    } catch (error) {
      if (seq !== seqRef.current) return;
      setLoadError(messageFrom(error));
    } finally {
      loadsRef.current -= 1;
      setLoads(loadsRef.current);
    }
  }

  function retry() {
    if (saving || loadsRef.current > 0 || !isOnline()) return;
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  function changeFilter(next: { from: string; to: string }) {
    if (filterLocked) return;
    filterRef.current = next;
    setFrom(next.from);
    setTo(next.to);
    const range = dateRangeError(next.from, next.to);
    setFilterError(range);
    if (range) {
      // Drop a read that started for the previous range.
      seqRef.current += 1;
      return;
    }
    setLoadId((value) => value + 1);
  }

  async function handleSubmit(draft: PurchaseDraft) {
    if (busy || loadsRef.current > 0 || !isOnline()) return;
    const session = captureWriteSession();
    const prior = getHeldWrite<StoredPurchaseDraft>(PURCHASE_SUBJECT);
    const wasPinned =
      prior !== null &&
      prior.requestId === draft.requestId &&
      prior.phase === 'unknown';
    rememberChoiceNames(
      draft.lines.map((line) => ({ id: line.itemId, name: line.itemName })),
    );
    const storedDraft = toStoredPurchaseDraft(draft);
    const claim = wasPinned
      ? await claimReplayHeldWrite<StoredPurchaseDraft>(
          PURCHASE_SUBJECT,
          draft.requestId,
          { session },
        )
      : await claimFreshHeldWrite<StoredPurchaseDraft>(
          PURCHASE_SUBJECT,
          () => storedDraft,
          { requestId: draft.requestId, kind: 'purchase', session },
        );
    if (!claim.ok) {
      if (claim.reason === 'storage' || claim.reason === 'missing') {
        setServerError(storageWriteFailedMessage);
      } else if (claim.reason === 'session_invalid' && !isOnline()) {
        setServerError(offlineWriteMessage);
      }
      return;
    }
    if (!canDispatchHeldWrite(PURCHASE_SUBJECT, draft.requestId, session)) {
      const durable = hasDurableHeldWrite(PURCHASE_SUBJECT, draft.requestId);
      abortClaimBeforeDispatch(
        PURCHASE_SUBJECT,
        draft.requestId,
        wasPinned ? 'unknown' : null,
        claim.release,
      );
      if (!durable) setServerError(storageWriteFailedMessage);
      else if (!isOnline()) setServerError(offlineWriteMessage);
      return;
    }
    setSaving(true);
    setServerError(null);
    setSuccess(null);
    let saved = false;
    const hydratedDraft =
      hydratePurchaseDraft(claim.record.payload, choices, knownNames) ?? draft;
    try {
      const savedPurchaseId = await recordPurchase(hydratedDraft);
      saved = true;
      setHeldWritePhase(
        PURCHASE_SUBJECT,
        draft.requestId,
        'posted_reload',
        savedPurchaseId ? { readTarget: savedPurchaseId } : undefined,
      );
      setLocalNeedsReload(true);
      setFormEpoch((value) => value + 1);
      setSuccess('اتسجلت المشتريات');
      const verifyPins: PostedReloadSnapshot = [
        {
          subject: PURCHASE_SUBJECT,
          requestId: draft.requestId,
          ...(savedPurchaseId ? { readTarget: savedPurchaseId } : {}),
        },
      ];
      const next = await readSnapshot({ verifyPins });
      if (next) {
        setSnapshot((current) => ({
          choices: next.choices,
          purchases: next.purchases ?? current?.purchases ?? [],
        }));
        rememberChoiceNames(next.choices);
        setLoadError(null);
        await clearPostedReload(
          PURCHASE_SUBJECT,
          savedPurchaseId,
          draft.requestId,
        );
        setLocalNeedsReload(false);
      }
    } catch (error) {
      if (!saved) {
        setServerError(messageFrom(error));
        if (error instanceof ConversionChangedError) {
          clearHeldWrite(PURCHASE_SUBJECT, draft.requestId);
          // Same items and timestamp. The nonce is what makes the dated
          // lookup run again; remounting the form would drop the draft.
          setUnitsNonce((value) => value + 1);
          await reloadChoices();
        } else if (wasPinned) {
          if (isPayloadRefusal(error)) {
            clearHeldWrite(PURCHASE_SUBJECT, draft.requestId);
          } else {
            setHeldWritePhase(PURCHASE_SUBJECT, draft.requestId, 'unknown');
          }
        } else if (isUnknownOutcome(error)) {
          setHeldWritePhase(PURCHASE_SUBJECT, draft.requestId, 'unknown');
        } else {
          clearHeldWrite(PURCHASE_SUBJECT, draft.requestId);
        }
      } else {
        setLocalNeedsReload(true);
        setLoadError(messageFrom(error));
      }
    } finally {
      claim.release();
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
      <h1 className="text-2xl font-semibold">المشتريات</h1>
      {!online ? (
        <>
          <p role="status">{offlineWriteMessage}</p>
          <p role="status">{offlineMoneyMessage}</p>
        </>
      ) : null}
      {success ? <p role="status">{success}</p> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          من
          <input
            className={fieldClass}
            type="date"
            disabled={filterLocked}
            value={from}
            onChange={(event) =>
              changeFilter({
                from: event.target.value,
                to: filterRef.current.to,
              })
            }
          />
        </label>
        <label className="flex flex-col gap-1">
          إلى
          <input
            className={fieldClass}
            type="date"
            disabled={filterLocked}
            value={to}
            onChange={(event) =>
              changeFilter({
                from: filterRef.current.from,
                to: event.target.value,
              })
            }
          />
        </label>
      </div>
      {filterError ? <p role="alert">{filterError}</p> : null}
      {online && loading && snapshot === null ? (
        <p>جاري تحميل المشتريات…</p>
      ) : null}
      {snapshot === null && !loading ? (
        <div className="flex flex-col gap-3">
          <p role="alert">{loadError ?? genericPurchaseError}</p>
          <button
            className={secondaryButton}
            type="button"
            disabled={saving || loads > 0 || !online}
            onClick={retry}
          >
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {snapshot !== null &&
      (loadError || (postedReload && !saving && loads === 0)) ? (
        <div className="flex flex-col gap-2">
          {loadError ? (
            <p role="alert">{loadError}</p>
          ) : (
            <p role="status">في حفظ اتسجل ومحتاج تحديث قبل ما تكمل</p>
          )}
          <button
            className={secondaryButton}
            type="button"
            disabled={saving || loads > 0 || !online}
            onClick={retry}
          >
            {loadError ? 'إعادة المحاولة' : 'تحقق تاني'}
          </button>
        </div>
      ) : null}
      {snapshot !== null ? (
        <>
          {choices.length === 0 && pending === null ? (
            <p>لسه مفيش أصناف — ضيف صنف الأول</p>
          ) : (
            <PurchaseForm
              key={formEpoch}
              items={choices}
              locked={writeLocked}
              submitting={saving}
              serverError={serverError}
              pending={pending}
              onClearServerError={() => setServerError(null)}
              onSubmit={(next) => void handleSubmit(next)}
              resolveUnits={listUnitsAt}
              reloadKey={unitsNonce}
            />
          )}
          {online ? <PurchaseList purchases={snapshot.purchases} /> : null}
        </>
      ) : null}
    </main>
  );
}
