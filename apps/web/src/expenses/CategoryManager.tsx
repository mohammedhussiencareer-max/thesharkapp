import { useState, type FormEvent } from 'react';
import { fieldClass, kindLabels } from '@/expenses/labels';
import {
  expenseKinds,
  isExpenseKind,
  type ExpenseCategory,
  type ExpenseKind,
} from '@/expenses/types';
import { validateCategoryName } from '@/expenses/validation';
import { primaryButton, secondaryButton } from '@/lib/page-style';

export function CategoryManager({
  categories,
  disabled,
  serverError,
  onAdd,
  onRename,
  onSetActive,
}: {
  categories: readonly ExpenseCategory[];
  disabled: boolean;
  serverError: string | null;
  onAdd: (name: string, kind: ExpenseKind) => void;
  onRename: (id: string, name: string) => void;
  onSetActive: (id: string, active: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [nameError, setNameError] = useState<string | null>(null);
  const [kindError, setKindError] = useState<string | null>(null);
  const [renameErrors, setRenameErrors] = useState<Record<string, string>>({});

  function addCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const error = validateCategoryName(name);
    if (error || !isExpenseKind(kind)) {
      setNameError(error);
      setKindError(isExpenseKind(kind) ? null : 'اختار نوع التصنيف');
      return;
    }
    setNameError(null);
    setKindError(null);
    setName('');
    setKind('');
    onAdd(name.trim(), kind);
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">التصنيفات</h2>
      {serverError ? <p role="alert">{serverError}</p> : null}
      <form className="flex flex-col gap-3" noValidate onSubmit={addCategory}>
        <label className="flex flex-col gap-1">
          اسم التصنيف
          <input
            className={fieldClass}
            value={name}
            disabled={disabled}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {nameError ? <p role="alert">{nameError}</p> : null}
        <label className="flex flex-col gap-1">
          نوع التصنيف
          <select
            className={fieldClass}
            value={kind}
            disabled={disabled}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="">اختار النوع</option>
            {expenseKinds.map((value) => (
              <option key={value} value={value}>
                {kindLabels[value]}
              </option>
            ))}
          </select>
        </label>
        {kindError ? <p role="alert">{kindError}</p> : null}
        <button className={primaryButton} type="submit" disabled={disabled}>
          ضيف تصنيف
        </button>
      </form>
      <ul className="flex flex-col gap-3">
        {categories.map((category) => {
          const draft = drafts[category.id] ?? category.name;
          const renameError = renameErrors[category.id];
          const renameErrorId = `category-name-${category.id}-error`;
          return (
            <li key={category.id}>
              <article
                className="flex flex-col gap-2"
                aria-label={category.name}
              >
                <p>{kindLabels[category.kind]}</p>
                <p>{category.active ? 'شغال' : 'متوقف'}</p>
                <label className="flex flex-col gap-1">
                  {`اسم ${category.name}`}
                  <input
                    className={fieldClass}
                    value={draft}
                    disabled={disabled}
                    aria-invalid={renameError ? true : undefined}
                    aria-describedby={renameError ? renameErrorId : undefined}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [category.id]: event.target.value,
                      }))
                    }
                  />
                </label>
                {renameError ? (
                  <p id={renameErrorId} role="alert">
                    {renameError}
                  </p>
                ) : null}
                <button
                  className={secondaryButton}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    const error = validateCategoryName(draft);
                    if (error) {
                      setRenameErrors((current) => ({
                        ...current,
                        [category.id]: error,
                      }));
                      return;
                    }
                    setRenameErrors((current) => {
                      if (!(category.id in current)) return current;
                      const next = { ...current };
                      delete next[category.id];
                      return next;
                    });
                    const next = draft.trim();
                    if (next === category.name) return;
                    onRename(category.id, next);
                  }}
                >
                  {`حفظ اسم ${category.name}`}
                </button>
                <button
                  className={secondaryButton}
                  type="button"
                  disabled={disabled}
                  onClick={() => onSetActive(category.id, !category.active)}
                >
                  {category.active
                    ? `إيقاف ${category.name}`
                    : `تفعيل ${category.name}`}
                </button>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
