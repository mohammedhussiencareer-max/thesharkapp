import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CountForm } from '@/counts/CountForm';
import { CountList } from '@/counts/CountList';
import { PendingCounts, type PendingCountEntry } from '@/counts/PendingCounts';
import {
  listCounts,
  listDailyItems,
  listPendingCounts,
  recordCount,
  recordStoredCount,
} from '@/counts/api';
import {
  genericCountError,
  isPayloadRefusal,
  isUnknownOutcome,
  mapCountError,
  retrySafeMessage,
  waitingForSyncMessage,
} from '@/counts/errors';
import type {
  CountDraft,
  CountItem,
  CountRecord,
  CountWriteResult,
  PendingCount,
} from '@/counts/types';
import { messageFrom } from '@/items/errors';
import type { Json } from '@/lib/database.types';
import {
  abortClaimBeforeDispatch,
  acquireHeldWriteLock,
  canDispatchHeldWrite,
  canDispatchWriteFor,
  captureWriteSession,
  claimFreshHeldWrite,
  claimReplayHeldWrite,
  clearHeldWrite,
  clearPostedReloadSnapshot,
  getHeldWrite,
  hasDurableHeldWrite,
  listHeldWritesByPrefix,
  readLockedHeldWrite,
  setHeldWritePhase,
  snapshotPostedReloads,
  storageWriteFailedMessage,
  subscribeHeldWritesStore,
  type HeldWriteRecord,
  type PostedReloadSnapshot,
  type WriteSession,
} from '@/lib/held-writes';
import {
  isOnline,
  offlineMoneyMessage,
  offlineWriteMessage,
  useReconnectReload,
} from '@/lib/online';
import { pageShell, secondaryButton } from '@/lib/page-style';

const COUNT_DAILY_SUBJECT = 'count:daily';
const COUNT_STORED_PREFIX = 'count:stored:';

type Snapshot = {
  items: CountItem[];
  counts: CountRecord[];
  pendingCounts: PendingCount[];
};

type ReadResult = { status: 'ready'; snapshot: Snapshot } | { status: 'stale' };

function requestIdOf(payload: Json): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const requestId = (payload as { request_id?: unknown }).request_id;
  return typeof requestId === 'string' ? requestId : null;
}

/** Strip display-only fields before persisting a count draft to localStorage. */
function toStoredCountDraft(draft: CountDraft): CountDraft {
  return {
    requestId: draft.requestId,
    countedAt: draft.countedAt,
    note: draft.note,
    lines: draft.lines.map((line) => ({
      itemId: line.itemId,
      countedQty: line.countedQty,
      expectedBaseUnit: line.expectedBaseUnit,
    })),
  };
}

/** Re-attach live or session-cached display names for UI rendering without storing them in localStorage. */
function hydrateCountDraft(
  draft: CountDraft | null,
  items: readonly CountItem[],
  knownNames: ReadonlyMap<string, string>,
): CountDraft | null {
  if (!draft) return null;
  const byId = new Map<string, string>(knownNames);
  for (const item of items) byId.set(item.id, item.name);
  if (byId.size === 0) return draft;
  return {
    ...draft,
    lines: draft.lines.map((line) => {
      const liveName = byId.get(line.itemId);
      return liveName ? { ...line, itemName: liveName } : line;
    }),
  };
}

function storedPinToPendingEntry(
  requestId: string,
  payload: Json,
): PendingCountEntry {
  const obj =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { counted_at?: unknown; lines?: unknown })
      : {};
  const countedAt = typeof obj.counted_at === 'string' ? obj.counted_at : '';
  const itemCount = Array.isArray(obj.lines) ? obj.lines.length : 0;
  return {
    requestId,
    preparedAt: countedAt,
    countedAt,
    itemCount,
    payload,
    unknown: true,
  };
}

function snapshotCountPostedReloads(): PostedReloadSnapshot {
  return [
    ...snapshotPostedReloads({ subject: COUNT_DAILY_SUBJECT }),
    ...snapshotPostedReloads({ prefix: COUNT_STORED_PREFIX }),
  ];
}

export function CountsPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const [saving, setSaving] = useState(false);
  const [localNeedsReload, setLocalNeedsReload] = useState(false);
  const [loads, setLoads] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [heldEpoch, setHeldEpoch] = useState(0);
  // The request id whose waiting_for_sync reply is shown, so its own
  // later success clears it even when no local draft matches (a card).
  const [waitNotice, setWaitNotice] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const [requestKey, setRequestKey] = useState(0);
  // In-memory-only item names so a refresh that removes an item still displays
  // its name on a pinned count; never written to localStorage.
  const [knownNames, setKnownNames] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const seqRef = useRef(0);
  const loadsRef = useRef(0);

  const online = useReconnectReload(() => {
    if (!saving && loadsRef.current === 0) {
      setLoading(true);
      setLoadError(null);
      setLoadId((value) => value + 1);
    }
  });

  function rememberItemNames(
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

  const items = snapshot?.items ?? [];
  const storedDaily =
    heldEpoch < 0 ? null : getHeldWrite<CountDraft>(COUNT_DAILY_SUBJECT);
  const pending = hydrateCountDraft(
    storedDaily?.phase === 'unknown' ? storedDaily.payload : null,
    items,
    knownNames,
  );
  const waiting = hydrateCountDraft(
    storedDaily?.phase === 'waiting_for_sync' ? storedDaily.payload : null,
    items,
    knownNames,
  );
  const inflightDaily = storedDaily?.phase === 'inflight';
  const storedCountPins =
    heldEpoch < 0 ? [] : listHeldWritesByPrefix<Json>(COUNT_STORED_PREFIX);
  const postedReload =
    heldEpoch >= 0 &&
    (storedDaily?.phase === 'posted_reload' ||
      storedCountPins.some((record) => record.phase === 'posted_reload'));

  const needsReload = localNeedsReload || postedReload;
  const editingLocked = saving || inflightDaily || needsReload;
  const busy = editingLocked || loads > 0;
  const writeLocked = busy || !online;

  async function readSnapshot(): Promise<ReadResult> {
    const seq = ++seqRef.current;
    loadsRef.current += 1;
    setLoads(loadsRef.current);
    try {
      const [items, counts, pendingCounts] = await Promise.all([
        listDailyItems(),
        listCounts(),
        listPendingCounts(),
      ]);
      return seq === seqRef.current
        ? { status: 'ready', snapshot: { items, counts, pendingCounts } }
        : { status: 'stale' };
    } catch (error) {
      if (seq !== seqRef.current) return { status: 'stale' };
      throw error;
    } finally {
      loadsRef.current -= 1;
      setLoads(loadsRef.current);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const pendingReloads = snapshotCountPostedReloads();
    void (async () => {
      try {
        const next = await readSnapshot();
        if (cancelled || next.status === 'stale') return;
        setSnapshot(next.snapshot);
        rememberItemNames(next.snapshot.items);
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

  function refresh() {
    if (saving || needsReload) return;
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  function retry() {
    if (saving || loadsRef.current > 0) return;
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  function reportedCountError(error: unknown): string {
    if (error instanceof Error && error.message.trim() !== '') {
      return error.message;
    }
    if (isUnknownOutcome(error)) return retrySafeMessage;
    return mapCountError(error);
  }

  async function refreshAfterWait(): Promise<void> {
    try {
      const next = await readSnapshot();
      if (next.status === 'ready') {
        setSnapshot(next.snapshot);
        setLoadError(null);
      }
    } catch (error) {
      setLoadError(messageFrom(error));
    }
  }

  function applyPosted(
    requestId: string | null,
    fromForm: boolean,
    storedSubject: string | null,
    daily: HeldWriteRecord<CountDraft> | null,
  ): void {
    const matchesDaily = requestId !== null && daily?.requestId === requestId;
    if (fromForm || matchesDaily) {
      if (daily && requestId !== null && daily.requestId === requestId) {
        setHeldWritePhase(COUNT_DAILY_SUBJECT, requestId, 'posted_reload', {
          expected: daily,
        });
      }
      setFormEpoch((value) => value + 1);
    }
    if (storedSubject && requestId !== null) {
      setHeldWritePhase(storedSubject, requestId, 'posted_reload');
    }
    setWaitNotice((current) =>
      current !== null && current === requestId ? null : current,
    );
    // Stays set until the reload applies data, or a visible retryable error
    // replaces it. A stale read clears the local lock while posted_reload waits
    // for a successful read.
    setLocalNeedsReload(true);
    setSuccess('اتسجل الجرد');
  }

  function holdUnknown(
    draft: CountDraft,
    error: unknown,
    priorPhase: 'unknown' | 'waiting_for_sync' | null,
  ): void {
    setServerError(reportedCountError(error));
    // A pin stays until this exact payload succeeds or the same replay
    // is refused by a rule the payload itself breaks. A permission or
    // contention error can fire before the server's request_id replay,
    // so it leaves the existing pin in place and does not start a new one.
    if (isPayloadRefusal(error)) {
      const replay = priorPhase !== null;
      setWaitNotice(null);
      clearHeldWrite(COUNT_DAILY_SUBJECT, draft.requestId);
      if (replay) setRequestKey((value) => value + 1);
      return;
    }
    if (isUnknownOutcome(error)) {
      // A lost reply may have posted. The next حفظ resends this payload,
      // including when the lost call was the waiting resend.
      setWaitNotice(null);
      setHeldWritePhase(COUNT_DAILY_SUBJECT, draft.requestId, 'unknown');
      return;
    }
    if (priorPhase !== null) {
      setHeldWritePhase(COUNT_DAILY_SUBJECT, draft.requestId, priorPhase);
      return;
    }
    // Definite non-payload refusal on a first submit stored nothing.
    clearHeldWrite(COUNT_DAILY_SUBJECT, draft.requestId);
  }

  async function finishWrite(
    result: CountWriteResult,
    draft: CountDraft | null,
    requestId: string | null,
    storedSubject: string | null,
    daily: HeldWriteRecord<CountDraft> | null,
    release: () => void,
  ): Promise<boolean> {
    if (result.status === 'waiting_for_sync') {
      if (daily && requestId === daily.requestId) {
        setHeldWritePhase(COUNT_DAILY_SUBJECT, requestId, 'waiting_for_sync', {
          expected: daily,
        });
      }
      if (storedSubject && requestId) {
        clearHeldWrite(storedSubject, requestId);
      }
      setWaitNotice(requestId ?? draft?.requestId ?? null);
      setSuccess(null);
      release();
      await refreshAfterWait();
      return false;
    }
    applyPosted(requestId, draft !== null, storedSubject, daily);
    // The readback may cover pins owned by other count writers.
    release();
    const pendingReloads = snapshotCountPostedReloads();
    const next = await readSnapshot();
    if (next.status === 'ready') {
      setSnapshot(next.snapshot);
      setLoadError(null);
      await clearPostedReloadSnapshot(pendingReloads);
      setLocalNeedsReload(false);
    } else {
      setLocalNeedsReload(false);
    }
    return true;
  }

  async function handleSubmit(draft: CountDraft) {
    if (busy || loadsRef.current > 0 || !isOnline()) return;
    const session = captureWriteSession();
    const prior = getHeldWrite<CountDraft>(COUNT_DAILY_SUBJECT);
    const priorPhase =
      prior !== null &&
      prior.requestId === draft.requestId &&
      (prior.phase === 'unknown' || prior.phase === 'waiting_for_sync')
        ? prior.phase
        : null;
    rememberItemNames(
      draft.lines.map((line) => ({ id: line.itemId, name: line.itemName })),
    );
    // Persist BEFORE sending (without display-only fields) so a reload during
    // transmission restores `unknown`. Refuse to send if storage fails.
    const storedDraft = toStoredCountDraft(draft);
    const claim =
      priorPhase !== null
        ? await claimReplayHeldWrite<CountDraft>(
            COUNT_DAILY_SUBJECT,
            draft.requestId,
            { session },
          )
        : await claimFreshHeldWrite<CountDraft>(
            COUNT_DAILY_SUBJECT,
            () => storedDraft,
            { requestId: draft.requestId, kind: 'count', session },
          );
    if (!claim.ok) {
      if (claim.reason === 'storage' || claim.reason === 'missing') {
        setServerError(storageWriteFailedMessage);
      } else if (claim.reason === 'session_invalid' && !isOnline()) {
        setServerError(offlineWriteMessage);
      }
      return;
    }
    if (!canDispatchHeldWrite(COUNT_DAILY_SUBJECT, draft.requestId, session)) {
      const durable = hasDurableHeldWrite(COUNT_DAILY_SUBJECT, draft.requestId);
      abortClaimBeforeDispatch(
        COUNT_DAILY_SUBJECT,
        draft.requestId,
        priorPhase,
        claim.release,
      );
      if (!durable) setServerError(storageWriteFailedMessage);
      else if (!isOnline()) setServerError(offlineWriteMessage);
      return;
    }
    setSaving(true);
    setServerError(null);
    setCardError(null);
    setSuccess(null);
    let saved = false;
    try {
      const result = await recordCount(draft);
      if (result.status === 'posted') saved = true;
      await finishWrite(
        result,
        draft,
        draft.requestId,
        null,
        claim.record,
        claim.release,
      );
    } catch (error) {
      if (!saved) {
        holdUnknown(draft, error, priorPhase);
      } else {
        setLocalNeedsReload(true);
        setLoadError(messageFrom(error));
      }
    } finally {
      claim.release();
      setSaving(false);
    }
  }

  async function handleStored(payload: Json) {
    if (busy || loadsRef.current > 0 || !isOnline()) return;
    const requestId = requestIdOf(payload);
    const session = captureWriteSession();
    if (requestId === null) {
      await replayStored(payload, requestId, null, session);
      return;
    }
    // Take the daily lock first, then the stored-card lock. A server card
    // can represent the same request as a daily write in another tab.
    const dailyLock = await acquireHeldWriteLock(COUNT_DAILY_SUBJECT);
    if (!dailyLock.acquired) return;
    try {
      if (!canDispatchWriteFor(session)) return;
      const daily = readLockedHeldWrite<CountDraft>(COUNT_DAILY_SUBJECT);
      await replayStored(
        payload,
        requestId,
        daily?.requestId === requestId && daily.phase !== 'posted_reload'
          ? daily
          : null,
        session,
        dailyLock.release,
      );
    } catch (error) {
      setCardError(messageFrom(error));
    } finally {
      dailyLock.release();
    }
  }

  async function replayStored(
    payload: Json,
    requestId: string | null,
    daily: HeldWriteRecord<CountDraft> | null,
    session: WriteSession | null,
    releaseDailyLock: () => void = () => {},
  ) {
    const storedSubject =
      requestId !== null ? `${COUNT_STORED_PREFIX}${requestId}` : null;
    let releaseLock = () => {};
    let isLocalReplay = false;
    if (storedSubject && requestId !== null) {
      const prior = getHeldWrite<Json>(storedSubject);
      isLocalReplay =
        prior !== null &&
        prior.requestId === requestId &&
        prior.phase === 'unknown';
      const claim = isLocalReplay
        ? await claimReplayHeldWrite<Json>(storedSubject, requestId, {
            session,
          })
        : await claimFreshHeldWrite<Json>(storedSubject, () => payload, {
            requestId,
            kind: 'count_stored',
            session,
          });
      if (!claim.ok) {
        if (claim.reason === 'storage' || claim.reason === 'missing') {
          setCardError(storageWriteFailedMessage);
        } else if (claim.reason === 'session_invalid' && !isOnline()) {
          setCardError(offlineWriteMessage);
        }
        return;
      }
      releaseLock = claim.release;
    }
    const canDispatch =
      storedSubject && requestId !== null
        ? canDispatchHeldWrite(storedSubject, requestId, session)
        : canDispatchWriteFor(session);
    if (!canDispatch) {
      const durable =
        storedSubject && requestId !== null
          ? hasDurableHeldWrite(storedSubject, requestId)
          : true;
      if (storedSubject && requestId !== null) {
        abortClaimBeforeDispatch(
          storedSubject,
          requestId,
          isLocalReplay ? 'unknown' : null,
          releaseLock,
        );
      } else {
        releaseLock();
      }
      if (!durable) setCardError(storageWriteFailedMessage);
      else if (!isOnline()) setCardError(offlineWriteMessage);
      return;
    }
    setSaving(true);
    setServerError(null);
    setCardError(null);
    setSuccess(null);
    let saved = false;
    try {
      const result = await recordStoredCount(payload);
      if (result.status === 'posted') saved = true;
      await finishWrite(result, null, requestId, storedSubject, daily, () => {
        releaseLock();
        releaseDailyLock();
      });
    } catch (error) {
      if (!saved) {
        setCardError(reportedCountError(error));
        if (requestId && !isUnknownOutcome(error)) {
          setWaitNotice((current) => (current === requestId ? null : current));
        }
        if (storedSubject && requestId) {
          if (isUnknownOutcome(error)) {
            setHeldWritePhase(storedSubject, requestId, 'unknown');
          } else {
            clearHeldWrite(storedSubject, requestId);
          }
        }
        if (
          requestId &&
          daily &&
          daily.requestId === requestId &&
          (daily.phase === 'unknown' || daily.phase === 'waiting_for_sync') &&
          isPayloadRefusal(error)
        ) {
          setRequestKey((value) => value + 1);
          clearHeldWrite(COUNT_DAILY_SUBJECT, requestId, daily);
          setWaitNotice(null);
        }
      } else {
        setLocalNeedsReload(true);
        setLoadError(messageFrom(error));
      }
    } finally {
      releaseLock();
      setSaving(false);
    }
  }

  const localUnknownStored = new Map<string, Json>();
  for (const record of storedCountPins) {
    if (record.phase === 'unknown' && record.payload !== null) {
      localUnknownStored.set(record.requestId, record.payload);
    }
  }

  const serverPendingIds = new Set<string>();
  const visiblePendingCounts: PendingCountEntry[] = [];
  for (const row of snapshot?.pendingCounts ?? []) {
    if (row.requestId === waiting?.requestId) continue;
    serverPendingIds.add(row.requestId);
    const localPayload = localUnknownStored.get(row.requestId);
    visiblePendingCounts.push(
      localPayload !== undefined
        ? { ...row, payload: localPayload, unknown: true }
        : row,
    );
  }
  for (const [requestId, payload] of localUnknownStored.entries()) {
    if (
      serverPendingIds.has(requestId) ||
      requestId === waiting?.requestId ||
      requestId === pending?.requestId
    ) {
      continue;
    }
    visiblePendingCounts.push(storedPinToPendingEntry(requestId, payload));
  }

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">الجرد اليومي</h1>
      {!online ? (
        <>
          <p role="status">{offlineWriteMessage}</p>
          <p role="status">{offlineMoneyMessage}</p>
        </>
      ) : null}
      {waiting || waitNotice !== null ? (
        <p role="status">{waitingForSyncMessage}</p>
      ) : null}
      {success ? <p role="status">{success}</p> : null}
      <button
        className={secondaryButton}
        type="button"
        disabled={saving || needsReload}
        onClick={refresh}
      >
        تحديث
      </button>
      {loading && snapshot === null ? <p>جاري تحميل الجرد…</p> : null}
      {snapshot === null && !loading ? (
        <div className="flex flex-col gap-3">
          <p role="alert">{loadError ?? genericCountError}</p>
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
      {snapshot !== null && loadError ? (
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
      {snapshot !== null ? (
        <>
          {items.length === 0 && pending === null && waiting === null ? (
            <p>مفيش أصناف جرد يومي نشطة</p>
          ) : (
            <CountForm
              key={formEpoch}
              items={items}
              locked={writeLocked}
              submitting={saving}
              serverError={serverError}
              pending={pending}
              waiting={waiting}
              requestKey={requestKey}
              hideMoney={!online}
              onClearServerError={() => setServerError(null)}
              onSubmit={(next) => void handleSubmit(next)}
            />
          )}
          {cardError ? <p role="alert">{cardError}</p> : null}
          <PendingCounts
            counts={visiblePendingCounts}
            disabled={writeLocked}
            onResend={(payload) => void handleStored(payload)}
          />
          {online ? (
            <CountList counts={snapshot.counts} refreshKey={loadId} />
          ) : null}
        </>
      ) : null}
    </main>
  );
}
