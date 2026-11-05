import { useEffect, useRef, useState, type FormEvent } from 'react';
import { currentMinuteMs } from '@/items/effective';
import { messageFrom } from '@/items/errors';
import {
  beginAction,
  hasAction,
  settleAction,
  subscribeHeldWrites,
  unknownAction,
} from '@/items/request-id';
import { UnknownSave } from '@/items/UnknownSave';
import { useDatedTiming } from '@/items/useDatedTiming';
import { setRecipeVersion } from '@/recipes/api';
import { sourceChangedMessage } from '@/recipes/labels';
import { LinesTable } from '@/recipes/LinesTable';
import {
  linesFromVersion,
  validateBatch,
  validateLines,
  type LineDraft,
} from '@/recipes/lines';
import { RecipePreview } from '@/recipes/RecipePreview';
import { versionAt } from '@/recipes/schedule';
import { recipeVersionSubject } from '@/recipes/subjects';
import type {
  RecipeCatalog,
  RecipeRecord,
  RecipeSchedule,
  RecipeWrite,
} from '@/recipes/types';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';
const primaryButton =
  'w-fit rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60';
const secondaryButton =
  'w-fit rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

/** The one outstanding version write of a recipe, kept in the module map. */
type VersionAction = { recipeId: string; write: RecipeWrite };

export function VersionEditor({
  recipe,
  schedule,
  catalog,
  locked,
  onBusyChange,
  onReload,
}: {
  recipe: RecipeRecord;
  schedule: RecipeSchedule;
  catalog: RecipeCatalog;
  /** Another section of the page is saving. */
  locked: boolean;
  onBusyChange: (busy: boolean) => void;
  /** Re-reads the schedule. Never rejects; the page shows its own load error. */
  onReload: () => Promise<void>;
}) {
  const subject = recipeVersionSubject(recipe.id);
  const [mountNow] = useState(() => currentMinuteMs(Date.now()));
  const [heldEpoch, setHeldEpoch] = useState(0);
  const [saving, setSaving] = useState(false);
  const flight = useRef(false);
  const held = heldEpoch < 0 ? null : unknownAction<VersionAction>(subject);
  const disabled = locked || saving || held !== null;
  const timing = useDatedTiming(
    undefined,
    catalog.shiftStart,
    schedule.versions,
    schedule.token,
    disabled,
  );
  const atMs = timing.instantMs ?? mountNow;
  const covering = versionAt(schedule.versions, atMs);
  const seedKey = `${covering?.id ?? ''}|${schedule.token}`;
  const [seeded, setSeeded] = useState({
    key: seedKey,
    versionId: covering?.id ?? null,
  });
  const [dirty, setDirty] = useState(false);
  const [drafts, setDrafts] = useState<LineDraft[]>(() =>
    linesFromVersion(covering),
  );
  const [batchQty, setBatchQty] = useState(covering?.batchQty ?? '');
  const [batchUnit, setBatchUnit] = useState(covering?.batchUnit ?? '');
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (seeded.key !== seedKey && !dirty) {
    setSeeded({ key: seedKey, versionId: covering?.id ?? null });
    setDrafts(linesFromVersion(covering));
    setBatchQty(covering?.batchQty ?? '');
    setBatchUnit(covering?.batchUnit ?? '');
  }

  useEffect(
    () => subscribeHeldWrites(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  async function finish(action: VersionAction) {
    if (flight.current) return;
    flight.current = true;
    setSaving(true);
    onBusyChange(true);
    setError(null);
    setNotice(null);
    try {
      await setRecipeVersion(action.recipeId, action.write);
      settleAction(subject);
      setDirty(false);
      setConfirmStop(false);
      timing.refreshClock();
      setNotice(
        action.write.lines === null
          ? 'الوصفة اتوقفت من الوقت ده'
          : 'نسخة الوصفة اتحفظت',
      );
      await onReload();
    } catch (failure) {
      settleAction(subject, failure);
      setError(messageFrom(failure));
      if (!hasAction(subject)) await onReload();
    } finally {
      flight.current = false;
      setSaving(false);
      onBusyChange(false);
    }
  }

  function begin(
    lines: RecipeWrite['lines'],
    batch: { batchQty: string; batchUnit: string } | null,
  ) {
    if (disabled || flight.current || hasAction(subject)) return;
    const built = timing.build();
    if (!built.ok) {
      setError(built.error);
      return;
    }
    // Compare with the version that seeded the draft, not the one on screen:
    // a refused submit can move the clock while an edited draft stays put.
    const inForce = versionAt(schedule.versions, built.instantMs ?? atMs);
    if ((inForce?.id ?? null) !== seeded.versionId) {
      setSeeded({
        key: `${inForce?.id ?? ''}|${schedule.token}`,
        versionId: inForce?.id ?? null,
      });
      setDirty(false);
      setConfirmStop(false);
      setDrafts(linesFromVersion(inForce));
      setBatchQty(inForce?.batchQty ?? '');
      setBatchUnit(inForce?.batchUnit ?? '');
      setError(sourceChangedMessage);
      return;
    }
    setError(null);
    const action = beginAction<VersionAction>(subject, (requestId) => ({
      recipeId: recipe.id,
      write: {
        requestId,
        effectiveFrom: built.write.effectiveFrom,
        effectiveTo: built.write.effectiveTo,
        batchQty: batch?.batchQty ?? null,
        batchUnit: batch?.batchUnit ?? null,
        lines,
        reason: built.write.reason,
        token: built.write.token,
      },
    }));
    void finish(action);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || flight.current || hasAction(subject)) return;
    const checked = validateLines(drafts);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    if (recipe.kind !== 'batch') {
      begin(checked.lines, null);
      return;
    }
    const batch = validateBatch(batchQty, batchUnit);
    if (!batch.ok) {
      setError(batch.error);
      return;
    }
    begin(checked.lines, batch);
  }

  function retry() {
    if (!held || locked || flight.current) return;
    void finish(held);
  }

  const batchUnits =
    recipe.kind === 'batch'
      ? catalog.units.map((unit) => ({ code: unit.code, label: unit.labelAr }))
      : [];

  return (
    <>
      <form
        className="flex flex-col gap-3"
        aria-label="نسخة الوصفة"
        onSubmit={onSubmit}
      >
        <h2 className="text-xl font-semibold">نسخة الوصفة</h2>
        {covering ? null : <p>مفيش نسخة سارية في الوقت المختار</p>}
        {recipe.kind === 'batch' ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              كمية التحضيرة
              <input
                className={fieldClass}
                dir="ltr"
                inputMode="decimal"
                disabled={disabled}
                value={batchQty}
                onChange={(event) => {
                  if (disabled) return;
                  setDirty(true);
                  setBatchQty(event.target.value);
                }}
              />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              وحدة التحضيرة
              <select
                className={fieldClass}
                disabled={disabled}
                value={batchUnit}
                onChange={(event) => {
                  if (disabled) return;
                  setDirty(true);
                  setBatchUnit(event.target.value);
                }}
              >
                <option value="">اختار الوحدة</option>
                {batchUnits.map((unit) => (
                  <option key={unit.code} value={unit.code}>
                    {unit.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        <LinesTable
          drafts={drafts}
          recipe={recipe}
          catalog={catalog}
          atMs={atMs}
          disabled={disabled}
          onChange={(next) => {
            setDirty(true);
            setDrafts(next);
          }}
        />
        {timing.fields}
        {held ? <UnknownSave disabled={locked} onRetry={retry} /> : null}
        {error ? <p role="alert">{error}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {confirmStop ? (
          <div className="flex flex-col gap-2 rounded border border-neutral-300 p-3">
            <p>
              الوصفة هتتوقف من الوقت ده، ومش هتتحسب لحد ما تحدد نسخة جديدة.
              تأكيد؟
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                className={primaryButton}
                type="button"
                disabled={disabled}
                onClick={() => begin(null, null)}
              >
                أيوه، وقّف الوصفة
              </button>
              <button
                className={secondaryButton}
                type="button"
                disabled={disabled}
                onClick={() => setConfirmStop(false)}
              >
                لأ
              </button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button className={primaryButton} type="submit" disabled={disabled}>
            احفظ النسخة
          </button>
          <button
            className={secondaryButton}
            type="button"
            disabled={disabled || covering === null || confirmStop}
            onClick={() => setConfirmStop(true)}
          >
            وقّف الوصفة من الوقت ده
          </button>
        </div>
      </form>
      <RecipePreview
        recipe={recipe}
        version={covering}
        catalog={catalog}
        atMs={atMs}
        refreshKey={schedule.token}
      />
    </>
  );
}
