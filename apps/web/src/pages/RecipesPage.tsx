import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { genericCatalogError, messageFrom } from '@/items/errors';
import { subscribeHeldWrites, unknownAction } from '@/items/request-id';
import { UnknownSave } from '@/items/UnknownSave';
import { pageShell, primaryButton, secondaryButton } from '@/lib/page-style';
import { createRecipe, listRecipes } from '@/recipes/api';
import {
  inForceLabel,
  noVersionLabel,
  recipeKindLabels,
} from '@/recipes/labels';
import { recipeCreateSubject } from '@/recipes/subjects';
import {
  isRecipeKind,
  recipeKinds,
  type RecipeKind,
  type RecipeSummary,
} from '@/recipes/types';
import { validateRecipeName } from '@/recipes/validation';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';

type Draft = { name: string; kind: RecipeKind };

function isKindFilter(value: string): value is 'all' | RecipeKind {
  return value === 'all' || isRecipeKind(value);
}

export function RecipesPage() {
  const navigate = useNavigate();
  const [recipes, setRecipes] = useState<RecipeSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const [kindFilter, setKindFilter] = useState<'all' | RecipeKind>('all');
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<RecipeKind>('dish');
  const [submitted, setSubmitted] = useState<Draft | null>(null);
  const [heldEpoch, setHeldEpoch] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const flight = useRef(false);
  const held =
    submitted === null || heldEpoch < 0
      ? null
      : unknownAction<string>(
          recipeCreateSubject(submitted.name, submitted.kind),
        );
  const formDisabled = creating || held !== null;

  useEffect(
    () => subscribeHeldWrites(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await listRecipes();
        if (cancelled) return;
        setRecipes(next);
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
  }, [loadId]);

  function retry() {
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  async function send(draft: Draft) {
    if (flight.current) return;
    flight.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const recipeId = await createRecipe(draft.name, draft.kind);
      setSubmitted(null);
      void navigate(`/recipes/${recipeId}`);
    } catch (error) {
      setCreateError(messageFrom(error));
    } finally {
      flight.current = false;
      setCreating(false);
    }
  }

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (formDisabled || flight.current) return;
    const invalid = validateRecipeName(name);
    if (invalid) {
      setCreateError(invalid);
      return;
    }
    const draft = { name: name.trim(), kind };
    setSubmitted(draft);
    void send(draft);
  }

  const needle = search.trim().toLowerCase();
  const visible = (recipes ?? []).filter(
    (recipe) =>
      (kindFilter === 'all' || recipe.kind === kindFilter) &&
      recipe.name.toLowerCase().includes(needle),
  );

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">الوصفات</h1>
      <p>
        <Link className="underline" to="/recipes/import">
          استيراد الوصفات
        </Link>
      </p>
      {loading && recipes === null ? <p>جاري تحميل الوصفات…</p> : null}
      {recipes === null && !loading ? (
        <div className="flex flex-col gap-3">
          <p role="alert">{loadError ?? genericCatalogError}</p>
          <button className={secondaryButton} type="button" onClick={retry}>
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {recipes !== null ? (
        <>
          {loadError ? (
            <div className="flex flex-col gap-2">
              <p role="alert">{loadError}</p>
              <button className={secondaryButton} type="button" onClick={retry}>
                إعادة المحاولة
              </button>
            </div>
          ) : null}
          <form
            className="flex flex-col gap-3 rounded border border-neutral-200 p-3"
            aria-label="وصفة جديدة"
            onSubmit={onCreate}
          >
            <h2 className="text-lg font-semibold">وصفة جديدة</h2>
            <label className="flex flex-col gap-1">
              اسم الوصفة الجديدة
              <input
                className={fieldClass}
                autoComplete="off"
                disabled={formDisabled}
                value={name}
                onChange={(event) => {
                  if (formDisabled) return;
                  setName(event.target.value);
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              نوع الوصفة الجديدة
              <select
                className={fieldClass}
                disabled={formDisabled}
                value={kind}
                onChange={(event) => {
                  if (formDisabled) return;
                  const next = event.target.value;
                  if (isRecipeKind(next)) setKind(next);
                }}
              >
                {recipeKinds.map((value) => (
                  <option key={value} value={value}>
                    {recipeKindLabels[value]}
                  </option>
                ))}
              </select>
            </label>
            {held && submitted ? (
              <UnknownSave
                disabled={creating}
                onRetry={() => void send(submitted)}
              />
            ) : null}
            {createError ? <p role="alert">{createError}</p> : null}
            <button
              className={primaryButton}
              type="submit"
              disabled={formDisabled}
            >
              ضيف وصفة
            </button>
          </form>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              بحث بالاسم
              <input
                className={fieldClass}
                autoComplete="off"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              تصفية بالنوع
              <select
                className={fieldClass}
                value={kindFilter}
                onChange={(event) => {
                  if (isKindFilter(event.target.value)) {
                    setKindFilter(event.target.value);
                  }
                }}
              >
                <option value="all">كل الأنواع</option>
                {recipeKinds.map((value) => (
                  <option key={value} value={value}>
                    {recipeKindLabels[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {recipes.length === 0 ? (
            <p>لسه مفيش وصفات — ضيف أول وصفة</p>
          ) : visible.length === 0 ? (
            <p>مفيش وصفات مطابقة</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="الوصفات">
              {visible.map((recipe) => (
                <li
                  key={recipe.id}
                  className="flex flex-col gap-1 rounded border border-neutral-200 p-3"
                >
                  <Link
                    className="w-fit text-lg font-semibold underline"
                    to={`/recipes/${recipe.id}`}
                  >
                    {recipe.name}
                  </Link>
                  <p>
                    {recipeKindLabels[recipe.kind]}
                    {recipe.active ? '' : ' — موقوفة'}
                  </p>
                  <p>
                    النسخة: {recipe.inForce ? inForceLabel : noVersionLabel}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </main>
  );
}
