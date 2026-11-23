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
  captureWriteSession,
  claimFreshHeldWrite,
  claimReplayHeldWrite,
  clearHeldWrite,
  clearPostedReloadSnapshot,
  getHeldWrite,
  hasDurableHeldWrite,
  listHeldWritesByPrefix,
  listReloadMarkers,
  setHeldWritePhase,
  snapshotPostedReloads,
  storageWriteFailedMessage,
  subscribeHeldWritesStore,
  type HeldWriteKind,
  type PostedReloadSnapshot,
  type WriteSession,
} from '@/lib/held-writes';
import {
  createRequestlessReconciler,
  type RequestlessPin,
} from '@/lib/requestless-reconcile';
import {
  isOnline,
  offlineMoneyMessage,
  offlineWriteMessage,
  useReconnectReload,
} from '@/lib/online';
import { pageShell, secondaryButton } from '@/lib/page-style';

const EXPENSE_NEW_SUBJECT = 'expense:new';
const EXPENSE_VOID_PREFIX = 'expense:void:';
const EXPENSE_COMPLETE_PREFIX = 'expense:complete:';
const EXPENSE_CATEGORY_PREFIX = 'expense:category:';
const EXPENSE_RELOAD_SUBJECT = 'expense:reload';

/** Minimal intended state persisted for request-less expense mutations so ambiguous outcomes can be verified and explicitly replayed. */
type StoredExpenseMutationIntent =
  | { kind: 'complete'; monthStart: string; complete: boolean }
  | { kind: 'category_add'; name: string; categoryKind: ExpenseKind }
  | { kind: 'category_rename'; categoryId: string; name: string }
  | { kind: 'category_active'; categoryId: string; active: boolean };

function isStoredExpenseMutationIntent(
  value: unknown,
): value is StoredExpenseMutationIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<StoredExpenseMutationIntent>;
  if (row.kind === 'complete') {
    return (
      typeof row.monthStart === 'string' && typeof row.complete === 'boolean'
    );
  }
  if (row.kind === 'category_add') {
    return typeof row.name === 'string' && typeof row.categoryKind === 'string';
  }
  if (row.kind === 'category_rename') {
    return typeof row.categoryId === 'string' && typeof row.name === 'string';
  }
  if (row.kind === 'category_active') {
    return (
      typeof row.categoryId === 'string' && typeof row.active === 'boolean'
    );
  }
  return false;
}

function monthMatchesMutationIntent(
  monthData: ExpenseMonth,
  intent: StoredExpenseMutationIntent,
): boolean {
  if (intent.kind === 'complete') {
    return (
      monthData.monthStart === intent.monthStart &&
      monthData.complete === intent.complete
    );
  }
  if (intent.kind === 'category_add') {
    const trimmed = intent.name.trim();
    return monthData.categories.some(
      (cat) => cat.name === trimmed && cat.kind === intent.categoryKind,
    );
  }
  if (intent.kind === 'category_rename') {
    const trimmed = intent.name.trim();
    return monthData.categories.some(
      (cat) => cat.id === intent.categoryId && cat.name === trimmed,
    );
  }
  return monthData.categories.some(
    (cat) => cat.id === intent.categoryId && cat.active === intent.active,
  );
}

function targetOfExpenseMutation(intent: StoredExpenseMutationIntent): string {
  return intent.kind === 'complete' ? intent.monthStart : '*';
}

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
    ...snapshotPostedReloads({ subject: EXPENSE_RELOAD_SUBJECT }),
    ...snapshotPostedReloads({ prefix: EXPENSE_VOID_PREFIX }),
    ...snapshotPostedReloads({ prefix: EXPENSE_COMPLETE_PREFIX }),
    ...snapshotPostedReloads({ prefix: EXPENSE_CATEGORY_PREFIX }),
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
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [localNeedsReload, setLocalNeedsReload] = useState(false);
  const [readLoads, setReadLoads] = useState(0);
  const [loadId, setLoadId] = useState(0);
  const [formEpoch, setFormEpoch] = useState(0);
  const [heldEpoch, setHeldEpoch] = useState(0);
  const [reconcileEpoch, setReconcileEpoch] = useState(0);
  const [mutationReconciler] = useState(() =>
    createRequestlessReconciler<StoredExpenseMutationIntent, ExpenseMonth>({
      prefixes: [EXPENSE_COMPLETE_PREFIX, EXPENSE_CATEGORY_PREFIX],
      reloadSubject: EXPENSE_RELOAD_SUBJECT,
      isIntent: isStoredExpenseMutationIntent,
      targetOf: targetOfExpenseMutation,
      markerTargetOf: targetOfExpenseMutation,
      matchesServerState: monthMatchesMutationIntent,
      onChange: () => setReconcileEpoch((value) => value + 1),
    }),
  );
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

  const applyMutationRead = useCallback(
    (
      snapshot: ReturnType<typeof mutationReconciler.snapshotBeforeRead>,
      monthData: ExpenseMonth,
    ) => {
      const outcome = mutationReconciler.applyReadResult(
        snapshot,
        monthData,
        monthData.monthStart,
      );
      if (outcome.reconciledSubjects.size > 0) {
        setMutationNotice('اتحفظ التعديل');
      }
      return outcome;
    },
    [mutationReconciler],
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
  const storedCompletes =
    heldEpoch < 0 ? [] : listHeldWritesByPrefix(EXPENSE_COMPLETE_PREFIX);
  const storedCategories =
    heldEpoch < 0 ? [] : listHeldWritesByPrefix(EXPENSE_CATEGORY_PREFIX);
  const recoverableMutations =
    heldEpoch < 0 || reconcileEpoch < 0
      ? []
      : mutationReconciler.listRecoverablePins();
  const inflightVoid =
    storedVoids.some((record) => record.phase === 'inflight') ||
    storedCompletes.some(
      (record) =>
        record.phase === 'inflight' &&
        !recoverableMutations.some(
          (pin) =>
            pin.acknowledged &&
            pin.subject === record.subject &&
            pin.requestId === record.requestId,
        ),
    ) ||
    storedCategories.some(
      (record) =>
        record.phase === 'inflight' &&
        !recoverableMutations.some(
          (pin) =>
            pin.acknowledged &&
            pin.subject === record.subject &&
            pin.requestId === record.requestId,
        ),
    );
  const expenseReloadMarkers =
    heldEpoch < 0 ? [] : listReloadMarkers(EXPENSE_RELOAD_SUBJECT);

  function postedReloadForTarget(target: string): boolean {
    if (heldEpoch < 0 || reconcileEpoch < 0) return false;
    const matchesTarget = (readTarget: string | undefined) =>
      target === '*' ||
      !readTarget ||
      readTarget === '*' ||
      readTarget === target;
    return (
      (storedExpense?.phase === 'posted_reload' &&
        matchesTarget(storedExpense.readTarget)) ||
      expenseReloadMarkers.some((marker) => matchesTarget(marker.target)) ||
      storedVoids.some(
        (record) =>
          record.phase === 'posted_reload' && matchesTarget(record.readTarget),
      ) ||
      storedCompletes.some(
        (record) =>
          record.phase === 'posted_reload' && matchesTarget(record.readTarget),
      ) ||
      storedCategories.some((record) => record.phase === 'posted_reload') ||
      mutationReconciler.hasAcknowledgedClaim(
        target === '*' ? undefined : target,
      )
    );
  }

  const monthStart = `${month}-01`;
  const postedReloadForCurrentMonth = postedReloadForTarget(monthStart);

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
    const displayedMonthStart = `${month}-01`;
    const pendingReloads = snapshotExpensePostedReloads();
    const mutationSnap =
      mutationReconciler.snapshotBeforeRead(displayedMonthStart);
    void (async () => {
      try {
        const next = await readMonth(month);
        if (cancelled || !next) return;
        setData(next);
        setLoadError(null);
        reconcileCommittedVoids(next.entries);
        applyMutationRead(mutationSnap, next);
        clearPostedReloadSnapshot(pendingReloads, next.monthStart);
        needsReloadRef.current = false;
        setLocalNeedsReload(false);
        // Resume any outstanding request-less target reads (reload markers,
        // unknown pins, or acknowledged inflight claims targeting other months).
        const otherTargets = mutationReconciler.outstandingTargets(
          next.monthStart,
        );
        if (otherTargets.length > 0) {
          await Promise.all(
            otherTargets.map(async (targetMonth) => {
              const targetReloads = snapshotExpensePostedReloads();
              const targetPinSnap =
                mutationReconciler.snapshotBeforeRead(targetMonth);
              try {
                const targeted = await loadExpenseMonth(targetMonth);
                if (cancelled) return;
                applyMutationRead(targetPinSnap, targeted);
                clearPostedReloadSnapshot(targetReloads, targeted.monthStart);
              } catch {
                if (!cancelled) {
                  mutationReconciler.applyReadFailure(targetPinSnap);
                }
              }
            }),
          );
        }
      } catch (error) {
        mutationReconciler.applyReadFailure(mutationSnap);
        if (cancelled) return;
        setLoadError(messageFrom(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [month, loadId, applyMutationRead, mutationReconciler]);

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
        // If the write targeted a different month than the one displayed (e.g.
        // replaying January while viewing November), read the pin's OWN target
        // first so its reload marker / acknowledged claim clears immediately.
        if (
          effectiveTarget !== '*' &&
          effectiveTarget !== displayedMonthStart
        ) {
          const targetReloads = snapshotExpensePostedReloads();
          const targetPinSnap =
            mutationReconciler.snapshotBeforeRead(effectiveTarget);
          try {
            const targeted = await loadExpenseMonth(effectiveTarget);
            applyMutationRead(targetPinSnap, targeted);
            clearPostedReloadSnapshot(targetReloads, targeted.monthStart);
          } catch (targetError) {
            mutationReconciler.applyReadFailure(targetPinSnap);
            throw targetError;
          }
          needsReloadRef.current = false;
          setLocalNeedsReload(false);
          // Best-effort refresh of the currently displayed month too.
          const displayedReloads = snapshotExpensePostedReloads();
          const displayedPinSnap =
            mutationReconciler.snapshotBeforeRead(displayedMonthStart);
          try {
            const next = await readMonth(monthRef.current);
            if (next) {
              setData(next);
              setLoadError(null);
              reconcileCommittedVoids(next.entries);
              applyMutationRead(displayedPinSnap, next);
              clearPostedReloadSnapshot(displayedReloads, next.monthStart);
            }
          } catch (displayError) {
            mutationReconciler.applyReadFailure(displayedPinSnap);
            setLoadError(messageFrom(displayError));
          }
        } else {
          const pendingReloads = snapshotExpensePostedReloads();
          const pinSnap =
            mutationReconciler.snapshotBeforeRead(displayedMonthStart);
          let next: ExpenseMonth | null;
          try {
            next = await readMonth(monthRef.current);
          } catch (readError) {
            mutationReconciler.applyReadFailure(pinSnap);
            throw readError;
          }
          if (next) {
            setData(next);
            setLoadError(null);
            reconcileCommittedVoids(next.entries);
            applyMutationRead(pinSnap, next);
            clearPostedReloadSnapshot(pendingReloads, next.monthStart);
            needsReloadRef.current = false;
            setLocalNeedsReload(false);
          }
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

  async function runClaimedMutation(
    subject: string,
    kind: HeldWriteKind,
    readTarget: string,
    intent: StoredExpenseMutationIntent,
    action: () => Promise<void>,
    setError: (message: string | null) => void,
    replayPin?: RequestlessPin<StoredExpenseMutationIntent>,
  ): Promise<boolean> {
    if (
      savingRef.current ||
      needsReloadRef.current ||
      postedReloadForTarget(readTarget) ||
      readsRef.current > 0 ||
      !isOnline()
    ) {
      return false;
    }
    setMutationNotice(null);
    const session = captureWriteSession();
    const claimed = replayPin
      ? await mutationReconciler.claimReplay(replayPin, session)
      : await mutationReconciler.claimFresh(subject, kind, intent, session);
    if (!claimed.ok) {
      if (claimed.reason === 'storage' || claimed.reason === 'missing') {
        setError(storageWriteFailedMessage);
      } else if (claimed.reason === 'session_invalid' && !isOnline()) {
        setError(offlineWriteMessage);
      }
      return false;
    }
    const { requestId, attempt, releaseOnce } = claimed;
    try {
      const result = await runWrite(
        action,
        setError,
        () => {
          mutationReconciler.markAcknowledged(
            subject,
            requestId,
            intent,
            attempt,
          );
        },
        { subject, requestId, session, readTarget },
      );
      if (!result.dispatched) {
        abortClaimBeforeDispatch(
          subject,
          requestId,
          replayPin ? 'unknown' : null,
          releaseOnce,
        );
        return false;
      }
      if (!result.saved && result.error) {
        const verifyMonth =
          intent.kind === 'complete'
            ? intent.monthStart
            : `${monthRef.current}-01`;
        const outcome = await mutationReconciler.settleFailure({
          subject,
          requestId,
          target: readTarget,
          error: result.error,
          releaseOnce,
          readState: () => loadExpenseMonth(verifyMonth),
          onReadData: (fresh) => {
            if (fresh.monthStart === `${monthRef.current}-01`) {
              setData(fresh);
              setLoadError(null);
            }
          },
          loadedTargetOf: (fresh) => fresh.monthStart,
        });
        if (outcome.status === 'reconciled_saved') {
          setError(null);
          setMutationNotice('اتحفظ التعديل');
          return true;
        }
        return false;
      }
      return result.saved;
    } finally {
      releaseOnce();
    }
  }

  function replayUnknownMutation(
    pin: RequestlessPin<StoredExpenseMutationIntent>,
  ): void {
    const intent = pin.intent;
    if (intent.kind === 'complete') {
      void runClaimedMutation(
        pin.subject,
        'expense_complete',
        intent.monthStart,
        intent,
        () => setMonthExpenseComplete(intent.monthStart, intent.complete),
        setListError,
        pin,
      );
      return;
    }
    if (intent.kind === 'category_add') {
      void runClaimedMutation(
        pin.subject,
        'expense_category',
        '*',
        intent,
        () => addExpenseCategory(intent.name, intent.categoryKind),
        setCategoryError,
        pin,
      );
      return;
    }
    if (intent.kind === 'category_rename') {
      void runClaimedMutation(
        pin.subject,
        'expense_category',
        '*',
        intent,
        () => renameExpenseCategory(intent.categoryId, intent.name),
        setCategoryError,
        pin,
      );
      return;
    }
    void runClaimedMutation(
      pin.subject,
      'expense_category',
      '*',
      intent,
      () => setExpenseCategoryActive(intent.categoryId, intent.active),
      setCategoryError,
      pin,
    );
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
      {mutationNotice ? <p role="status">{mutationNotice}</p> : null}
      {recoverableMutations.length > 0 ? (
        <section
          aria-label="تعديلات مصاريف مش متأكد إنها اتسجلت"
          className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
        >
          {recoverableMutations.map((pin) => {
            const replayReady = mutationReconciler.canReplay(pin);
            const isComplete = pin.intent.kind === 'complete';
            return (
              <div key={pin.subject} className="flex flex-col gap-1">
                <p role="status">
                  {pin.acknowledged
                    ? isComplete
                      ? 'تأكيد الشهر اتحفظ وجاري التحقق من التحديث'
                      : 'تعديل التصنيف اتحفظ وجاري التحقق من التحديث'
                    : isComplete
                      ? 'تأكيد الشهر مش متأكد إنه اتسجل'
                      : 'تعديل التصنيف مش متأكد إنه اتسجل'}
                </p>
                {replayReady ? (
                  <button
                    className={secondaryButton}
                    type="button"
                    disabled={
                      saving ||
                      inflightExpense ||
                      inflightVoid ||
                      localNeedsReload ||
                      postedReloadForTarget(pin.target) ||
                      readLoads > 0 ||
                      !online
                    }
                    onClick={() => replayUnknownMutation(pin)}
                  >
                    {isComplete
                      ? 'إعادة محاولة تأكيد الشهر'
                      : 'إعادة محاولة حفظ التصنيف'}
                  </button>
                ) : (
                  <button
                    className={secondaryButton}
                    type="button"
                    disabled={saving || readLoads > 0 || !online}
                    onClick={retry}
                  >
                    التحقق من حالة الحفظ
                  </button>
                )}
              </div>
            );
          })}
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
              disabled={writeDisabled}
              onChange={(event) => {
                const nextChecked = event.target.checked;
                void runClaimedMutation(
                  `${EXPENSE_COMPLETE_PREFIX}${monthStart}`,
                  'expense_complete',
                  monthStart,
                  { kind: 'complete', monthStart, complete: nextChecked },
                  () => setMonthExpenseComplete(monthStart, nextChecked),
                  setListError,
                );
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
            disabled={writeDisabled}
            serverError={categoryError}
            onAdd={(name, kind: ExpenseKind) =>
              runClaimedMutation(
                `${EXPENSE_CATEGORY_PREFIX}add`,
                'expense_category',
                '*',
                { kind: 'category_add', name, categoryKind: kind },
                () => addExpenseCategory(name, kind),
                setCategoryError,
              )
            }
            onRename={(id, name) =>
              void runClaimedMutation(
                `${EXPENSE_CATEGORY_PREFIX}rename:${id}`,
                'expense_category',
                '*',
                { kind: 'category_rename', categoryId: id, name },
                () => renameExpenseCategory(id, name),
                setCategoryError,
              )
            }
            onSetActive={(id, active) =>
              void runClaimedMutation(
                `${EXPENSE_CATEGORY_PREFIX}active:${id}`,
                'expense_category',
                '*',
                { kind: 'category_active', categoryId: id, active },
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
