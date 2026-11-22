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
  clearHeldWrite,
  clearPostedReload,
  getHeldWrite,
  hasPostedReload,
  listHeldWritesByPrefix,
  putHeldWrite,
  setHeldWritePhase,
  subscribeHeldWritesStore,
} from '@/lib/held-writes';
import { isOnline, offlineWriteMessage, useOnline } from '@/lib/online';
import { pageShell, secondaryButton } from '@/lib/page-style';

const EXPENSE_NEW_SUBJECT = 'expense:new';
const EXPENSE_VOID_PREFIX = 'expense:void:';
const EXPENSE_RELOAD_SUBJECT = 'expense:reload';

/** Stored in localStorage for void retries: request id and reason only (no cached money). */
type StoredVoidPayload = {
  id: string;
  requestId: string;
  reason: string;
};

type VoidAttempt = {
  requestId: string;
  reason: string;
  /** The row as it was when the void was sent (in-memory only). */
  entry: ExpenseLine | null;
};

function voidSubject(id: string): string {
  return `${EXPENSE_VOID_PREFIX}${id}`;
}

function clearExpensePostedReloads(): void {
  clearPostedReload(EXPENSE_NEW_SUBJECT);
  clearPostedReload(EXPENSE_RELOAD_SUBJECT);
  for (const record of listHeldWritesByPrefix(EXPENSE_VOID_PREFIX)) {
    if (record.phase === 'posted_reload') {
      clearPostedReload(record.subject);
    }
  }
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
  const online = useOnline();
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

  useEffect(
    () => subscribeHeldWritesStore(() => setHeldEpoch((value) => value + 1)),
    [],
  );

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
      requestId,
      reason,
      entry: voidSnapshots.get(id) ?? null,
    });
  }
  const inflightVoid = storedVoids.some(
    (record) => record.phase === 'inflight',
  );
  const postedReload =
    heldEpoch >= 0 &&
    (storedExpense?.phase === 'posted_reload' ||
      hasPostedReload(EXPENSE_RELOAD_SUBJECT) ||
      storedVoids.some((record) => record.phase === 'posted_reload'));

  const needsReload = localNeedsReload || postedReload;
  const monthStart = `${month}-01`;
  const ready = data !== null && data.monthStart === monthStart;
  const writeLocked = saving || inflightExpense || inflightVoid || needsReload;
  const busy = writeLocked || readLoads > 0;
  const writeDisabled = busy || !online;

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
    void (async () => {
      try {
        const next = await readMonth(month);
        if (cancelled || !next) return;
        setData(next);
        setLoadError(null);
        clearExpensePostedReloads();
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
    if (savingRef.current || readsRef.current > 0) return;
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  function changeMonth(next: string) {
    if (savingRef.current || needsReloadRef.current || postedReload) return;
    if (!/^\d{4}-\d{2}$/.test(next) || next === monthRef.current) return;
    monthRef.current = next;
    setLoadError(null);
    setMonth(next);
  }

  async function runWrite(
    action: () => Promise<void>,
    setError: (message: string | null) => void,
    onSaved?: () => void,
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
    savingRef.current = true;
    setSaving(true);
    setError(null);
    let saved = false;
    let failure: unknown = null;
    try {
      await action();
      saved = true;
      onSaved?.();
      needsReloadRef.current = true;
      setLocalNeedsReload(true);
      try {
        const next = await readMonth(monthRef.current);
        if (next) {
          setData(next);
          setLoadError(null);
          clearExpensePostedReloads();
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
    const prior = getHeldWrite<ExpenseDraft>(EXPENSE_NEW_SUBJECT);
    const wasPinned =
      prior !== null &&
      prior.requestId === draft.requestId &&
      prior.phase === 'unknown';
    const result = await runWrite(
      () => {
        putHeldWrite(EXPENSE_NEW_SUBJECT, {
          requestId: draft.requestId,
          payload: draft,
          phase: 'inflight',
          kind: 'expense',
        });
        return addExpenseEntry(draft);
      },
      setFormError,
      () => {
        setHeldWritePhase(
          EXPENSE_NEW_SUBJECT,
          draft.requestId,
          'posted_reload',
        );
        setFormEpoch((value) => value + 1);
      },
    );
    if (result.saved) return;
    // Not sent: the form stays editable and nothing is pinned.
    if (!result.error) return;
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

  async function voidEntry(id: string, typedReason: string) {
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
    const result = await runWrite(
      () => {
        if (visible) setVoidSnapshot({ ...visible });
        putHeldWrite<StoredVoidPayload>(subject, {
          requestId,
          payload: { id, requestId, reason },
          phase: 'inflight',
          kind: 'expense_void',
        });
        return voidExpenseEntry(id, reason, requestId);
      },
      setListError,
      () => {
        voidRequestIdsRef.current.delete(id);
        setVoidSnapshot(null);
        setHeldWritePhase(subject, requestId, 'posted_reload');
      },
    );
    if (result.saved) return;
    // Not sent: leave an existing pin alone, and do not store this attempt.
    if (!result.error) return;
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

  return (
    <main aria-busy={busy} className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">المصاريف</h1>
      {!online ? <p role="status">{offlineWriteMessage}</p> : null}
      <p>{formatMonth(monthStart)}</p>
      <label className="flex flex-col gap-1">
        الشهر
        <input
          className={fieldClass}
          type="month"
          value={month}
          disabled={writeLocked}
          onChange={(event) => changeMonth(event.target.value)}
        />
        {/* This picker still moves the list and the allocation while a save
            or void is pinned. The form and the void card keep the payload. */}
      </label>
      {!ready && !loadError ? <p>جاري تحميل المصاريف…</p> : null}
      {loadError ? (
        <div className="flex flex-col gap-2">
          <p role="alert">{loadError}</p>
          <button
            className={secondaryButton}
            type="button"
            disabled={saving || readLoads > 0}
            onClick={retry}
          >
            إعادة المحاولة
          </button>
        </div>
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
                    putHeldWrite(EXPENSE_RELOAD_SUBJECT, {
                      requestId: crypto.randomUUID(),
                      payload: null,
                      phase: 'posted_reload',
                      kind: 'expense',
                    });
                  },
                )
              }
            />
            مصاريف الشهر كاملة
          </label>
          {data.confirmedAt ? (
            <p>اتأكدت {formatCairo(data.confirmedAt)}</p>
          ) : null}
          <h2 className="text-lg font-semibold">مصاريف الشهر</h2>
          {listError ? <p role="alert">{listError}</p> : null}
          <ExpenseList
            entries={entriesWithPinnedVoids(data.entries, pendingVoids)}
            disabled={writeDisabled}
            pendingReasons={
              new Map(
                [...pendingVoids].map(([id, pending]) => [id, pending.reason]),
              )
            }
            onVoid={(id, typedReason) => {
              void voidEntry(id, typedReason);
            }}
          />
          <AllocationTable days={data.days} />
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
