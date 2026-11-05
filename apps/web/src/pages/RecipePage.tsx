import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { currentShiftStart } from '@/items/api';
import { genericCatalogError, messageFrom } from '@/items/errors';
import { pageShell, secondaryButton } from '@/lib/page-style';
import {
  getRecipe,
  listBatchOptions,
  listItemUnits,
  listStockOptions,
  listUnitsMeta,
  recipeSchedule,
} from '@/recipes/api';
import { RecipeDetails } from '@/recipes/RecipeDetails';
import { RecipeHistory } from '@/recipes/RecipeHistory';
import { VersionEditor } from '@/recipes/VersionEditor';
import type {
  RecipeCatalog,
  RecipeRecord,
  RecipeSchedule,
} from '@/recipes/types';

type Busy = 'details' | 'version' | null;

function RecipeEditor({ recipeId }: { recipeId: string }) {
  const [recipe, setRecipe] = useState<RecipeRecord | null>(null);
  const [schedule, setSchedule] = useState<RecipeSchedule | null>(null);
  const [catalog, setCatalog] = useState<RecipeCatalog | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const scheduleSeq = useRef(0);
  const recipeSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [
          row,
          nextSchedule,
          stock,
          itemUnits,
          units,
          batches,
          shiftStart,
        ] = await Promise.all([
          getRecipe(recipeId),
          recipeSchedule(recipeId),
          listStockOptions(),
          listItemUnits(),
          listUnitsMeta(),
          listBatchOptions(),
          currentShiftStart(),
        ]);
        if (cancelled) return;
        setMissing(row === null);
        setRecipe(row);
        setSchedule(nextSchedule);
        setCatalog({ stock, itemUnits, units, batches, shiftStart });
        setLoadError(null);
      } catch (error) {
        if (!cancelled) setLoadError(messageFrom(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadId, recipeId]);

  const reloadSchedule = useCallback(async () => {
    const seq = ++scheduleSeq.current;
    try {
      const next = await recipeSchedule(recipeId);
      if (seq !== scheduleSeq.current) return;
      setSchedule(next);
      setLoadError(null);
    } catch (error) {
      if (seq === scheduleSeq.current) setLoadError(messageFrom(error));
    }
  }, [recipeId]);

  const reloadRecipe = useCallback(async (): Promise<RecipeRecord | null> => {
    const seq = ++recipeSeq.current;
    try {
      const next = await getRecipe(recipeId);
      if (seq !== recipeSeq.current) return null;
      if (next === null) {
        setMissing(true);
        return null;
      }
      setRecipe(next);
      setLoadError(null);
      return next;
    } catch (error) {
      if (seq === recipeSeq.current) setLoadError(messageFrom(error));
      return null;
    }
  }, [recipeId]);

  function retry() {
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  const ready = recipe !== null && schedule !== null && catalog !== null;

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/recipes">
          الوصفات
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">{recipe?.name ?? 'وصفة'}</h1>
      {loading && !ready ? <p>جاري تحميل الوصفة…</p> : null}
      {!ready && !loading && !missing ? (
        <div className="flex flex-col gap-3">
          <p role="alert">{loadError ?? genericCatalogError}</p>
          <button className={secondaryButton} type="button" onClick={retry}>
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {missing ? <p role="alert">الوصفة مش موجودة</p> : null}
      {ready && !missing ? (
        <>
          {loadError ? <p role="alert">{loadError}</p> : null}
          <RecipeDetails
            recipe={recipe}
            locked={busy === 'version'}
            onBusyChange={(on) => setBusy(on ? 'details' : null)}
            onReload={reloadRecipe}
          />
          <VersionEditor
            recipe={recipe}
            schedule={schedule}
            catalog={catalog}
            locked={busy === 'details'}
            onBusyChange={(on) => setBusy(on ? 'version' : null)}
            onReload={reloadSchedule}
          />
          <RecipeHistory schedule={schedule} />
        </>
      ) : null}
    </main>
  );
}

export function RecipePage() {
  const { recipeId = '' } = useParams();
  return <RecipeEditor key={recipeId} recipeId={recipeId} />;
}
