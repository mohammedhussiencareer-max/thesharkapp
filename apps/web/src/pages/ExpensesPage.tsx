import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AllocationTable } from '@/expenses/AllocationTable';
import {
  addExpenseCategory,
  addExpenseEntry,
  loadExpenseEntryMonth,
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
  abortClaimBeforeDispatch,
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

const EXPENSE_NEW_SUBJECT = 'expense:new';
const EXPENSE_VOID_PREFIX = 'expense:void:';

type RequestlessVerifyState = {
  targetMonth: string;
  status: 'verifying' | 'read_failed' | 'verified';
  readError: string | null;
};

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

function voidTargetMonthFromEntry(entry: ExpenseLine | null): string | null {
  if (entry?.periodMonth) return entry.periodMonth;
  if (entry?.expenseDate && entry.expenseDate.length >= 7) {
    return `${entry.expenseDate.slice(0, 7)}-01`;
  }
  return null;
}

function voidTargetMonth(
  entry: ExpenseLine | null,
  fallbackMonth: string,
): string {
  return voidTargetMonthFromEntry(entry) ?? `${fallbackMonth}-01`;
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

export function ExpensesPage() {
  const initialMonth = cairoMonthInput();
  const [month, setMonth] = useState(initialMonth);
  const monthRef = useRef(initialMonth);
  const [data, setData] = useState<ExpenseMonth | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
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
  const needsReloadRef = useRef(false);

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

  const reconcileRequestlessVerifyOnMonth = useCallback(
    (monthData: ExpenseMonth): void => {
      const completeState = completeVerifyRef.current;
      if (
        completeState &&
        completeState.status !== 'verified' &&
        completeState.targetMonth === monthData.monthStart
      ) {
        setCompleteVerifyState({
          targetMonth: completeState.targetMonth,
          status: 'verified',
          readError: null,
        });
      }
      const categoryState = categoryVerifyRef.current;
      if (categoryState && categoryState.status !== 'verified') {
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
      )
    );
  }

  const monthStart = `${month}-01`;
  const postedReloadForCurrentMonth = postedReloadForTarget(monthStart);

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
      monthSeqRef.current.get(targetMonth) === seq,
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
      mode: 'month' | 'global' = 'month',
    ): Promise<MonthReadResult | null> => {
      const monthSeq = nextMonthSeq(targetMonth);
      const globalSeq = ++globalReadSeqRef.current;
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

  async function readMonth(monthValue: string): Promise<ExpenseMonth | null> {
    const targetMonth = `${monthValue}-01`;
    const result = await readExpenseMonthTarget(targetMonth);
    if (!result || result.data.monthStart !== `${monthRef.current}-01`) {
      return null;
    }
    dataSessionRef.current = result.readSession;
    return result.data;
  }

  useEffect(() => {
    let cancelled = false;
    const displayedMonthStart = `${month}-01`;
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
        reconcileCommittedVoids(result.data.entries);
        reconcileRequestlessVerifyOnMonth(result.data);
        clearPostedReloadSnapshot(pendingReloads, result.data.monthStart);
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
  }, [
    month,
    loadId,
    readExpenseMonthTarget,
    reconcileRequestlessVerifyOnMonth,
  ]);

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
    const setVerify =
      kind === 'complete' ? setCompleteVerifyState : setCategoryVerifyState;
    setVerify({ targetMonth, status: 'verifying', readError: null });
    const pendingReloads = snapshotExpensePostedReloads();
    try {
      const result = await readExpenseMonthTarget(
        targetMonth,
        kind === 'category' ? 'global' : 'month',
      );
      // Discard superseded reads so an older verification cannot overwrite newer month data or unlock writes from stale data.
      if (!result) return;
      const fresh = result.data;
      if (fresh.monthStart === `${monthRef.current}-01`) {
        dataSessionRef.current = result.readSession;
        setData(fresh);
        setLoadError(null);
        reconcileCommittedVoids(fresh.entries);
      }
      clearPostedReloadSnapshot(pendingReloads, fresh.monthStart);
      setVerify({ targetMonth, status: 'verified', readError: null });
      reconcileRequestlessVerifyOnMonth(fresh);
    } catch (readError) {
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
      needsReloadRef.current ||
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
      needsReloadRef.current = true;
      setLocalNeedsReload(true);
      try {
        const pendingReloads = snapshotExpensePostedReloads();
        const result = await readExpenseMonthTarget(targetMonth);
        if (result) {
          if (result.data.monthStart === `${monthRef.current}-01`) {
            dataSessionRef.current = result.readSession;
            setData(result.data);
            setLoadError(null);
            reconcileCommittedVoids(result.data.entries);
          }
          clearPostedReloadSnapshot(pendingReloads, result.data.monthStart);
          needsReloadRef.current = false;
          setLocalNeedsReload(false);
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
      const setVerify =
        kind === 'complete' ? setCompleteVerifyState : setCategoryVerifyState;
      setVerify({ targetMonth, status: 'verifying', readError: null });
      const pendingReloads = snapshotExpensePostedReloads();
      try {
        const result = await readExpenseMonthTarget(
          targetMonth,
          kind === 'category' ? 'global' : 'month',
        );
        if (!result) return false;
        const fresh = result.data;
        if (fresh.monthStart === `${monthRef.current}-01`) {
          dataSessionRef.current = result.readSession;
          setData(fresh);
          setLoadError(null);
          reconcileCommittedVoids(fresh.entries);
        }
        clearPostedReloadSnapshot(pendingReloads, fresh.monthStart);
        setVerify({ targetMonth, status: 'verified', readError: null });
      } catch (readError) {
        setVerify({
          targetMonth,
          status: 'read_failed',
          readError: messageFrom(readError),
        });
      }
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function runWrite(
    action: () => Promise<void>,
    setError: (message: string | null) => void,
    onSaved: (() => void | Promise<void>) | undefined,
    guard: {
      subject: string;
      requestId: string;
      session: WriteSession | null;
      readTarget?: string;
    },
  ): Promise<WriteResult> {
    const displayedMonthStart = `${monthRef.current}-01`;
    const effectiveTarget = guard.readTarget ?? displayedMonthStart;
    if (
      savingRef.current ||
      needsReloadRef.current ||
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
      needsReloadRef.current = true;
      setLocalNeedsReload(true);
      try {
        await onSaved?.();
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
    return { dispatched: true, saved, error: failure };
  }

  async function submitExpense(draft: ExpenseDraft) {
    const targetMonth = expenseTargetMonth(draft, monthRef.current);
    if (
      savingRef.current ||
      needsReloadRef.current ||
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
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        claim.release();
      }
    };
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
        { subject: EXPENSE_NEW_SUBJECT, requestId: draft.requestId, session },
      );
      if (!result.dispatched) {
        abortClaimBeforeDispatch(
          EXPENSE_NEW_SUBJECT,
          draft.requestId,
          wasPinned ? 'unknown' : null,
          releaseOnce,
        );
        return;
      }
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
      releaseOnce();
    }
  }

  async function voidEntry(id: string, typedReason: string) {
    if (
      savingRef.current ||
      needsReloadRef.current ||
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
    const freshTargetMonth = voidTargetMonth(visible, monthRef.current);
    const claim = wasPinned
      ? await claimReplayHeldWrite<StoredVoidPayload>(subject, requestId, {
          session,
        })
      : await claimFreshHeldWrite<StoredVoidPayload>(
          subject,
          () => ({ id, requestId, reason, targetMonth: freshTargetMonth }),
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
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        claim.release();
      }
    };
    if (visible) setVoidSnapshot({ ...visible });
    let result: WriteResult;
    try {
      result = await runWrite(
        () => voidExpenseEntry(id, reason, requestId),
        setListError,
        async () => {
          voidRequestIdsRef.current.delete(id);
          setVoidSnapshot(null);
          let resolvedTarget: string | null =
            claim.record.payload.targetMonth ??
            voidTargetMonthFromEntry(visible);
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
            setHeldWritePhase(subject, requestId, 'posted_reload', {
              readTarget: resolvedTarget,
            });
          } else {
            // Legacy void pin whose month could not be resolved: do NOT fall
            // back to the displayed month — keep the pin held until verified.
            setHeldWritePhase(subject, requestId, 'unknown');
          }
        },
        { subject, requestId, session },
      );
      if (!result.dispatched) {
        abortClaimBeforeDispatch(
          subject,
          requestId,
          wasPinned ? 'unknown' : null,
          releaseOnce,
        );
        return;
      }
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
