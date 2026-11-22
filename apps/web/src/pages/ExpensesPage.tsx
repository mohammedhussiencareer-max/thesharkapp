import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AllocationTable } from '@/expenses/AllocationTable';
import {
  addExpenseCategory,
  addExpenseEntry,
  loadExpenseMonth,
  renameExpenseCategory,
  setExpenseCategoryActive,
  setMonthExpenseComplete,
  voidExpenseEntry,
} from '@/expenses/api';
import { CategoryManager } from '@/expenses/CategoryManager';
import { ExpenseForm } from '@/expenses/ExpenseForm';
import { ExpenseList } from '@/expenses/ExpenseList';
import {
  isPayloadRefusal,
  isUnknownOutcome,
  mapExpenseError,
  retrySafeMessage,
} from '@/expenses/errors';
import type {
  ExpenseDraft,
  ExpenseKind,
  ExpenseLine,
  ExpenseMonth,
} from '@/expenses/types';
import { fieldClass } from '@/expenses/labels';
import { messageFrom } from '@/items/errors';
import { cairoMonthInput, formatCairo, formatMonth } from '@/lib/cairo';
import {
  canDispatchWriteFor,
  captureWriteSession,
  claimFreshHeldWrite,
  claimReplayHeldWrite,
  clearHeldWrite,
  clearPostedReloadSnapshot,
  getHeldWrite,
  getReloadMarker,
  hasReloadMarker,
  listHeldWritesByPrefix,
  setHeldWritePhase,
  setReloadMarker,
  snapshotPostedReloads,
  storageWriteFailedMessage,
  subscribeHeldWritesStore,
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

const EXPENSE_NEW_SUBJECT = 'expense:new';
const EXPENSE_VOID_PREFIX = 'expense:void:';
const EXPENSE_RELOAD_SUBJECT = 'expense:reload';

/** Stored in localStorage for void retries: request id, reason, and target month (no cached money). */
type StoredVoidPayload = {
  id: string;
  requestId: string;
  reason: string;
  targetMonth?: string;
};

type VoidAttempt = {
  id: string;
  requestId: string;
  reason: string;
  /** The row as it was when the void was sent (in-memory only). */
  entry: ExpenseLine | null;
};

function voidSubject(id: string): string {
  return `${EXPENSE_VOID_PREFIX}${id}`;
}

function expenseTargetMonth(
  draft: ExpenseDraft,
  fallbackMonth: string,
): string {
  if (draft.periodMonth) return draft.periodMonth;
  if (draft.expenseDate && draft.expenseDate.length >= 7) {
    return `${draft.expenseDate.slice(0, 7)}-01`;
  }
  return `${fallbackMonth}-01`;
}

function voidTargetMonth(
  entry: ExpenseLine | null,
  fallbackMonth: string,
): string {
  if (entry?.periodMonth) return entry.periodMonth;
  if (entry?.expenseDate && entry.expenseDate.length >= 7) {
    return `${entry.expenseDate.slice(0, 7)}-01`;
  }
  return `${fallbackMonth}-01`;
}

function snapshotExpensePostedReloads(): PostedReloadSnapshot {
  return [
    ...snapshotPostedReloads({ subject: EXPENSE_NEW_SUBJECT }),
    ...snapshotPostedReloads({ subject: EXPENSE_RELOAD_SUBJECT }),
    ...snapshotPostedReloads({ prefix: EXPENSE_VOID_PREFIX }),
  ];
}

/**
 * Pinned void targets stay on screen with the snapshotted row, including when
 * the month picker has loaded a different list. Rows for the selected month
 * follow that list.
 */
function entriesWithPinnedVoids(
  entries: readonly ExpenseLine[],
  pins: ReadonlyMap<string, VoidAttempt>,
): ExpenseLine[] {
  const pinned = [...pins.values()].flatMap((pin) =>
    pin.entry ? [pin.entry] : [],
  );
  const pinnedIds = new Set(pinned.map((line) => line.id));
  return [...pinned, ...entries.filter((line) => !pinnedIds.has(line.id))];
}

type WriteResult = {
  saved: boolean;
  /** Null when the write was stored or was not sent. */
  error: unknown;
};

function reportedExpenseError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  if (isUnknownOutcome(error)) return retrySafeMessage;
  return mapExpenseError(error);
}

export function ExpensesPage() {
  const initialMonth = cairoMonthInput();
  const [month, setMonth] = useState(initialMonth);
  const monthRef = useRef(initialMonth);
  const [data, setData] = useState<ExpenseMonth | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [localNeedsReload, setLocalNeedsReload] = useState(false);
  const [readLoads, setReadLoads] = useState(0);
  const [loadId, setLoadId] = useState(0);
  const [formEpoch, setFormEpoch] = useState(0);
  const [heldEpoch, setHeldEpoch] = useState(0);
  // In-memory snapshots of voided rows while switching months (never written to localStorage).
  const [voidSnapshots, setVoidSnapshots] = useState<
    ReadonlyMap<string, ExpenseLine>
  >(() => new Map());
  // Ids of voids that were sent and refused. A refusal is not stored, so a
  // correction reuses the id. Cleared once that void succeeds.
  const voidRequestIdsRef = useRef(new Map<string, string>());
  const seqRef = useRef(0);
  const readsRef = useRef(0);
  const savingRef = useRef(false);
  const needsReloadRef = useRef(false);

  const online = useReconnectReload(() => {
    if (!savingRef.current && readsRef.current === 0) {
      setLoadError(null);
      setLoadId((value) => value + 1);
    }
  });

  useEffect(
    () => subscribeHeldWritesStore(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  function reconcileCommittedVoids(entries: readonly ExpenseLine[]): void {
    const voidedIds = new Set(
      entries.filter((line) => line.voided).map((line) => line.id),
    );
    if (voidedIds.size === 0) return;
    const clearedIds: string[] = [];
    for (const record of listHeldWritesByPrefix<StoredVoidPayload>(
      EXPENSE_VOID_PREFIX,
    )) {
      if (record.phase !== 'unknown' || !record.payload) continue;
      if (voidedIds.has(record.payload.id)) {
        clearHeldWrite(record.subject, record.requestId);
        voidRequestIdsRef.current.delete(record.payload.id);
        clearedIds.push(record.payload.id);
      }
    }
    if (clearedIds.length > 0) {
      setVoidSnapshots((current) => {
        let changed = false;
        const next = new Map(current);
        for (const id of clearedIds) {
          if (next.delete(id)) changed = true;
        }
        return changed ? next : current;
      });
    }
  }

  const storedExpense =
    heldEpoch < 0 ? null : getHeldWrite<ExpenseDraft>(EXPENSE_NEW_SUBJECT);
  const pendingExpense =
    storedExpense?.phase === 'unknown' ? storedExpense.payload : null;
  const inflightExpense = storedExpense?.phase === 'inflight';
  const storedVoids =
    heldEpoch < 0
      ? []
      : listHeldWritesByPrefix<StoredVoidPayload>(EXPENSE_VOID_PREFIX);
  const pendingVoids = new Map<string, VoidAttempt>();
  for (const record of storedVoids) {
    if (record.phase !== 'unknown' || !record.payload) continue;
    const { id, requestId, reason } = record.payload;
    pendingVoids.set(id, {
      id,
      requestId,
      reason,
      entry: voidSnapshots.get(id) ?? null,
    });
  }
  const inflightVoid = storedVoids.some(
    (record) => record.phase === 'inflight',
  );
  const reloadMarker =
    heldEpoch < 0 ? null : getReloadMarker(EXPENSE_RELOAD_SUBJECT);
  const postedReload =
    heldEpoch >= 0 &&
    (storedExpense?.phase === 'posted_reload' ||
      hasReloadMarker(EXPENSE_RELOAD_SUBJECT) ||
      storedVoids.some((record) => record.phase === 'posted_reload'));

  const monthStart = `${month}-01`;
  const postedReloadForCurrentMonth =
    heldEpoch >= 0 &&
    ((storedExpense?.phase === 'posted_reload' &&
      (!storedExpense.readTarget ||
        storedExpense.readTarget === '*' ||
        storedExpense.readTarget === monthStart)) ||
      (reloadMarker !== null &&
        (!reloadMarker.target ||
          reloadMarker.target === '*' ||
          reloadMarker.target === monthStart)) ||
      storedVoids.some(
        (record) =>
          record.phase === 'posted_reload' &&
          (!record.readTarget ||
            record.readTarget === '*' ||
            record.readTarget === monthStart),
      ));

  const needsReload = localNeedsReload || postedReload;
  const ready = data !== null && data.monthStart === monthStart;
  const writeLocked = saving || inflightExpense || inflightVoid || needsReload;
  const monthPickerDisabled =
    saving ||
    inflightExpense ||
    inflightVoid ||
    localNeedsReload ||
    postedReloadForCurrentMonth;
  const busy = writeLocked || readLoads > 0;
  const writeDisabled = busy || !online;

  const visibleEntries =
    ready && data ? entriesWithPinnedVoids(data.entries, pendingVoids) : [];
  const detachedVoids = [...pendingVoids.values()].filter(
    (pin) =>
      !online ||
      !visibleEntries.some((line) => line.id === pin.id && !line.voided),
  );

  async function readMonth(monthValue: string): Promise<ExpenseMonth | null> {
    const seq = ++seqRef.current;
    readsRef.current += 1;
    setReadLoads(readsRef.current);
    try {
      const next = await loadExpenseMonth(`${monthValue}-01`);
      return seq === seqRef.current ? next : null;
    } catch (error) {
      if (seq !== seqRef.current) return null;
      throw error;
    } finally {
      readsRef.current -= 1;
      setReadLoads(readsRef.current);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const pendingReloads = snapshotExpensePostedReloads();
    void (async () => {
      try {
        const next = await readMonth(month);
        if (cancelled || !next) return;
        setData(next);
        setLoadError(null);
        reconcileCommittedVoids(next.entries);
        clearPostedReloadSnapshot(pendingReloads, next.monthStart);
        needsReloadRef.current = false;
        setLocalNeedsReload(false);
      } catch (error) {
        if (cancelled) return;
        setLoadError(messageFrom(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [month, loadId]);

  function retry() {
    if (savingRef.current || readsRef.current > 0 || !isOnline()) return;
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  function changeMonth(next: string) {
    if (
      savingRef.current ||
      needsReloadRef.current ||
      postedReloadForCurrentMonth
    )
      return;
    if (!/^\d{4}-\d{2}$/.test(next) || next === monthRef.current) return;
    monthRef.current = next;
    setLoadError(null);
    setMonth(next);
  }

  async function runWrite(
    action: () => Promise<void>,
    setError: (message: string | null) => void,
    onSaved?: () => void,
    session?: WriteSession | null,
  ): Promise<WriteResult> {
    if (
      savingRef.current ||
      needsReloadRef.current ||
      postedReload ||
      readsRef.current > 0 ||
      !isOnline()
    ) {
      return { saved: false, error: null };
    }
    const activeSession = session ?? captureWriteSession();
    if (!canDispatchWriteFor(activeSession)) {
      if (!isOnline()) setError(offlineWriteMessage);
      return { saved: false, error: null };
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    let saved = false;
    let failure: unknown = null;
    try {
      await action();
      saved = true;
      needsReloadRef.current = true;
      setLocalNeedsReload(true);
      try {
        onSaved?.();
        const pendingReloads = snapshotExpensePostedReloads();
        const next = await readMonth(monthRef.current);
        if (next) {
          setData(next);
          setLoadError(null);
          reconcileCommittedVoids(next.entries);
          clearPostedReloadSnapshot(pendingReloads, next.monthStart);
          needsReloadRef.current = false;
          setLocalNeedsReload(false);
        }
      } catch (error) {
        // The write is already stored. Stay locked until a later read applies,
        // and leave the error up so the owner can retry this load.
        setLoadError(messageFrom(error));
      }
    } catch (error) {
      if (!saved) {
        failure = error;
        setError(messageFrom(error));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    return { saved, error: failure };
  }

  async function submitExpense(draft: ExpenseDraft) {
    if (
      savingRef.current ||
      needsReloadRef.current ||
      postedReload ||
      readsRef.current > 0 ||
      !isOnline()
    ) {
      return;
    }
    setFormError(null);
    const session = captureWriteSession();
    const prior = getHeldWrite<ExpenseDraft>(EXPENSE_NEW_SUBJECT);
    const wasPinned =
      prior !== null &&
      prior.requestId === draft.requestId &&
      prior.phase === 'unknown';
    const targetMonth = expenseTargetMonth(draft, monthRef.current);
    const claim = wasPinned
      ? await claimReplayHeldWrite<ExpenseDraft>(
          EXPENSE_NEW_SUBJECT,
          draft.requestId,
          { session },
        )
      : await claimFreshHeldWrite<ExpenseDraft>(
          EXPENSE_NEW_SUBJECT,
          () => draft,
          { requestId: draft.requestId, kind: 'expense', session },
        );
    if (!claim.ok) {
      if (claim.reason === 'storage' || claim.reason === 'missing') {
        setFormError(storageWriteFailedMessage);
      } else if (claim.reason === 'session_invalid' && !isOnline()) {
        setFormError(offlineWriteMessage);
      }
      return;
    }
    if (!canDispatchWriteFor(session)) {
      if (wasPinned) {
        setHeldWritePhase(EXPENSE_NEW_SUBJECT, draft.requestId, 'unknown');
      } else {
        clearHeldWrite(EXPENSE_NEW_SUBJECT, draft.requestId);
      }
      claim.release();
      if (!isOnline()) setFormError(offlineWriteMessage);
      return;
    }
    let result: WriteResult;
    try {
      result = await runWrite(
        () => addExpenseEntry(draft),
        setFormError,
        () => {
          setHeldWritePhase(
            EXPENSE_NEW_SUBJECT,
            draft.requestId,
            'posted_reload',
            { readTarget: targetMonth },
          );
          setFormEpoch((value) => value + 1);
        },
        session,
      );
      if (!result.saved && result.error) {
        setFormError(reportedExpenseError(result.error));
        if (wasPinned) {
          if (isPayloadRefusal(result.error)) {
            clearHeldWrite(EXPENSE_NEW_SUBJECT, draft.requestId);
          } else {
            setHeldWritePhase(EXPENSE_NEW_SUBJECT, draft.requestId, 'unknown');
          }
        } else if (isUnknownOutcome(result.error)) {
          setHeldWritePhase(EXPENSE_NEW_SUBJECT, draft.requestId, 'unknown');
        } else {
          clearHeldWrite(EXPENSE_NEW_SUBJECT, draft.requestId);
        }
      }
    } finally {
      claim.release();
    }
  }

  async function voidEntry(id: string, typedReason: string) {
    if (
      savingRef.current ||
      needsReloadRef.current ||
      postedReload ||
      readsRef.current > 0 ||
      !isOnline()
    ) {
      return;
    }
    setListError(null);
    const session = captureWriteSession();
    const subject = voidSubject(id);
    const prior = getHeldWrite<StoredVoidPayload>(subject);
    const wasPinned = prior !== null && prior.phase === 'unknown';
    const pinned = wasPinned ? prior.payload : null;
    const requestId =
      pinned?.requestId ??
      voidRequestIdsRef.current.get(id) ??
      crypto.randomUUID();
    const reason = pinned?.reason ?? typedReason;
    const visible =
      voidSnapshots.get(id) ??
      data?.entries.find((line) => line.id === id) ??
      null;
    const setVoidSnapshot = (entry: ExpenseLine | null) => {
      setVoidSnapshots((current) => {
        if (entry === null && !current.has(id)) return current;
        const next = new Map(current);
        if (entry) next.set(id, entry);
        else next.delete(id);
        return next;
      });
    };
    const targetMonth =
      pinned?.targetMonth ?? voidTargetMonth(visible, monthRef.current);
    const claim = wasPinned
      ? await claimReplayHeldWrite<StoredVoidPayload>(subject, requestId, {
          session,
        })
      : await claimFreshHeldWrite<StoredVoidPayload>(
          subject,
          () => ({ id, requestId, reason, targetMonth }),
          { requestId, kind: 'expense_void', session },
        );
    if (!claim.ok) {
      if (claim.reason === 'storage' || claim.reason === 'missing') {
        setListError(storageWriteFailedMessage);
      } else if (claim.reason === 'session_invalid' && !isOnline()) {
        setListError(offlineWriteMessage);
      }
      return;
    }
    const effectiveTargetMonth =
      claim.record.payload.targetMonth ?? targetMonth;
    if (!canDispatchWriteFor(session)) {
      if (wasPinned) {
        setHeldWritePhase(subject, requestId, 'unknown');
      } else {
        clearHeldWrite(subject, requestId);
      }
      claim.release();
      if (!isOnline()) setListError(offlineWriteMessage);
      return;
    }
    if (visible) setVoidSnapshot({ ...visible });
    let result: WriteResult;
    try {
      result = await runWrite(
        () => voidExpenseEntry(id, reason, requestId),
        setListError,
        () => {
          voidRequestIdsRef.current.delete(id);
          setVoidSnapshot(null);
          setHeldWritePhase(subject, requestId, 'posted_reload', {
            readTarget: effectiveTargetMonth,
          });
        },
        session,
      );
      if (!result.saved && result.error) {
        voidRequestIdsRef.current.set(id, requestId);
        setListError(reportedExpenseError(result.error));
        if (wasPinned) {
          if (isPayloadRefusal(result.error)) {
            clearHeldWrite(subject, requestId);
            setVoidSnapshot(null);
          } else {
            setHeldWritePhase(subject, requestId, 'unknown');
          }
        } else if (isUnknownOutcome(result.error)) {
          setHeldWritePhase(subject, requestId, 'unknown');
        } else {
          clearHeldWrite(subject, requestId);
          setVoidSnapshot(null);
        }
      }
    } finally {
      claim.release();
    }
  }

  return (
    <main aria-busy={busy} className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">المصاريف</h1>
      {!online ? (
        <>
          <p role="status">{offlineWriteMessage}</p>
          <p role="status">{offlineMoneyMessage}</p>
        </>
      ) : null}
      <p>{formatMonth(monthStart)}</p>
      <label className="flex flex-col gap-1">
        الشهر
        <input
          className={fieldClass}
          type="month"
          value={month}
          disabled={monthPickerDisabled}
          onChange={(event) => changeMonth(event.target.value)}
        />
        {/* This picker still moves the list and the allocation while a save
            or void is pinned. The form and the void card keep the payload. */}
      </label>
      {online && !ready && !loadError ? <p>جاري تحميل المصاريف…</p> : null}
      {loadError ? (
        <div className="flex flex-col gap-2">
          <p role="alert">{loadError}</p>
          <button
            className={secondaryButton}
            type="button"
            disabled={saving || readLoads > 0 || !online}
            onClick={retry}
          >
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {detachedVoids.length > 0 ? (
        <section
          aria-label="إلغاءات مش متأكد إنها اتسجلت"
          className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
        >
          <h2 className="text-lg font-semibold">
            إلغاءات مش متأكد إنها اتسجلت
          </h2>
          {listError ? <p role="alert">{listError}</p> : null}
          {detachedVoids.map((pin) => (
            <div key={pin.id} className="flex flex-col gap-1">
              <p>سبب الإلغاء: {pin.reason}</p>
              <button
                className={secondaryButton}
                type="button"
                disabled={writeDisabled}
                onClick={() => void voidEntry(pin.id, pin.reason)}
              >
                إعادة محاولة الإلغاء
              </button>
            </div>
          ))}
        </section>
      ) : null}
      {data ? (
        <ExpenseForm
          key={formEpoch}
          categories={data.categories}
          month={month}
          disabled={writeDisabled || !ready}
          serverError={formError}
          pending={pendingExpense}
          onMonthChange={changeMonth}
          onSubmit={(draft) => void submitExpense(draft)}
        />
      ) : null}
      {ready && data ? (
        <>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={data.complete}
              disabled={writeDisabled}
              onChange={(event) =>
                void runWrite(
                  () =>
                    setMonthExpenseComplete(monthStart, event.target.checked),
                  setListError,
                  () => {
                    setReloadMarker(EXPENSE_RELOAD_SUBJECT, monthStart);
                  },
                )
              }
            />
            مصاريف الشهر كاملة
          </label>
          {data.confirmedAt ? (
            <p>اتأكدت {formatCairo(data.confirmedAt)}</p>
          ) : null}
          {online ? (
            <>
              <h2 className="text-lg font-semibold">مصاريف الشهر</h2>
              {listError && detachedVoids.length === 0 ? (
                <p role="alert">{listError}</p>
              ) : null}
              <ExpenseList
                entries={visibleEntries}
                disabled={writeDisabled}
                pendingReasons={
                  new Map(
                    [...pendingVoids].map(([id, pending]) => [
                      id,
                      pending.reason,
                    ]),
                  )
                }
                onVoid={(id, typedReason) => {
                  void voidEntry(id, typedReason);
                }}
              />
              <AllocationTable days={data.days} />
            </>
          ) : null}
          <CategoryManager
            categories={data.categories}
            disabled={writeDisabled}
            serverError={categoryError}
            onAdd={async (name, kind: ExpenseKind) => {
              const result = await runWrite(
                () => addExpenseCategory(name, kind),
                setCategoryError,
              );
              return result.saved;
            }}
            onRename={(id, name) =>
              void runWrite(
                () => renameExpenseCategory(id, name),
                setCategoryError,
              )
            }
            onSetActive={(id, active) =>
              void runWrite(
                () => setExpenseCategoryActive(id, active),
                setCategoryError,
              )
            }
          />
        </>
      ) : null}
    </main>
  );
}
