import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  messageFrom,
  StaleWriteError,
  staleWriteMessage,
} from '@/items/errors';
import {
  beginAction,
  hasAction,
  settleAction,
  subscribeHeldWrites,
  unknownAction,
} from '@/items/request-id';
import { UnknownSave } from '@/items/UnknownSave';
import { updateRecipe, type RecipeUpdate } from '@/recipes/api';
import { recipeKindLabels } from '@/recipes/labels';
import { recipeUpdateSubject } from '@/recipes/subjects';
import type { RecipeRecord } from '@/recipes/types';
import { validateRecipeName } from '@/recipes/validation';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';
const primaryButton =
  'w-fit rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60';

/** The one outstanding rename or active change of a recipe. */
type DetailsAction = { recipeId: string; update: RecipeUpdate };

export function RecipeDetails({
  recipe,
  locked,
  onBusyChange,
  onReload,
}: {
  recipe: RecipeRecord;
  /** Another section of the page is saving. */
  locked: boolean;
  onBusyChange: (busy: boolean) => void;
  /** Re-reads the recipe. Resolves to null when the read failed. */
  onReload: () => Promise<RecipeRecord | null>;
}) {
  const subject = recipeUpdateSubject(recipe.id);
  const [expected, setExpected] = useState(recipe);
  const [name, setName] = useState(recipe.name);
  const [active, setActive] = useState(recipe.active);
  const [heldEpoch, setHeldEpoch] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const flight = useRef(false);
  const held = heldEpoch < 0 ? null : unknownAction<DetailsAction>(subject);
  const disabled = locked || saving || held !== null;

  useEffect(
    () => subscribeHeldWrites(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  function adopt(next: RecipeRecord) {
    setExpected(next);
    setName(next.name);
    setActive(next.active);
  }

  async function finish(action: DetailsAction) {
    if (flight.current) return;
    flight.current = true;
    setSaving(true);
    onBusyChange(true);
    setError(null);
    setNotice(null);
    try {
      await updateRecipe(action.recipeId, action.update);
      settleAction(subject);
      const fresh = await onReload();
      adopt(
        fresh ?? {
          ...expected,
          name: action.update.name.trim(),
          active: action.update.active,
        },
      );
      setNotice('الوصفة اتحفظت');
    } catch (failure) {
      settleAction(subject, failure);
      if (failure instanceof StaleWriteError) {
        const fresh = await onReload();
        if (fresh) adopt(fresh);
        setError(staleWriteMessage);
      } else {
        setError(messageFrom(failure));
      }
    } finally {
      flight.current = false;
      setSaving(false);
      onBusyChange(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || flight.current || hasAction(subject)) return;
    const invalid = validateRecipeName(name);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (name.trim() === expected.name && active === expected.active) {
      setError(null);
      setNotice('مفيش تغيير للحفظ');
      return;
    }
    const action = beginAction<DetailsAction>(subject, (requestId) => ({
      recipeId: recipe.id,
      update: {
        requestId,
        name,
        active,
        expectedName: expected.name,
        expectedActive: expected.active,
      },
    }));
    void finish(action);
  }

  function retry() {
    if (!held || locked || flight.current) return;
    void finish(held);
  }

  return (
    <form
      className="flex flex-col gap-3"
      aria-label="بيانات الوصفة"
      onSubmit={onSubmit}
    >
      <h2 className="text-xl font-semibold">بيانات الوصفة</h2>
      <p>النوع: {recipeKindLabels[recipe.kind]}</p>
      <label className="flex flex-col gap-1">
        اسم الوصفة
        <input
          className={fieldClass}
          autoComplete="off"
          disabled={disabled}
          value={name}
          onChange={(event) => {
            if (disabled) return;
            setName(event.target.value);
          }}
        />
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          disabled={disabled}
          checked={active}
          onChange={(event) => {
            if (disabled) return;
            setActive(event.target.checked);
          }}
        />
        شغالة
      </label>
      {held ? <UnknownSave disabled={locked} onRetry={retry} /> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <button className={primaryButton} type="submit" disabled={disabled}>
        احفظ البيانات
      </button>
    </form>
  );
}
