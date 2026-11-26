import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AllocationTable } from '@/expenses/AllocationTable';
import {
  addExpenseCategory,
  addExpenseEntry,
  hasExpenseVoidRequest,
  loadExpenseEntryMonth,
  loadExpenseMonth,
  loadExpenseRequestMonth,
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
  isRequestIdMismatchError,
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
  abortClaimBeforeDispatch,
  canDispatchHeldWrite,
  canDispatchWriteFor,
  captureWriteSession,
  claimFreshHeldWrite,
  claimReplayHeldWrite,
  clearHeldWrite,
  clearVerifiedHeldWrite,
  clearPostedReloadSnapshot,
  EXPENSE_NEW_SUBJECT,
  EXPENSE_VOID_PREFIX,
  getHeldWrite,
  hasDurableHeldWrite,
  isCurrentWriteSession,
  listHeldWritesByPrefix,
  setHeldWritePhase,
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
import { isRequestlessDefiniteRefusal } from '@/lib/write-outcome';

type RequestlessVerifyState = {
  targetMonth: string;
  status: 'verifying' | 'read_failed' | 'verified';
  readError: string | null;
};

type LocalReloadLock = {
  id: number;
  targetMonth: string;
};

/** Stored in localStorage for void retries: request id, reason, and target month (no cached money). */
type StoredVoidPayload = {
  id: string;
  requestId: string;
  reason: string;
  targetMonth?: string;
  awaitingRequestMonth?: true;
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

function expenseDraftMonth(draft: ExpenseDraft): string | undefined {
  if (draft.periodMonth) return draft.periodMonth;
  if (draft.expenseDate && draft.expenseDate.length >= 7) {
    return `${draft.expenseDate.slice(0, 7)}-01`;
  }
  return undefined;
}

function voidTargetMonthFromEntry(entry: ExpenseLine | null): string | null {
  if (entry?.periodMonth) return entry.periodMonth;
  if (entry?.expenseDate && entry.expenseDate.length >= 7) {
    return `${entry.expenseDate.slice(0, 7)}-01`;
  }
  return null;
}

function snapshotExpensePostedReloads(): PostedReloadSnapshot {
  return [
    ...snapshotPostedReloads({ subject: EXPENSE_NEW_SUBJECT }),
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
  dispatched: boolean;
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

async function resolveExpenseRequestMonth(
  requestId: string,
): Promise<string | null> {
  try {
    return await loadExpenseRequestMonth(requestId);
  } catch {
    return null;
  }
}

export function ExpensesPage() {
  const initialMonth = cairoMonthInput();
  const [month, setMonth] = useState(initialMonth);
  const monthRef = useRef(initialMonth);
  const [data, setData] = useState<ExpenseMonth | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [postedVerifyErrors, setPostedVerifyErrors] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [formError, setFormError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [completeVerify, setCompleteVerify] =
    useState<RequestlessVerifyState | null>(null);
  const [categoryVerify, setCategoryVerify] =
    useState<RequestlessVerifyState | null>(null);
  const [saving, setSaving] = useState(false);
  const [localNeedsReload, setLocalNeedsReload] = useState(false);
  const [readLoads, setReadLoads] = useState(0);
  const [loadId, setLoadId] = useState(0);
  const [formEpoch, setFormEpoch] = useState(0);
  const [requestIdNonce, setRequestIdNonce] = useState(0);
  const [heldEpoch, setHeldEpoch] = useState(0);
  // In-memory snapshots of voided rows while switching months (never written to localStorage).
  const [voidSnapshots, setVoidSnapshots] = useState<
    ReadonlyMap<string, ExpenseLine>
  >(() => new Map());
  // Ids of voids that were sent and refused. A refusal is not stored, so a
  // correction reuses the id. Cleared once that void succeeds.
  const voidRequestIdsRef = useRef(new Map<string, string>());
  const completeVerifyRef = useRef<RequestlessVerifyState | null>(
    completeVerify,
  );
  const categoryVerifyRef = useRef<RequestlessVerifyState | null>(
    categoryVerify,
  );
  const dataSessionRef = useRef<WriteSession | null>(null);
  const monthSeqRef = useRef(new Map<string, number>());
  const globalReadSeqRef = useRef(0);
  const readsRef = useRef(0);
  const savingRef = useRef(false);
  const reloadLockSeqRef = useRef(0);
  const reloadLockRef = useRef<LocalReloadLock | null>(null);

  const raiseLocalReloadLock = useCallback(
    (targetMonth: string): LocalReloadLock => {
      const lock: LocalReloadLock = {
        id: ++reloadLockSeqRef.current,
        targetMonth,
      };
      reloadLockRef.current = lock;
      setLocalNeedsReload(true);
      return lock;
    },
    [],
  );

  const releaseLocalReloadLock = useCallback(
    (captured: LocalReloadLock | null, loadedMonthStart: string): void => {
      if (
        captured !== null &&
        reloadLockRef.current === captured &&
        (captured.targetMonth === '*' ||
          captured.targetMonth === loadedMonthStart)
      ) {
        reloadLockRef.current = null;
        setLocalNeedsReload(false);
      }
    },
    [],
  );

  const setCompleteVerifyState = useCallback(
    (next: RequestlessVerifyState | null) => {
      completeVerifyRef.current = next;
      setCompleteVerify(next);
    },
    [],
  );

  const setCategoryVerifyState = useCallback(
    (next: RequestlessVerifyState | null) => {
      categoryVerifyRef.current = next;
      setCategoryVerify(next);
    },
    [],
  );

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

  async function reconcileCommittedVoids(
    entries: readonly ExpenseLine[],
    readSession: WriteSession | null,
  ): Promise<void> {
    if (!isCurrentWriteSession(readSession)) return;
    const voidedIds = new Set(
      entries.filter((line) => line.voided).map((line) => line.id),
    );
    if (voidedIds.size === 0) return;
    const clearedIds: string[] = [];
    for (const record of listHeldWritesByPrefix<StoredVoidPayload>(
      EXPENSE_VOID_PREFIX,
    )) {
      const id = record.payload?.id;
      if (record.phase !== 'unknown' || !id || !voidedIds.has(id)) continue;
      // A voided row can belong to a different request. Only the exact void
      // marker can settle this pin, including after quota and a reload.
      try {
        if (!(await hasExpenseVoidRequest(record.requestId, id))) continue;
      } catch {
        continue;
      }
      if (!isCurrentWriteSession(readSession)) return;
      await clearVerifiedHeldWrite(record);
      if (!isCurrentWriteSession(readSession)) return;
      if (getHeldWrite(record.subject)) continue;
      voidRequestIdsRef.current.delete(id);
      clearedIds.push(id);
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

  const reconcileRequestlessVerifyOnMonth = useCallback(
    (
      monthData: ExpenseMonth,
      completeState: RequestlessVerifyState | null,
      categoryState: RequestlessVerifyState | null,
    ): void => {
      if (
        completeState &&
        completeVerifyRef.current === completeState &&
        completeState.status !== 'verified' &&
        completeState.targetMonth === monthData.monthStart
      ) {
        setCompleteVerifyState({
          targetMonth: completeState.targetMonth,
          status: 'verified',
          readError: null,
        });
      }
      if (
        categoryState &&
        categoryVerifyRef.current === categoryState &&
        categoryState.status !== 'verified'
      ) {
        setCategoryVerifyState({
          targetMonth: monthData.monthStart,
          status: 'verified',
          readError: null,
        });
      }
    },
    [setCategoryVerifyState, setCompleteVerifyState],
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
      id,
      requestId,
      reason,
      entry: voidSnapshots.get(id) ?? null,
    });
  }
  const inflightVoid = storedVoids.some(
    (record) => record.phase === 'inflight',
  );

  const pendingPostedSnapshot =
    heldEpoch < 0 ? [] : snapshotExpensePostedReloads();

  function postedReloadForTarget(target: string): boolean {
    if (heldEpoch < 0) return false;
    const matchesTarget = (readTarget: string | undefined) =>
      target === '*' ||
      !readTarget ||
      readTarget === '*' ||
      readTarget === target;
    return (
      (storedExpense?.phase === 'posted_reload' &&
        matchesTarget(storedExpense.readTarget)) ||
      storedVoids.some(
        (record) =>
          record.phase === 'posted_reload' && matchesTarget(record.readTarget),
      ) ||
      pendingPostedSnapshot.some((record) => matchesTarget(record.readTarget))
    );
  }

  const monthStart = `${month}-01`;
  const postedReloadForCurrentMonth = postedReloadForTarget(monthStart);
  const postedReloadTargets = [
    ...new Set(
      pendingPostedSnapshot.map((record) =>
        record.readTarget && record.readTarget !== '*'
          ? record.readTarget
          : monthStart,
      ),
    ),
  ];
  const verifyTargetsToShow =
    saving || readLoads > 0
      ? []
      : postedReloadTargets.filter(
          (target) => target !== monthStart || loadError === null,
        );

  const completeVerifyBlocked =
    completeVerify !== null &&
    completeVerify.status !== 'verified' &&
    completeVerify.targetMonth === monthStart;
  const categoryVerifyBlocked =
    categoryVerify !== null && categoryVerify.status !== 'verified';

  const needsReload = localNeedsReload || postedReloadForCurrentMonth;
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

  const nextMonthSeq = useCallback((targetMonth: string): number => {
    const next = (monthSeqRef.current.get(targetMonth) ?? 0) + 1;
    monthSeqRef.current.set(targetMonth, next);
    return next;
  }, []);

  const isLatestMonthSeq = useCallback(
    (targetMonth: string, seq: number): boolean =>
      (monthSeqRef.current.get(targetMonth) ?? 0) === seq,
    [],
  );

  type MonthReadResult = {
    data: ExpenseMonth;
    monthSeq: number;
    globalSeq: number;
    readSession: WriteSession | null;
  };

  /**
   * Single read path for all expense-month reads (regular navigation, post-write
   * reloads, and request-less verification). Uses a per-month sequence so an
   * older read for a month can never overwrite a newer read for that same month.
   */
  const readExpenseMonthTarget = useCallback(
    async (
      targetMonth: string,
      mode: 'month' | 'global' | 'sibling' = 'month',
    ): Promise<MonthReadResult | null> => {
      // Sibling verification may fail without a UI error. Let an existing
      // navigation read finish unless verification produces a replacement.
      const monthSeq =
        mode === 'sibling'
          ? (monthSeqRef.current.get(targetMonth) ?? 0)
          : nextMonthSeq(targetMonth);
      const globalSeq =
        mode === 'sibling'
          ? globalReadSeqRef.current
          : ++globalReadSeqRef.current;
      const readSession = captureWriteSession();
      const isStale = () =>
        !isLatestMonthSeq(targetMonth, monthSeq) ||
        (mode === 'global' && globalSeq !== globalReadSeqRef.current);
      readsRef.current += 1;
      setReadLoads(readsRef.current);
      try {
        const next = await loadExpenseMonth(targetMonth);
        if (isStale()) return null;
        return { data: next, monthSeq, globalSeq, readSession };
      } catch (error) {
        if (isStale()) return null;
        throw error;
      } finally {
        readsRef.current -= 1;
        setReadLoads(readsRef.current);
      }
    },
    [isLatestMonthSeq, nextMonthSeq],
  );

  const clearPostedVerifyError = useCallback((targetMonth: string) => {
    setPostedVerifyErrors((current) => {
      if (!current.has(targetMonth)) return current;
      const next = new Map(current);
      next.delete(targetMonth);
      return next;
    });
  }, []);

  function applyDisplayedMonthRead(result: MonthReadResult): boolean {
    if (result.data.monthStart !== `${monthRef.current}-01`) return false;
    dataSessionRef.current = result.readSession;
    setData(result.data);
    setLoadError(null);
    return true;
  }

  async function verifyExpenseReplaySibling(
    requestId: string,
  ): Promise<'absent' | 'verified'> {
    const session = captureWriteSession();
    const targetMonth = await loadExpenseRequestMonth(requestId);
    if (targetMonth === null) return 'absent';
    if (!isCurrentWriteSession(session)) throw new Error(retrySafeMessage);
    const result = await readExpenseMonthTarget(targetMonth, 'sibling');
    if (
      !result ||
      result.data.monthStart !== targetMonth ||
      !isCurrentWriteSession(result.readSession) ||
      !isLatestMonthSeq(targetMonth, result.monthSeq)
    ) {
      throw new Error(retrySafeMessage);
    }
    if (applyDisplayedMonthRead(result)) nextMonthSeq(targetMonth);
    clearPostedVerifyError(targetMonth);
    return 'verified';
  }

  const setPostedVerifyError = useCallback(
    (targetMonth: string, message: string) => {
      setPostedVerifyErrors((current) => {
        if (current.get(targetMonth) === message) return current;
        const next = new Map(current);
        next.set(targetMonth, message);
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const displayedMonthStart = `${month}-01`;
    const completeAttempt = completeVerifyRef.current;
    const categoryAttempt = categoryVerifyRef.current;
    const capturedReloadLock = reloadLockRef.current;
    const pendingReloads = snapshotExpensePostedReloads();
    void (async () => {
      try {
        const result = await readExpenseMonthTarget(displayedMonthStart);
        if (
          cancelled ||
          !result ||
          result.data.monthStart !== `${monthRef.current}-01`
        ) {
          return;
        }
        dataSessionRef.current = result.readSession;
        setData(result.data);
        setLoadError(null);
        clearPostedVerifyError(result.data.monthStart);
        reconcileRequestlessVerifyOnMonth(
          result.data,
          completeAttempt,
          categoryAttempt,
        );
        await reconcileCommittedVoids(result.data.entries, result.readSession);
        await clearPostedReloadSnapshot(
          pendingReloads,
          result.data.monthStart,
          result.readSession,
        );
        releaseLocalReloadLock(capturedReloadLock, result.data.monthStart);
      } catch (error) {
        if (cancelled) return;
        setLoadError(messageFrom(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    month,
    loadId,
    clearPostedVerifyError,
    readExpenseMonthTarget,
    reconcileRequestlessVerifyOnMonth,
    releaseLocalReloadLock,
  ]);

  function retry() {
    if (savingRef.current || readsRef.current > 0 || !isOnline()) return;
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  async function verifyPostedReloadTarget(targetMonth: string): Promise<void> {
    if (savingRef.current || readsRef.current > 0 || !isOnline()) return;
    clearPostedVerifyError(targetMonth);
    const pendingReloads = snapshotExpensePostedReloads();
    const capturedReloadLock = reloadLockRef.current;
    try {
      const result = await readExpenseMonthTarget(targetMonth);
      if (!result) return;
      applyDisplayedMonthRead(result);
      await reconcileCommittedVoids(result.data.entries, result.readSession);
      await clearPostedReloadSnapshot(
        pendingReloads,
        result.data.monthStart,
        result.readSession,
      );
      releaseLocalReloadLock(capturedReloadLock, result.data.monthStart);
      clearPostedVerifyError(result.data.monthStart);
    } catch (error) {
      const msg = messageFrom(error);
      if (targetMonth === `${monthRef.current}-01`) {
        setLoadError(msg);
      } else {
        setPostedVerifyError(targetMonth, msg);
      }
    }
  }

  function changeMonth(next: string) {
    if (
      savingRef.current ||
      reloadLockRef.current !== null ||
      postedReloadForCurrentMonth
    )
      return;
    if (!/^\d{4}-\d{2}$/.test(next) || next === monthRef.current) return;
    if (completeVerifyRef.current?.status === 'verified') {
      setCompleteVerifyState(null);
    }
    monthRef.current = next;
    setLoadError(null);
    setMonth(next);
  }

  async function verifyRequestlessRead(
    kind: 'complete' | 'category',
  ): Promise<void> {
    const state =
      kind === 'complete'
        ? completeVerifyRef.current
        : categoryVerifyRef.current;
    if (!state || savingRef.current || readsRef.current > 0 || !isOnline()) {
      return;
    }
    const targetMonth =
      kind === 'complete' ? state.targetMonth : `${monthRef.current}-01`;
    await readRequestlessVerification(kind, targetMonth);
  }

  async function readRequestlessVerification(
    kind: 'complete' | 'category',
    targetMonth: string,
  ): Promise<void> {
    const [verifyRef, setVerify] =
      kind === 'complete'
        ? ([completeVerifyRef, setCompleteVerifyState] as const)
        : ([categoryVerifyRef, setCategoryVerifyState] as const);
    const attempt: RequestlessVerifyState = {
      targetMonth,
      status: 'verifying',
      readError: null,
    };
    setVerify(attempt);
    const completeAttempt = completeVerifyRef.current;
    const categoryAttempt = categoryVerifyRef.current;
    const pendingReloads = snapshotExpensePostedReloads();
    try {
      const result = await readExpenseMonthTarget(
        targetMonth,
        kind === 'category' ? 'global' : 'month',
      );
      if (!result || verifyRef.current !== attempt) return;
      const fresh = result.data;
      if (fresh.monthStart === `${monthRef.current}-01`) {
        dataSessionRef.current = result.readSession;
        setData(fresh);
        setLoadError(null);
        await reconcileCommittedVoids(fresh.entries, result.readSession);
      }
      await clearPostedReloadSnapshot(
        pendingReloads,
        fresh.monthStart,
        result.readSession,
      );
      if (verifyRef.current !== attempt) return;
      setVerify({ targetMonth, status: 'verified', readError: null });
      reconcileRequestlessVerifyOnMonth(
        fresh,
        completeAttempt,
        categoryAttempt,
      );
    } catch (readError) {
      if (verifyRef.current !== attempt) return;
      setVerify({
        targetMonth,
        status: 'read_failed',
        readError: messageFrom(readError),
      });
    }
  }

  async function runRequestlessExpenseWrite(options: {
    kind: 'complete' | 'category';
    targetMonth: string;
    action: () => Promise<void>;
    setError: (message: string | null) => void;
  }): Promise<boolean> {
    const { kind, targetMonth, action, setError } = options;
    const blocked =
      kind === 'complete'
        ? completeVerifyRef.current !== null &&
          completeVerifyRef.current.status !== 'verified' &&
          completeVerifyRef.current.targetMonth === targetMonth
        : categoryVerifyRef.current !== null &&
          categoryVerifyRef.current.status !== 'verified';
    if (
      savingRef.current ||
      reloadLockRef.current !== null ||
      postedReloadForTarget(targetMonth) ||
      readsRef.current > 0 ||
      blocked ||
      !isOnline()
    ) {
      return false;
    }
    const session = dataSessionRef.current ?? captureWriteSession();
    if (!canDispatchWriteFor(session)) {
      if (!isOnline()) setError(offlineWriteMessage);
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    if (kind === 'complete') setCompleteVerifyState(null);
    else setCategoryVerifyState(null);
    try {
      await action();
      const reloadLock = raiseLocalReloadLock(
        kind === 'category' ? '*' : targetMonth,
      );
      try {
        const pendingReloads = snapshotExpensePostedReloads();
        const result = await readExpenseMonthTarget(targetMonth);
        if (result) {
          if (result.data.monthStart === `${monthRef.current}-01`) {
            dataSessionRef.current = result.readSession;
            setData(result.data);
            setLoadError(null);
            await reconcileCommittedVoids(
              result.data.entries,
              result.readSession,
            );
          }
          await clearPostedReloadSnapshot(
            pendingReloads,
            result.data.monthStart,
          );
          releaseLocalReloadLock(reloadLock, result.data.monthStart);
        }
      } catch (readError) {
        setLoadError(messageFrom(readError));
      }
      return true;
    } catch (error) {
      if (isRequestlessDefiniteRefusal(error)) {
        setError(messageFrom(error));
        return false;
      }
      await readRequestlessVerification(kind, targetMonth);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function runWrite(
    action: () => Promise<void>,
    setError: (message: string | null) => void,
    onSaved: () => string | null | void | Promise<string | null | void>,
    guard: {
      subject: string;
      requestId: string;
      session: WriteSession | null;
      readTarget?: string;
      release: () => void;
    },
  ): Promise<WriteResult> {
    const displayedMonthStart = `${monthRef.current}-01`;
    const effectiveTarget = guard.readTarget ?? displayedMonthStart;
    if (
      savingRef.current ||
      reloadLockRef.current !== null ||
      postedReloadForTarget(effectiveTarget) ||
      readsRef.current > 0 ||
      !isOnline()
    ) {
      return { dispatched: false, saved: false, error: null };
    }
    if (!canDispatchHeldWrite(guard.subject, guard.requestId, guard.session)) {
      if (!isOnline()) setError(offlineWriteMessage);
      else if (!hasDurableHeldWrite(guard.subject, guard.requestId)) {
        setError(storageWriteFailedMessage);
      }
      return { dispatched: false, saved: false, error: null };
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    let saved = false;
    let failure: unknown = null;
    try {
      await action();
      saved = true;
      const reloadLock = raiseLocalReloadLock(effectiveTarget);
      let verifyTarget: string | null = effectiveTarget;
      try {
        try {
          const resolved = await onSaved();
          if (resolved !== undefined) {
            verifyTarget = resolved;
          }
        } finally {
          guard.release();
        }
        if (verifyTarget === null) {
          if (reloadLockRef.current === reloadLock) {
            reloadLockRef.current = null;
            setLocalNeedsReload(false);
          }
        } else {
          reloadLock.targetMonth = verifyTarget;
          const pendingReloads = snapshotExpensePostedReloads();
          const result = await readExpenseMonthTarget(verifyTarget);
          if (result) {
            if (result.data.monthStart === `${monthRef.current}-01`) {
              dataSessionRef.current = result.readSession;
              setData(result.data);
              setLoadError(null);
            }
            await reconcileCommittedVoids(
              result.data.entries,
              result.readSession,
            );
            await clearPostedReloadSnapshot(
              pendingReloads,
              result.data.monthStart,
              result.readSession,
            );
            releaseLocalReloadLock(reloadLock, result.data.monthStart);
            clearPostedVerifyError(result.data.monthStart);
          }
        }
      } catch (error) {
        // The write is already stored. Stay locked until a later read of the
        // write's target month succeeds, and expose verification for that month.
        const msg = messageFrom(error);
        if (
          verifyTarget === null ||
          verifyTarget === `${monthRef.current}-01`
        ) {
          setLoadError(msg);
        } else {
          setPostedVerifyError(verifyTarget, msg);
        }
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
    return { dispatched: true, saved, error: failure };
  }

  async function submitExpense(draft: ExpenseDraft) {
    const draftMonth = expenseDraftMonth(draft);
    const targetMonth = draftMonth ?? `${monthRef.current}-01`;
    if (
      savingRef.current ||
      reloadLockRef.current !== null ||
      postedReloadForTarget(targetMonth) ||
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
    const claim = wasPinned
      ? await claimReplayHeldWrite<ExpenseDraft>(
          EXPENSE_NEW_SUBJECT,
          draft.requestId,
          {
            session,
            readTarget: expenseDraftMonth,
            verifyExpenseSibling: verifyExpenseReplaySibling,
          },
        )
      : await claimFreshHeldWrite<ExpenseDraft>(
          EXPENSE_NEW_SUBJECT,
          () => draft,
          {
            requestId: draft.requestId,
            kind: 'expense',
            readTarget: draftMonth,
            session,
          },
        );
    if (!claim.ok) {
      if (claim.reason === 'storage' || claim.reason === 'missing') {
        setFormError(storageWriteFailedMessage);
      } else if (claim.reason === 'session_invalid' && !isOnline()) {
        setFormError(offlineWriteMessage);
      }
      return;
    }
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        claim.release();
      }
    };
    const payload = claim.record.payload;
    const requestId = claim.record.requestId;
    const resolvedExpenseTarget =
      expenseDraftMonth(payload) ?? `${monthRef.current}-01`;
    let result: WriteResult;
    try {
      result = await runWrite(
        () => addExpenseEntry(payload),
        setFormError,
        () => {
          setHeldWritePhase(EXPENSE_NEW_SUBJECT, requestId, 'posted_reload', {
            readTarget: resolvedExpenseTarget,
          });
          setFormEpoch((value) => value + 1);
          return resolvedExpenseTarget;
        },
        {
          subject: EXPENSE_NEW_SUBJECT,
          requestId,
          session,
          readTarget: resolvedExpenseTarget,
          release: releaseOnce,
        },
      );
      if (!result.dispatched) {
        abortClaimBeforeDispatch(
          EXPENSE_NEW_SUBJECT,
          requestId,
          wasPinned ? 'unknown' : null,
          releaseOnce,
        );
        return;
      }
      if (!result.saved && result.error) {
        setFormError(reportedExpenseError(result.error));
        if (isRequestIdMismatchError(result.error)) {
          const storedMonth = await resolveExpenseRequestMonth(requestId);
          if (storedMonth !== null) {
            setHeldWritePhase(EXPENSE_NEW_SUBJECT, requestId, 'posted_reload', {
              readTarget: storedMonth,
              session,
            });
            setFormEpoch((value) => value + 1);
          } else {
            setHeldWritePhase(EXPENSE_NEW_SUBJECT, requestId, 'unknown', {
              session,
            });
          }
        } else if (wasPinned) {
          if (isPayloadRefusal(result.error)) {
            clearHeldWrite(EXPENSE_NEW_SUBJECT, requestId);
            setRequestIdNonce((value) => value + 1);
          } else {
            setHeldWritePhase(EXPENSE_NEW_SUBJECT, requestId, 'unknown');
          }
        } else if (isUnknownOutcome(result.error)) {
          setHeldWritePhase(EXPENSE_NEW_SUBJECT, requestId, 'unknown');
        } else {
          clearHeldWrite(EXPENSE_NEW_SUBJECT, requestId);
        }
      }
    } finally {
      releaseOnce();
    }
  }

  async function voidEntry(id: string, typedReason: string) {
    if (
      savingRef.current ||
      reloadLockRef.current !== null ||
      postedReloadForCurrentMonth ||
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
    const fromCurrentMonth =
      data?.entries.find((line) => line.id === id) ?? null;
    const visible = voidSnapshots.get(id) ?? fromCurrentMonth;
    const setVoidSnapshot = (entry: ExpenseLine | null) => {
      setVoidSnapshots((current) => {
        if (entry === null && !current.has(id)) return current;
        const next = new Map(current);
        if (entry) next.set(id, entry);
        else next.delete(id);
        return next;
      });
    };
    const freshTargetMonth =
      fromCurrentMonth && data
        ? data.monthStart
        : (voidTargetMonthFromEntry(visible) ?? undefined);
    const claim = wasPinned
      ? await claimReplayHeldWrite<StoredVoidPayload>(subject, requestId, {
          session,
          readTarget: (payload) =>
            payload.awaitingRequestMonth ? undefined : payload.targetMonth,
          verifyExpenseSibling: verifyExpenseReplaySibling,
        })
      : await claimFreshHeldWrite<StoredVoidPayload>(
          subject,
          () => ({ id, requestId, reason, targetMonth: freshTargetMonth }),
          {
            requestId,
            kind: 'expense_void',
            readTarget: freshTargetMonth,
            session,
          },
        );
    if (!claim.ok) {
      if (claim.reason === 'storage' || claim.reason === 'missing') {
        setListError(storageWriteFailedMessage);
      } else if (claim.reason === 'session_invalid' && !isOnline()) {
        setListError(offlineWriteMessage);
      }
      return;
    }
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        claim.release();
      }
    };
    if (visible) setVoidSnapshot({ ...visible });
    const claimedPayload = claim.record.payload;
    const claimedRequestId = claim.record.requestId;
    const initialVoidTarget =
      claimedPayload.targetMonth ??
      voidTargetMonthFromEntry(visible) ??
      freshTargetMonth;
    let result: WriteResult;
    try {
      result = await runWrite(
        () =>
          voidExpenseEntry(
            claimedPayload.id,
            claimedPayload.reason,
            claimedRequestId,
          ),
        setListError,
        async () => {
          voidRequestIdsRef.current.delete(id);
          setVoidSnapshot(null);
          let resolvedTarget: string | null =
            claimedPayload.targetMonth ??
            (fromCurrentMonth && data
              ? data.monthStart
              : voidTargetMonthFromEntry(visible));
          if (resolvedTarget === null) {
            if (typeof loadExpenseEntryMonth === 'function') {
              try {
                resolvedTarget = await loadExpenseEntryMonth(id);
              } catch {
                resolvedTarget = null;
              }
            }
          }
          if (resolvedTarget !== null) {
            setHeldWritePhase(subject, claimedRequestId, 'posted_reload', {
              readTarget: resolvedTarget,
            });
            return resolvedTarget;
          } else {
            // Legacy void pin whose month could not be resolved: do NOT fall
            // back to the displayed month — keep the pin held until verified.
            setHeldWritePhase(subject, claimedRequestId, 'unknown');
            return null;
          }
        },
        {
          subject,
          requestId: claimedRequestId,
          session,
          readTarget: initialVoidTarget,
          release: releaseOnce,
        },
      );
      if (!result.dispatched) {
        abortClaimBeforeDispatch(
          subject,
          claimedRequestId,
          wasPinned ? 'unknown' : null,
          releaseOnce,
        );
        return;
      }
      if (!result.saved && result.error) {
        setListError(reportedExpenseError(result.error));
        if (isRequestIdMismatchError(result.error)) {
          const storedMonth =
            await resolveExpenseRequestMonth(claimedRequestId);
          if (storedMonth !== null) {
            voidRequestIdsRef.current.delete(id);
            setVoidSnapshot(null);
            setHeldWritePhase(subject, claimedRequestId, 'posted_reload', {
              readTarget: storedMonth,
              session,
            });
          } else {
            // A voided row from the rejected payload cannot verify this request.
            setHeldWritePhase(subject, claimedRequestId, 'unknown', {
              payload: { ...claimedPayload, awaitingRequestMonth: true },
              session,
            });
          }
        } else if (wasPinned) {
          if (isPayloadRefusal(result.error)) {
            clearHeldWrite(subject, claimedRequestId);
            setVoidSnapshot(null);
            voidRequestIdsRef.current.delete(id);
          } else {
            voidRequestIdsRef.current.set(id, claimedRequestId);
            setHeldWritePhase(subject, claimedRequestId, 'unknown');
          }
        } else if (isUnknownOutcome(result.error)) {
          voidRequestIdsRef.current.set(id, claimedRequestId);
          setHeldWritePhase(subject, claimedRequestId, 'unknown');
        } else {
          voidRequestIdsRef.current.set(id, claimedRequestId);
          clearHeldWrite(subject, claimedRequestId);
          setVoidSnapshot(null);
        }
      }
    } finally {
      releaseOnce();
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
      {completeVerify ? (
        <section
          aria-label="حالة تأكيد الشهر"
          className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
        >
          <p role="status">مش متأكد إنه اتحفظ</p>
          {completeVerify.status === 'read_failed' ? (
            <>
              {completeVerify.readError ? (
                <p role="alert">{completeVerify.readError}</p>
              ) : null}
              <button
                className={secondaryButton}
                type="button"
                disabled={saving || readLoads > 0 || !online}
                onClick={() => void verifyRequestlessRead('complete')}
              >
                تحقق تاني
              </button>
            </>
          ) : null}
        </section>
      ) : null}
      {categoryVerify ? (
        <section
          aria-label="حالة حفظ التصنيف"
          className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
        >
          <p role="status">مش متأكد إنه اتحفظ</p>
          {categoryVerify.status === 'read_failed' ? (
            <>
              {categoryVerify.readError ? (
                <p role="alert">{categoryVerify.readError}</p>
              ) : null}
              <button
                className={secondaryButton}
                type="button"
                disabled={saving || readLoads > 0 || !online}
                onClick={() => void verifyRequestlessRead('category')}
              >
                تحقق تاني
              </button>
            </>
          ) : null}
        </section>
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
      {verifyTargetsToShow.map((target) => {
        const targetError = postedVerifyErrors.get(target) ?? null;
        return (
          <section
            key={target}
            aria-label={`التحقق من ${formatMonth(target)}`}
            className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
          >
            {targetError ? (
              <p role="alert">{targetError}</p>
            ) : (
              <p role="status">
                في حفظ اتسجل لشهر {formatMonth(target)} ومحتاج تحديث
              </p>
            )}
            <button
              className={secondaryButton}
              type="button"
              disabled={saving || readLoads > 0 || !online}
              onClick={() => void verifyPostedReloadTarget(target)}
            >
              تحقق تاني
            </button>
          </section>
        );
      })}
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
          requestIdNonce={requestIdNonce}
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
              disabled={writeDisabled || completeVerifyBlocked}
              onChange={(event) => {
                const nextChecked = event.target.checked;
                void runRequestlessExpenseWrite({
                  kind: 'complete',
                  targetMonth: monthStart,
                  action: () =>
                    setMonthExpenseComplete(monthStart, nextChecked),
                  setError: setListError,
                });
              }}
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
            disabled={writeDisabled || categoryVerifyBlocked}
            serverError={categoryError}
            onAdd={(name, kind: ExpenseKind) =>
              runRequestlessExpenseWrite({
                kind: 'category',
                targetMonth: `${monthRef.current}-01`,
                action: () => addExpenseCategory(name, kind),
                setError: setCategoryError,
              })
            }
            onRename={(id, name) =>
              void runRequestlessExpenseWrite({
                kind: 'category',
                targetMonth: `${monthRef.current}-01`,
                action: () => renameExpenseCategory(id, name),
                setError: setCategoryError,
              })
            }
            onSetActive={(id, active) =>
              void runRequestlessExpenseWrite({
                kind: 'category',
                targetMonth: `${monthRef.current}-01`,
                action: () => setExpenseCategoryActive(id, active),
                setError: setCategoryError,
              })
            }
          />
        </>
      ) : null}
    </main>
  );
}
