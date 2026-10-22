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
import type { ExpenseDraft, ExpenseKind, ExpenseMonth } from '@/expenses/types';
import { fieldClass } from '@/expenses/labels';
import { messageFrom } from '@/items/errors';
import { cairoMonthInput, formatCairo, formatMonth } from '@/lib/cairo';
import { pageShell, secondaryButton } from '@/lib/page-style';

type VoidAttempt = { requestId: string; reason: string };

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

/**
 * A pin stays until this exact payload succeeds or the same replay is refused
 * by a rule the payload itself breaks. A permission or contention error can
 * fire before the server's request_id replay, so it leaves the original
 * unknown and keeps the pin. The first attempt pins only an unknown outcome.
 */
function pinnedAfter<T>(
  current: T | null,
  attempt: T,
  error: unknown,
): T | null {
  if (current && current !== attempt) return current;
  if (current) return isPayloadRefusal(error) ? null : current;
  return isUnknownOutcome(error) ? attempt : null;
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
  const [needsReload, setNeedsReload] = useState(false);
  const [readLoads, setReadLoads] = useState(0);
  const [loadId, setLoadId] = useState(0);
  const [formEpoch, setFormEpoch] = useState(0);
  const [pendingExpense, setPendingExpense] = useState<ExpenseDraft | null>(
    null,
  );
  const [pendingVoids, setPendingVoids] = useState<
    ReadonlyMap<string, VoidAttempt>
  >(new Map());
  const pendingVoidsRef = useRef(pendingVoids);
  // Ids of voids that were sent and refused. A refusal is not stored, so a
  // correction reuses the id. Cleared once that void succeeds.
  const voidRequestIdsRef = useRef(new Map<string, string>());
  const seqRef = useRef(0);
  const readsRef = useRef(0);
  const savingRef = useRef(false);
  const needsReloadRef = useRef(false);

  const monthStart = `${month}-01`;
  const ready = data !== null && data.monthStart === monthStart;
  const writeLocked = saving || needsReload;
  const busy = writeLocked || readLoads > 0;

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
        needsReloadRef.current = false;
        setNeedsReload(false);
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
    if (savingRef.current || needsReloadRef.current) return;
    if (!/^\d{4}-\d{2}$/.test(next) || next === monthRef.current) return;
    monthRef.current = next;
    setLoadError(null);
    setMonth(next);
  }

  async function runWrite(
    action: () => Promise<void>,
    setError: (message: string | null) => void,
  ): Promise<WriteResult> {
    if (savingRef.current || needsReloadRef.current || readsRef.current > 0) {
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
      setNeedsReload(true);
      try {
        const next = await readMonth(monthRef.current);
        if (next) {
          setData(next);
          setLoadError(null);
          needsReloadRef.current = false;
          setNeedsReload(false);
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

  function clearVoidPin(id: string) {
    voidRequestIdsRef.current.delete(id);
    if (!pendingVoidsRef.current.has(id)) return;
    const done = new Map(pendingVoidsRef.current);
    done.delete(id);
    pendingVoidsRef.current = done;
    setPendingVoids(done);
  }

  function applyVoidPin(id: string, next: VoidAttempt | null) {
    const current = pendingVoidsRef.current.get(id) ?? null;
    if (next === current) return;
    const updated = new Map(pendingVoidsRef.current);
    if (next) updated.set(id, next);
    else updated.delete(id);
    pendingVoidsRef.current = updated;
    setPendingVoids(updated);
  }

  async function submitExpense(draft: ExpenseDraft) {
    const result = await runWrite(() => addExpenseEntry(draft), setFormError);
    if (result.saved) {
      setPendingExpense(null);
      setFormEpoch((value) => value + 1);
      return;
    }
    // Not sent: the form stays editable and nothing is pinned.
    if (!result.error) return;
    setFormError(reportedExpenseError(result.error));
    setPendingExpense((current) => pinnedAfter(current, draft, result.error));
  }

  async function voidEntry(id: string, typedReason: string) {
    const pinned = pendingVoidsRef.current.get(id) ?? null;
    const requestId =
      pinned?.requestId ??
      voidRequestIdsRef.current.get(id) ??
      crypto.randomUUID();
    const attempt = pinned ?? { requestId, reason: typedReason };
    const result = await runWrite(
      () => voidExpenseEntry(id, attempt.reason, attempt.requestId),
      setListError,
    );
    if (result.saved) {
      clearVoidPin(id);
      return;
    }
    // Not sent: leave an existing pin alone, and do not store this attempt.
    if (!result.error) return;
    voidRequestIdsRef.current.set(id, attempt.requestId);
    setListError(reportedExpenseError(result.error));
    const current = pendingVoidsRef.current.get(id) ?? null;
    applyVoidPin(id, pinnedAfter(current, attempt, result.error));
  }

  return (
    <main aria-busy={busy} className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">المصاريف</h1>
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
          disabled={busy || !ready}
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
              disabled={busy}
              onChange={(event) =>
                void runWrite(
                  () =>
                    setMonthExpenseComplete(monthStart, event.target.checked),
                  setListError,
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
            entries={data.entries}
            disabled={busy}
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
            disabled={busy}
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
