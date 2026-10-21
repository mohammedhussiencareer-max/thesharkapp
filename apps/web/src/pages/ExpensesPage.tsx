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
import type { ExpenseDraft, ExpenseKind, ExpenseMonth } from '@/expenses/types';
import { fieldClass } from '@/expenses/labels';
import { messageFrom } from '@/items/errors';
import { cairoMonthInput, formatCairo, formatMonth } from '@/lib/cairo';
import { pageShell, secondaryButton } from '@/lib/page-style';

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
  const voidRequestIds = useRef(new Map<string, string>());
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
  ): Promise<boolean> {
    if (savingRef.current || needsReloadRef.current || readsRef.current > 0) {
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    let saved = false;
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
        setLoadError(messageFrom(error));
      }
    } catch (error) {
      if (!saved) setError(messageFrom(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    return saved;
  }

  async function submitExpense(draft: ExpenseDraft) {
    const saved = await runWrite(() => addExpenseEntry(draft), setFormError);
    if (saved) setFormEpoch((value) => value + 1);
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
            onVoid={(id, reason) => {
              const existing = voidRequestIds.current.get(id);
              const requestId = existing ?? crypto.randomUUID();
              if (!existing) voidRequestIds.current.set(id, requestId);
              void runWrite(async () => {
                await voidExpenseEntry(id, reason, requestId);
                voidRequestIds.current.delete(id);
              }, setListError);
            }}
          />
          <AllocationTable days={data.days} />
          <CategoryManager
            categories={data.categories}
            disabled={busy}
            serverError={categoryError}
            onAdd={(name, kind: ExpenseKind) =>
              void runWrite(
                () => addExpenseCategory(name, kind),
                setCategoryError,
              )
            }
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
