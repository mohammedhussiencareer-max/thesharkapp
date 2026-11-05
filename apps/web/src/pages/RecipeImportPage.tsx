import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { genericCatalogError, messageFrom } from '@/items/errors';
import {
  beginAction,
  hasAction,
  settleAction,
  subscribeHeldWrites,
  unknownAction,
} from '@/items/request-id';
import { UnknownSave } from '@/items/UnknownSave';
import { useDatedTiming } from '@/items/useDatedTiming';
import { pageShell, primaryButton, secondaryButton } from '@/lib/page-style';
import {
  commitRecipeImport,
  fetchImportTokens,
  loadImportContext,
  type ImportAction,
  type ImportResult,
} from '@/recipes/import/api';
import {
  buildReview,
  confirmSuggestions,
  disappearedRecipes,
  isKnownStructure,
  issueCount,
  summarize,
  validateReview,
  type ImportContext,
  type Review,
} from '@/recipes/import/model';
import {
  parseRecipeWorkbook,
  type ParsedWorkbook,
  type ParseWarning,
} from '@/recipes/import/parse';
import {
  buildImportPayload,
  requiredTokens,
  structuralHash,
} from '@/recipes/import/payload';
import { ReviewView } from '@/recipes/import/ReviewView';
import {
  maxWorkbookBytes,
  WorkbookReadError,
  workbookReadMessages,
} from '@/recipes/import/xlsx';
import { recipeImportSubject } from '@/recipes/subjects';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';

const warningMessages: Record<ParseWarning['code'], string> = {
  unknown_unit: 'وحدة مش معروفة في الملف، اتحسبت بدون وحدة',
  bad_quantity: 'كمية مش مفهومة، السطر اتخطى',
  no_quantity: 'سطر من غير كمية، اتخطى',
  no_ingredient_name: 'سطر من غير اسم مكوّن، اتخطى',
  bad_batch_qty: 'كمية صافي مش مفهومة، اكتب كمية التحضيرة بنفسك',
  conflicting_batch_qty: 'أكتر من كمية صافي مختلفة، اكتب كمية التحضيرة بنفسك',
  no_header: 'مفيش صف عناوين للمكونات',
  empty_block: 'وصفة من غير مكونات',
  unnamed_block: 'وصفة من غير اسم',
  duplicate_block: 'اسم وصفة متكرر في الملف',
  loss_out_of_range: 'نسبة فاقد خارج المدى، اتخطت',
  duplicate_loss: 'مكوّن له أكتر من نسبة فاقد',
  no_loss_table: 'مفيش جدول فاقد في الملف',
};

const countLabels: Record<string, string> = {
  items_created: 'أصناف جديدة',
  recipes_created: 'وصفات جديدة',
  versions_published: 'نسخ وصفات اتحفظت',
  recipes_unchanged: 'وصفات من غير تغيير',
  losses_set: 'نسب فاقد اتحفظت',
  losses_unchanged: 'نسب فاقد من غير تغيير',
  opening_prices_set: 'أسعار افتتاحية',
  bindings: 'أسماء اتربطت',
};

function readBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const { result } = reader;
      if (result === null || typeof result === 'string') {
        reject(new Error('read failed'));
      } else {
        resolve(new Uint8Array(result));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

type Loaded = {
  fileName: string;
  parsed: ParsedWorkbook;
  hash: string;
  review: Review;
};

function Workspace({
  ctx,
  reload,
}: {
  ctx: ImportContext;
  reload: () => Promise<void>;
}) {
  const subject = recipeImportSubject;
  const [heldEpoch, setHeldEpoch] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const flight = useRef(false);
  const held = heldEpoch < 0 ? null : unknownAction<ImportAction>(subject);
  const disabled = saving || reading || stale || held !== null;
  const timing = useDatedTiming(
    undefined,
    ctx.shiftStart,
    [],
    '',
    disabled,
    'now',
  );

  useEffect(
    () => subscribeHeldWrites(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  const issues = useMemo(
    () => (loaded ? validateReview(loaded.review, loaded.parsed, ctx) : null),
    [loaded, ctx],
  );
  const summary = loaded ? summarize(loaded.review, loaded.parsed) : null;
  const gone = useMemo(
    () => (loaded ? disappearedRecipes(loaded.parsed, ctx) : []),
    [loaded, ctx],
  );

  async function onFile(file: File | undefined) {
    setResult(null);
    setError(null);
    setFileError(null);
    setShowIssues(false);
    setLoaded(null);
    if (!file) return;
    if (file.size > maxWorkbookBytes) {
      setFileError(workbookReadMessages.too_large);
      return;
    }
    setReading(true);
    try {
      const bytes = await readBytes(file);
      const parsed = parseRecipeWorkbook(bytes);
      const hash = await structuralHash(parsed);
      setLoaded({
        fileName: file.name,
        parsed,
        hash,
        review: buildReview(parsed, ctx),
      });
    } catch (failure) {
      setFileError(
        failure instanceof WorkbookReadError
          ? failure.message
          : workbookReadMessages.unreadable,
      );
    } finally {
      setReading(false);
    }
  }

  async function refresh() {
    setReloadError(null);
    try {
      await reload();
      setStale(false);
    } catch (failure) {
      setReloadError(messageFrom(failure) || genericCatalogError);
    }
  }

  async function run(action: ImportAction) {
    setSaving(true);
    setError(null);
    let outcome: ImportResult;
    try {
      outcome = await commitRecipeImport(action);
      settleAction(subject);
    } catch (failure) {
      settleAction(subject, failure);
      setError(messageFrom(failure));
      flight.current = false;
      setSaving(false);
      return;
    }
    timing.refreshClock();
    setResult(outcome);
    setLoaded(null);
    setShowIssues(false);
    setPickerKey((value) => value + 1);
    setStale(true);
    flight.current = false;
    setSaving(false);
    await refresh();
  }

  async function onSave() {
    if (
      disabled ||
      flight.current ||
      hasAction(subject) ||
      !loaded ||
      !issues
    ) {
      return;
    }
    setShowIssues(true);
    if (issueCount(issues) > 0) {
      setError('راجع الملاحظات الحمرا قبل الحفظ');
      return;
    }
    const built = timing.build();
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    flight.current = true;
    setSaving(true);
    let action: ImportAction;
    try {
      const tokens = await fetchImportTokens(
        requiredTokens(loaded.review, loaded.parsed),
      );
      const payload = buildImportPayload({
        review: loaded.review,
        parsed: loaded.parsed,
        hash: loaded.hash,
        effectiveFrom: built.write.effectiveFrom,
        reason: built.write.reason,
        tokens,
      });
      action = beginAction<ImportAction>(subject, (requestId) => ({
        requestId,
        payload,
      }));
    } catch (failure) {
      flight.current = false;
      setSaving(false);
      setError(messageFrom(failure) || genericCatalogError);
      return;
    }
    await run(action);
  }

  function retry() {
    if (!held || flight.current) return;
    flight.current = true;
    void run(held);
  }

  const knownStructure = loaded ? isKnownStructure(loaded.hash, ctx) : false;
  const skipped = loaded
    ? loaded.parsed.blocks.reduce(
        (sum, block) =>
          sum + block.paddingRows + block.emptyRows + block.skippedRows,
        0,
      )
    : 0;
  const lineCount = loaded
    ? loaded.parsed.blocks.reduce((sum, block) => sum + block.lines.length, 0)
    : 0;

  return (
    <>
      {result ? (
        <section className="flex flex-col gap-2" aria-label="نتيجة الاستيراد">
          <p role="status">الاستيراد اتحفظ</p>
          <ul>
            {Object.entries(result.counts).map(([key, value]) => (
              <li key={key}>
                {countLabels[key] ?? key}: {value}
              </li>
            ))}
          </ul>
          <Link className="underline" to="/recipes">
            شوف الوصفات
          </Link>
        </section>
      ) : null}
      {stale && reloadError === null ? (
        <p role="status">جاري تحديث بيانات الوصفات قبل استيراد جديد…</p>
      ) : null}
      {stale && reloadError !== null ? (
        <div className="flex flex-col gap-2">
          <p role="alert">{reloadError}</p>
          <button
            className={secondaryButton}
            type="button"
            onClick={() => void refresh()}
          >
            حدّث البيانات
          </button>
        </div>
      ) : null}
      <label className="flex flex-col gap-1">
        ملف الوصفات (xlsx)
        <input
          key={pickerKey}
          className={fieldClass}
          type="file"
          accept=".xlsx"
          disabled={disabled}
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
      </label>
      <p className="text-sm text-neutral-600">
        الملف بيتقري على الجهاز ده بس، ومفيش حاجة منه بتترفع غير أسماء وكميات
        الوصفات اللي توافق عليها. الأسعار اللي في الملف مبتتقراش.
      </p>
      {reading ? <p>جاري قراءة الملف…</p> : null}
      {fileError ? <p role="alert">{fileError}</p> : null}
      {held ? <UnknownSave disabled={saving} onRetry={retry} /> : null}
      {loaded && issues && summary ? (
        <>
          <section className="flex flex-col gap-2" aria-label="ملخص الملف">
            <h2 className="text-lg font-semibold">ملخص الملف</h2>
            <p>
              {loaded.fileName}: {loaded.parsed.blocks.length} وصفة، {lineCount}{' '}
              مكوّن، {skipped} صف فاضي أو تعبئة اتخطى
            </p>
            <p>
              {loaded.parsed.sheets.loss
                ? `نسب الفاقد: ${loaded.parsed.losses.length}`
                : 'مفيش جدول فاقد في الملف'}
              {loaded.parsed.packagingNames.length > 0
                ? ` — ${loaded.parsed.packagingNames.length} صنف تغليف في القايمة (مش بيتستورد)`
                : ''}
              {loaded.parsed.menuLinks.length > 0
                ? ` — ${loaded.parsed.menuLinks.length} صنف منيو مرتبط بوصفة (للتوضيح بس)`
                : ''}
            </p>
            {knownStructure ? (
              <p role="status">
                الملف ده بنفس شكل استيراد اتعمل قبل كده، والوصفات اللي ماتغيرتش
                مش هتاخد نسخة جديدة
              </p>
            ) : null}
            {gone.length > 0 ? (
              <div role="status">
                <p>
                  وصفات اتستوردت قبل كده ومش موجودة في الملف ده (مش هتتوقف):
                </p>
                <ul>
                  {gone.map((recipe) => (
                    <li key={recipe.id}>{recipe.name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {loaded.parsed.warnings.length > 0 ? (
              <ul aria-label="تحذيرات الملف">
                {loaded.parsed.warnings.map((warning, index) => (
                  <li key={`${warning.code}:${warning.subject}:${index}`}>
                    {warning.subject ? `${warning.subject}: ` : ''}
                    {warningMessages[warning.code]}
                    {warning.detail ? ` (${warning.detail})` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            <button
              className={secondaryButton}
              type="button"
              disabled={disabled}
              onClick={() =>
                setLoaded({
                  ...loaded,
                  review: confirmSuggestions(loaded.review),
                })
              }
            >
              أكّد كل المقترحات
            </button>
          </section>
          <ReviewView
            parsed={loaded.parsed}
            review={loaded.review}
            ctx={ctx}
            issues={
              showIssues
                ? issues
                : { general: [], blocks: new Map(), ingredients: new Map() }
            }
            disabled={disabled}
            onChange={(review) => setLoaded({ ...loaded, review })}
          />
          <section className="flex flex-col gap-2" aria-label="ملخص الحفظ">
            <p>
              هيتعمل: {summary.recipesNew} وصفة جديدة، {summary.recipesExisting}{' '}
              وصفة موجودة، {summary.itemsNew} صنف جديد، {summary.losses} نسبة
              فاقد، {summary.prices} سعر افتتاحي
            </p>
          </section>
          {timing.fields}
          {showIssues && issues.general.length > 0 ? (
            <ul className="text-sm text-red-700">
              {issues.general.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <button
            className={primaryButton}
            type="button"
            disabled={disabled}
            onClick={() => void onSave()}
          >
            احفظ الاستيراد
          </button>
        </>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : null}
    </>
  );
}

export function RecipeImportPage() {
  const [ctx, setCtx] = useState<ImportContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await loadImportContext();
        if (cancelled) return;
        setCtx(next);
        setLoadError(null);
      } catch (failure) {
        if (!cancelled) setLoadError(messageFrom(failure));
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

  async function reload() {
    setCtx(await loadImportContext());
  }

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/recipes">
          الوصفات
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">استيراد الوصفات</h1>
      {loading && ctx === null ? <p>جاري التحميل…</p> : null}
      {ctx === null && !loading ? (
        <div className="flex flex-col gap-3">
          <p role="alert">{loadError ?? genericCatalogError}</p>
          <button className={secondaryButton} type="button" onClick={retry}>
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {ctx !== null ? <Workspace ctx={ctx} reload={reload} /> : null}
    </main>
  );
}
