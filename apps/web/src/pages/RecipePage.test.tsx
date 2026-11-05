import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { costingImpact, currentShiftStart } from '@/items/api';
import { impactErrorMessage, impactPendingMessage } from '@/items/effective';
import {
  ConfirmedRefusalError,
  CostingChangedError,
  costingChangedMessage,
  genericCatalogError,
  StaleWriteError,
  staleWriteMessage,
} from '@/items/errors';
import { resetHeldWrites, unknownSaveMessage } from '@/items/request-id';
import { RecipePage } from '@/pages/RecipePage';
import {
  expandRecipe,
  getRecipe,
  listBatchOptions,
  listItemUnits,
  listStockOptions,
  listUnitsMeta,
  recipeSchedule,
  setRecipeVersion,
  updateRecipe,
} from '@/recipes/api';
import { sourceChangedMessage } from '@/recipes/labels';
import type {
  BatchOption,
  Expansion,
  ItemUnit,
  RecipeKind,
  RecipeRecord,
  RecipeSchedule,
  RecipeVersion,
  StockOption,
  UnitMeta,
} from '@/recipes/types';

vi.mock('@/items/api', () => ({
  currentShiftStart: vi.fn(),
  costingImpact: vi.fn(),
}));

vi.mock('@/recipes/api', () => ({
  getRecipe: vi.fn(),
  recipeSchedule: vi.fn(),
  listStockOptions: vi.fn(),
  listItemUnits: vi.fn(),
  listUnitsMeta: vi.fn(),
  listBatchOptions: vi.fn(),
  updateRecipe: vi.fn(),
  setRecipeVersion: vi.fn(),
  expandRecipe: vi.fn(),
}));

const nowIso = '2026-07-15T09:00:00.000Z';
const impactText = 'ممكن يأثر على 2 طلب في 1 وردية (تقدير)';

const stock: StockOption[] = [
  {
    id: 'oil',
    name: 'زيت',
    kind: 'ingredient',
    baseUnit: 'liter',
    active: true,
  },
  { id: 'salt', name: 'ملح', kind: 'ingredient', baseUnit: 'kg', active: true },
  {
    id: 'old',
    name: 'بهار قديم',
    kind: 'ingredient',
    baseUnit: 'kg',
    active: false,
  },
  {
    id: 'shrimp',
    name: 'جمبري',
    kind: 'seafood',
    baseUnit: 'kg',
    active: true,
  },
  {
    id: 'size',
    name: 'بوري كبير',
    kind: 'fish_size',
    baseUnit: 'kg',
    active: true,
  },
  {
    id: 'mixed',
    name: 'بوري مخلوط',
    kind: 'fish_mixed',
    baseUnit: 'kg',
    active: true,
  },
  {
    id: 'box',
    name: 'علبة',
    kind: 'packaging',
    baseUnit: 'piece',
    active: true,
  },
];

const itemUnits: ItemUnit[] = [
  { itemId: 'oil', unit: 'liter', label: 'لتر' },
  { itemId: 'oil', unit: 'ml', label: 'مللي' },
  { itemId: 'salt', unit: 'kg', label: 'كيلو' },
  { itemId: 'salt', unit: 'g', label: 'جرام' },
  { itemId: 'shrimp', unit: 'kg', label: 'كيلو' },
  { itemId: 'size', unit: 'kg', label: 'كيلو' },
];

const units: UnitMeta[] = [
  { code: 'kg', labelAr: 'كيلو', dimension: 'mass', metricScale: 1000 },
  { code: 'g', labelAr: 'جرام', dimension: 'mass', metricScale: 1 },
  { code: 'liter', labelAr: 'لتر', dimension: 'volume', metricScale: 1000 },
  { code: 'ml', labelAr: 'مللي', dimension: 'volume', metricScale: 1 },
  { code: 'portion', labelAr: 'حصة', dimension: 'count', metricScale: null },
];

const batches: BatchOption[] = [
  {
    id: 'sauce',
    name: 'صلصة حمراء',
    active: true,
    versions: [
      {
        effectiveFrom: '2026-01-01T00:00:00+00:00',
        effectiveTo: null,
        unit: 'kg',
      },
    ],
  },
  {
    id: 'syrup',
    name: 'شيرة',
    active: true,
    versions: [
      {
        effectiveFrom: '2026-01-01T00:00:00+00:00',
        effectiveTo: null,
        unit: 'liter',
      },
    ],
  },
  {
    id: 'stale-batch',
    name: 'تحضيرة قديمة',
    active: false,
    versions: [
      {
        effectiveFrom: '2026-01-01T00:00:00+00:00',
        effectiveTo: null,
        unit: 'kg',
      },
    ],
  },
];

function recipeOf(kind: RecipeKind, name = 'طبق تجريبي'): RecipeRecord {
  return { id: 'r1', name, kind, active: true };
}

const oilLine = {
  id: 'l1',
  stockItemId: 'oil',
  childRecipeId: null,
  quantity: '0.25',
  unit: 'liter',
};

function versionOf(
  id: string,
  from: string,
  to: string | null,
  lines: RecipeVersion['lines'] = [oilLine],
  batch: { qty: string; unit: string } | null = null,
): RecipeVersion {
  return {
    id,
    effectiveFrom: from,
    effectiveTo: to,
    batchQty: batch?.qty ?? null,
    batchUnit: batch?.unit ?? null,
    lines,
  };
}

function scheduleOf(
  versions: RecipeVersion[],
  token = 'tok-1',
): RecipeSchedule {
  return { identity: 'dish', token, emptyToken: 'empty', versions };
}

const saltLine = {
  id: 'l2',
  stockItemId: 'salt',
  childRecipeId: null,
  quantity: '3',
  unit: 'kg',
};

const openVersion = versionOf('v1', '2026-07-01T00:00:00+00:00', null);

const readyOil: Expansion = {
  status: 'ready',
  requirements: [{ stockItemId: 'oil', baseUnit: 'liter', quantity: '0.25' }],
};

async function open(
  options: {
    recipe?: RecipeRecord;
    schedule?: RecipeSchedule;
    shiftStart?: string | null;
    expansion?: Expansion;
  } = {},
) {
  vi.mocked(getRecipe).mockResolvedValue(options.recipe ?? recipeOf('dish'));
  vi.mocked(recipeSchedule).mockResolvedValue(
    options.schedule ?? scheduleOf([openVersion]),
  );
  vi.mocked(currentShiftStart).mockResolvedValue(options.shiftStart ?? null);
  vi.mocked(expandRecipe).mockResolvedValue(options.expansion ?? readyOil);
  render(
    <MemoryRouter initialEntries={['/recipes/r1']}>
      <Routes>
        <Route path="/recipes/:recipeId" element={<RecipePage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('form', { name: 'نسخة الوصفة' });
}

function save() {
  return screen.getByRole('button', { name: 'احفظ النسخة' });
}

function sent(index: number) {
  const call = vi.mocked(setRecipeVersion).mock.calls[index];
  if (!call) throw new Error('no version write');
  expect(call[0]).toBe('r1');
  return call[1];
}

function chooseTime(local: string) {
  fireEvent.change(screen.getByLabelText('وقت السريان'), {
    target: { value: 'custom' },
  });
  fireEvent.change(screen.getByLabelText('الوقت'), {
    target: { value: local },
  });
}

function optionNames(label: string): string[] {
  return within(screen.getByLabelText(label))
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');
}

function addLine(target: string, quantity: string) {
  fireEvent.click(screen.getByRole('button', { name: 'ضيف مكوّن' }));
  const number = within(
    screen.getByRole('list', { name: 'مكونات الوصفة' }),
  ).getAllByRole('listitem').length;
  fireEvent.change(screen.getByLabelText(`المكوّن ${number}`), {
    target: { value: target },
  });
  fireEvent.change(screen.getByLabelText(`الكمية ${number}`), {
    target: { value: quantity },
  });
}

describe('RecipePage', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(nowIso));
    for (const mock of [
      getRecipe,
      recipeSchedule,
      listStockOptions,
      listItemUnits,
      listUnitsMeta,
      listBatchOptions,
      updateRecipe,
      setRecipeVersion,
      expandRecipe,
      costingImpact,
      currentShiftStart,
    ]) {
      vi.mocked(mock).mockReset();
    }
    vi.mocked(listStockOptions).mockResolvedValue(stock);
    vi.mocked(listItemUnits).mockResolvedValue(itemUnits);
    vi.mocked(listUnitsMeta).mockResolvedValue(units);
    vi.mocked(listBatchOptions).mockResolvedValue(batches);
    vi.mocked(updateRecipe).mockResolvedValue(undefined);
    vi.mocked(setRecipeVersion).mockResolvedValue(undefined);
    vi.mocked(costingImpact).mockResolvedValue({
      orders: 2,
      shifts: 1,
      movements: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('loading', () => {
    it('shows a missing recipe', async () => {
      vi.mocked(getRecipe).mockResolvedValue(null);
      vi.mocked(recipeSchedule).mockResolvedValue(scheduleOf([]));
      vi.mocked(currentShiftStart).mockResolvedValue(null);
      render(
        <MemoryRouter initialEntries={['/recipes/zzz']}>
          <Routes>
            <Route path="/recipes/:recipeId" element={<RecipePage />} />
          </Routes>
        </MemoryRouter>,
      );
      expect(await screen.findByText('الوصفة مش موجودة')).toBeInTheDocument();
      expect(
        screen.queryByRole('form', { name: 'نسخة الوصفة' }),
      ).not.toBeInTheDocument();
    });

    it('shows a load error and loads again on retry', async () => {
      vi.mocked(getRecipe).mockRejectedValueOnce(new Error('تعذر الاتصال'));
      vi.mocked(getRecipe).mockResolvedValue(recipeOf('dish'));
      vi.mocked(recipeSchedule).mockResolvedValue(scheduleOf([openVersion]));
      vi.mocked(currentShiftStart).mockResolvedValue(null);
      vi.mocked(expandRecipe).mockResolvedValue(readyOil);
      render(
        <MemoryRouter initialEntries={['/recipes/r1']}>
          <Routes>
            <Route path="/recipes/:recipeId" element={<RecipePage />} />
          </Routes>
        </MemoryRouter>,
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'تعذر الاتصال',
      );
      fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
      expect(
        await screen.findByRole('form', { name: 'نسخة الوصفة' }),
      ).toBeInTheDocument();
    });
  });

  describe('details', () => {
    it('shows the kind and never lets it change', async () => {
      await open({ recipe: recipeOf('cooking') });
      expect(screen.getByText('النوع: طريقة طهي لكل كيلو')).toBeInTheDocument();
      expect(screen.queryByLabelText('النوع')).not.toBeInTheDocument();
    });

    it('renames with the expected name and active flag', async () => {
      await open();
      vi.mocked(getRecipe).mockResolvedValue(recipeOf('dish', 'طبق جديد'));
      fireEvent.change(screen.getByLabelText('اسم الوصفة'), {
        target: { value: '  طبق جديد  ' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'احفظ البيانات' }));
      expect(await screen.findByText('الوصفة اتحفظت')).toBeInTheDocument();
      expect(updateRecipe).toHaveBeenCalledTimes(1);
      expect(updateRecipe).toHaveBeenCalledWith(
        'r1',
        expect.objectContaining({
          name: '  طبق جديد  ',
          active: true,
          expectedName: 'طبق تجريبي',
          expectedActive: true,
        }),
      );
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        'طبق جديد',
      );
    });

    it('stops a recipe by clearing the active flag', async () => {
      await open();
      fireEvent.click(screen.getByLabelText('شغالة'));
      fireEvent.click(screen.getByRole('button', { name: 'احفظ البيانات' }));
      await waitFor(() => {
        expect(updateRecipe).toHaveBeenCalledTimes(1);
      });
      expect(updateRecipe).toHaveBeenCalledWith(
        'r1',
        expect.objectContaining({ active: false, expectedActive: true }),
      );
    });

    it('does not call the server when nothing changed', async () => {
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'احفظ البيانات' }));
      expect(screen.getByText('مفيش تغيير للحفظ')).toBeInTheDocument();
      expect(updateRecipe).not.toHaveBeenCalled();
    });

    it('refuses an empty name', async () => {
      await open();
      fireEvent.change(screen.getByLabelText('اسم الوصفة'), {
        target: { value: '  ' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'احفظ البيانات' }));
      expect(screen.getByRole('alert')).toHaveTextContent(
        'الاسم لازم يكون من حرف لحد 120 حرف',
      );
      expect(updateRecipe).not.toHaveBeenCalled();
    });

    it('reloads the recipe on a stale rename and saves again with a new request id', async () => {
      await open();
      vi.mocked(updateRecipe).mockRejectedValueOnce(new StaleWriteError());
      vi.mocked(getRecipe).mockResolvedValue(
        recipeOf('dish', 'اسم من مكان تاني'),
      );
      fireEvent.change(screen.getByLabelText('اسم الوصفة'), {
        target: { value: 'اسم جديد' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'احفظ البيانات' }));
      expect(await screen.findByText(staleWriteMessage)).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByLabelText('اسم الوصفة')).toHaveValue(
          'اسم من مكان تاني',
        );
      });
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        'اسم من مكان تاني',
      );
      expect(screen.queryByText(unknownSaveMessage)).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('اسم الوصفة'), {
        target: { value: 'اسم تالت' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'احفظ البيانات' }));
      await waitFor(() => {
        expect(updateRecipe).toHaveBeenCalledTimes(2);
      });
      const [first, second] = vi.mocked(updateRecipe).mock.calls;
      expect(second?.[1]).toMatchObject({
        expectedName: 'اسم من مكان تاني',
        name: 'اسم تالت',
      });
      expect(second?.[1].requestId).not.toBe(first?.[1].requestId);
    });

    it('lets the owner pick another name after a duplicate-name refusal', async () => {
      await open();
      vi.mocked(updateRecipe).mockRejectedValueOnce(
        new ConfirmedRefusalError('الاسم ده موجود قبل كده'),
      );
      fireEvent.change(screen.getByLabelText('اسم الوصفة'), {
        target: { value: 'اسم موجود' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'احفظ البيانات' }));
      expect(
        await screen.findByText('الاسم ده موجود قبل كده'),
      ).toBeInTheDocument();
      expect(screen.queryByText(unknownSaveMessage)).not.toBeInTheDocument();
      expect(screen.getByLabelText('اسم الوصفة')).toBeEnabled();

      fireEvent.change(screen.getByLabelText('اسم الوصفة'), {
        target: { value: 'اسم تاني' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'احفظ البيانات' }));
      await waitFor(() => {
        expect(updateRecipe).toHaveBeenCalledTimes(2);
      });
      const [first, second] = vi.mocked(updateRecipe).mock.calls;
      expect(second?.[1].name).toBe('اسم تاني');
      expect(second?.[1].requestId).not.toBe(first?.[1].requestId);
    });

    it('holds an unknown rename and retries only the same one', async () => {
      await open();
      vi.mocked(updateRecipe).mockRejectedValueOnce(new Error('تعذر الاتصال'));
      fireEvent.change(screen.getByLabelText('اسم الوصفة'), {
        target: { value: 'اسم جديد' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'احفظ البيانات' }));
      expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
      expect(screen.getByLabelText('اسم الوصفة')).toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'احفظ البيانات' }),
      ).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
      await waitFor(() => {
        expect(updateRecipe).toHaveBeenCalledTimes(2);
      });
      expect(vi.mocked(updateRecipe).mock.calls[1]).toEqual(
        vi.mocked(updateRecipe).mock.calls[0],
      );
      await waitFor(() => {
        expect(screen.queryByText(unknownSaveMessage)).not.toBeInTheDocument();
      });
    });

    it('locks the version editor while a rename is saving', async () => {
      let release: () => void = () => undefined;
      vi.mocked(updateRecipe).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await open();
      fireEvent.change(screen.getByLabelText('اسم الوصفة'), {
        target: { value: 'اسم جديد' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'احفظ البيانات' }));
      expect(save()).toBeDisabled();
      await act(async () => {
        release();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(save()).toBeEnabled();
      });
    });
  });

  describe('lines', () => {
    it('seeds the table from the version in force, with the net-quantity hint', async () => {
      await open();
      expect(screen.getByLabelText('المكوّن 1')).toHaveValue('item:oil');
      expect(screen.getByLabelText('الكمية 1')).toHaveValue('0.25');
      expect(screen.getByLabelText('الوحدة 1')).toHaveValue('liter');
      expect(
        screen.getByText(
          'الكمية صافي، من غير الفاقد. الفاقد بيتحسب لوحده من الصنف.',
        ),
      ).toBeInTheDocument();
    });

    it('validates each row before any write', async () => {
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'ضيف مكوّن' }));
      fireEvent.click(save());
      expect(screen.getByRole('alert')).toHaveTextContent(
        'سطر 2: اختار الصنف أو التحضيرة',
      );

      fireEvent.change(screen.getByLabelText('المكوّن 2'), {
        target: { value: 'item:salt' },
      });
      expect(screen.getByLabelText('الوحدة 2')).toHaveValue('kg');
      for (const bad of ['', '0', '-1', 'abc', '1e3']) {
        fireEvent.change(screen.getByLabelText('الكمية 2'), {
          target: { value: bad },
        });
        fireEvent.click(save());
        expect(screen.getByRole('alert')).toHaveTextContent(
          'سطر 2: الكمية لازم تكون رقم أكبر من صفر',
        );
      }

      fireEvent.change(screen.getByLabelText('الكمية 2'), {
        target: { value: '1,5' },
      });
      fireEvent.change(screen.getByLabelText('الوحدة 2'), {
        target: { value: '' },
      });
      fireEvent.click(save());
      expect(screen.getByRole('alert')).toHaveTextContent(
        'سطر 2: اختار الوحدة',
      );
      expect(setRecipeVersion).not.toHaveBeenCalled();
    });

    it('asks for an ingredient or a stop when every line was removed', async () => {
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'احذف السطر 1' }));
      fireEvent.click(save());
      expect(screen.getByRole('alert')).toHaveTextContent(
        'ضيف مكوّن واحد على الأقل أو وقّف الوصفة من الوقت ده',
      );
      expect(setRecipeVersion).not.toHaveBeenCalled();
    });

    it('sends the rows with exact decimal text', async () => {
      await open();
      addLine('item:salt', '0,1234567');
      fireEvent.change(screen.getByLabelText('الوحدة 2'), {
        target: { value: 'g' },
      });
      fireEvent.click(save());
      await waitFor(() => {
        expect(setRecipeVersion).toHaveBeenCalledTimes(1);
      });
      expect(sent(0).lines).toEqual([
        { stock_item_id: 'oil', quantity: '0.25', unit: 'liter' },
        { stock_item_id: 'salt', quantity: '0.1234567', unit: 'g' },
      ]);
    });

    it('re-sends an untouched exact quantity unchanged after a save and reload', async () => {
      const exact = '0.123456499999999999';
      const exactLine = { ...oilLine, quantity: exact };
      const first = versionOf('v1', '2026-07-01T00:00:00+00:00', null, [
        exactLine,
        saltLine,
      ]);
      await open({ schedule: scheduleOf([first]) });
      expect(screen.getByLabelText('الكمية 1')).toHaveValue(exact);
      vi.mocked(recipeSchedule).mockResolvedValue(
        scheduleOf(
          [
            versionOf('v2', '2026-07-01T00:00:00+00:00', null, [
              exactLine,
              { ...saltLine, quantity: '4' },
            ]),
          ],
          'tok-2',
        ),
      );
      fireEvent.change(screen.getByLabelText('الكمية 2'), {
        target: { value: '4' },
      });
      fireEvent.click(save());
      await screen.findByText('نسخة الوصفة اتحفظت');
      await waitFor(() => {
        expect(screen.getByLabelText('الكمية 2')).toHaveValue('4');
      });

      fireEvent.change(screen.getByLabelText('الكمية 2'), {
        target: { value: '5' },
      });
      fireEvent.click(save());
      await waitFor(() => {
        expect(setRecipeVersion).toHaveBeenCalledTimes(2);
      });
      expect(sent(1).token).toBe('tok-2');
      expect(sent(1).lines).toEqual([
        { stock_item_id: 'oil', quantity: exact, unit: 'liter' },
        { stock_item_id: 'salt', quantity: '5', unit: 'kg' },
      ]);
    });

    it('offers the units of the chosen stock item only', async () => {
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'ضيف مكوّن' }));
      fireEvent.change(screen.getByLabelText('المكوّن 2'), {
        target: { value: 'item:oil' },
      });
      expect(optionNames('الوحدة 2')).toEqual(['اختار الوحدة', 'لتر', 'مللي']);
      expect(screen.getByLabelText('الوحدة 2')).toHaveValue('liter');
      fireEvent.change(screen.getByLabelText('المكوّن 2'), {
        target: { value: 'item:salt' },
      });
      expect(optionNames('الوحدة 2')).toEqual(['اختار الوحدة', 'كيلو', 'جرام']);
      expect(screen.getByLabelText('الوحدة 2')).toHaveValue('kg');
    });

    it('never offers packaging or mixed fish, and hides marine items from a cooking recipe', async () => {
      await open({ recipe: recipeOf('cooking'), schedule: scheduleOf([]) });
      fireEvent.click(screen.getByRole('button', { name: 'ضيف مكوّن' }));
      const cooking = optionNames('المكوّن 1');
      expect(cooking).toEqual(expect.arrayContaining(['زيت', 'ملح']));
      for (const hidden of [
        'جمبري',
        'بوري كبير',
        'بوري مخلوط',
        'علبة',
        'بهار قديم',
      ]) {
        expect(cooking).not.toContain(hidden);
      }
    });

    it.each<RecipeKind>(['dish', 'batch'])(
      'offers marine items in a %s recipe but not packaging or mixed fish',
      async (kind) => {
        await open({ recipe: recipeOf(kind), schedule: scheduleOf([]) });
        fireEvent.click(screen.getByRole('button', { name: 'ضيف مكوّن' }));
        const names = optionNames('المكوّن 1');
        expect(names).toEqual(
          expect.arrayContaining(['زيت', 'جمبري', 'بوري كبير']),
        );
        for (const hidden of ['بوري مخلوط', 'علبة', 'بهار قديم']) {
          expect(names).not.toContain(hidden);
        }
      },
    );

    it('offers active batch recipes as children, with their batch unit and same-dimension units', async () => {
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'ضيف مكوّن' }));
      const names = optionNames('المكوّن 2');
      expect(names).toEqual(expect.arrayContaining(['صلصة حمراء', 'شيرة']));
      expect(names).not.toContain('تحضيرة قديمة');

      fireEvent.change(screen.getByLabelText('المكوّن 2'), {
        target: { value: 'recipe:sauce' },
      });
      expect(optionNames('الوحدة 2')).toEqual(['اختار الوحدة', 'كيلو', 'جرام']);
      expect(screen.getByLabelText('الوحدة 2')).toHaveValue('kg');

      fireEvent.change(screen.getByLabelText('المكوّن 2'), {
        target: { value: 'recipe:syrup' },
      });
      expect(optionNames('الوحدة 2')).toEqual(['اختار الوحدة', 'لتر', 'مللي']);
      expect(screen.getByLabelText('الوحدة 2')).toHaveValue('liter');

      fireEvent.change(screen.getByLabelText('الكمية 2'), {
        target: { value: '300' },
      });
      fireEvent.change(screen.getByLabelText('الوحدة 2'), {
        target: { value: 'ml' },
      });
      fireEvent.click(save());
      await waitFor(() => {
        expect(setRecipeVersion).toHaveBeenCalledTimes(1);
      });
      expect(sent(0).lines).toEqual([
        { stock_item_id: 'oil', quantity: '0.25', unit: 'liter' },
        { child_recipe_id: 'syrup', quantity: '300', unit: 'ml' },
      ]);
    });
  });

  describe('batch recipe', () => {
    const batchVersion = versionOf(
      'v1',
      '2026-07-01T00:00:00+00:00',
      null,
      [
        {
          id: 'l1',
          stockItemId: 'salt',
          childRecipeId: null,
          quantity: '1',
          unit: 'kg',
        },
      ],
      { qty: '2', unit: 'kg' },
    );

    it('has a batch quantity and unit and never offers itself as a child', async () => {
      vi.mocked(listBatchOptions).mockResolvedValue([
        ...batches,
        { id: 'r1', name: 'تحضيرة الصفحة', active: true, versions: [] },
      ]);
      await open({
        recipe: recipeOf('batch', 'تحضيرة الصفحة'),
        schedule: scheduleOf([batchVersion]),
      });
      expect(screen.getByLabelText('كمية التحضيرة')).toHaveValue('2');
      expect(screen.getByLabelText('وحدة التحضيرة')).toHaveValue('kg');
      fireEvent.click(screen.getByRole('button', { name: 'ضيف مكوّن' }));
      const names = optionNames('المكوّن 2');
      expect(names).toContain('صلصة حمراء');
      expect(names).not.toContain('تحضيرة الصفحة');
    });

    it('requires a positive batch quantity and sends it with its unit', async () => {
      await open({
        recipe: recipeOf('batch'),
        schedule: scheduleOf([batchVersion]),
      });
      fireEvent.change(screen.getByLabelText('كمية التحضيرة'), {
        target: { value: '0' },
      });
      fireEvent.click(save());
      expect(screen.getByRole('alert')).toHaveTextContent(
        'كمية التحضيرة لازم تكون رقم أكبر من صفر',
      );
      expect(setRecipeVersion).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText('كمية التحضيرة'), {
        target: { value: '2,5' },
      });
      fireEvent.click(save());
      await waitFor(() => {
        expect(setRecipeVersion).toHaveBeenCalledTimes(1);
      });
      expect(sent(0)).toMatchObject({ batchQty: '2.5', batchUnit: 'kg' });
    });

    it('does not show batch fields for a dish', async () => {
      await open();
      expect(screen.queryByLabelText('كمية التحضيرة')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('وحدة التحضيرة')).not.toBeInTheDocument();
    });
  });

  describe('effective time', () => {
    it('sends a null start for "now" and the version end it falls inside', async () => {
      const later = versionOf('v2', '2026-08-01T00:00:00+00:00', null);
      const current = versionOf(
        'v1',
        '2026-07-01T00:00:00+00:00',
        '2026-08-01T00:00:00+00:00',
      );
      await open({ schedule: scheduleOf([current, later]) });
      expect(screen.getByLabelText('وقت السريان')).toHaveValue('now');
      expect(screen.queryByLabelText('سبب التغيير')).not.toBeInTheDocument();
      fireEvent.click(save());
      await screen.findByText('نسخة الوصفة اتحفظت');
      expect(sent(0)).toEqual({
        requestId: expect.any(String) as string,
        effectiveFrom: null,
        effectiveTo: '2026-08-01T00:00:00.000Z',
        batchQty: null,
        batchUnit: null,
        lines: [{ stock_item_id: 'oil', quantity: '0.25', unit: 'liter' }],
        reason: null,
        token: 'tok-1',
      });
      expect(costingImpact).not.toHaveBeenCalled();
      expect(recipeSchedule).toHaveBeenCalledTimes(2);
    });

    it('leaves the end open when "now" falls inside an open version', async () => {
      await open();
      fireEvent.click(save());
      await waitFor(() => {
        expect(setRecipeVersion).toHaveBeenCalledTimes(1);
      });
      expect(sent(0)).toMatchObject({ effectiveFrom: null, effectiveTo: null });
    });

    describe('when the clock crosses a version boundary', () => {
      const ending = versionOf(
        'v1',
        '2026-07-01T00:00:00+00:00',
        '2026-07-15T12:00:00+00:00',
      );
      const starting = versionOf('v2', '2026-07-15T12:00:00+00:00', null, [
        saltLine,
      ]);

      it.each([
        ['an untouched draft', false],
        ['an edited draft', true],
      ])(
        'asks for a review of %s instead of writing it over the next version',
        async (_name, edited) => {
          vi.setSystemTime(new Date('2026-07-15T11:59:30.000Z'));
          await open({ schedule: scheduleOf([ending, starting]) });
          expect(screen.getByLabelText('المكوّن 1')).toHaveValue('item:oil');
          if (edited) {
            fireEvent.change(screen.getByLabelText('الكمية 1'), {
              target: { value: '7' },
            });
          }

          vi.setSystemTime(new Date('2026-07-15T12:01:00.000Z'));
          fireEvent.click(save());
          expect(screen.getByRole('alert')).toHaveTextContent(
            sourceChangedMessage,
          );
          expect(setRecipeVersion).not.toHaveBeenCalled();
          expect(screen.getByLabelText('المكوّن 1')).toHaveValue('item:salt');
          expect(screen.getByLabelText('الكمية 1')).toHaveValue('3');

          fireEvent.click(save());
          await waitFor(() => {
            expect(setRecipeVersion).toHaveBeenCalledTimes(1);
          });
          expect(sent(0)).toMatchObject({
            effectiveFrom: null,
            effectiveTo: null,
            lines: [{ stock_item_id: 'salt', quantity: '3', unit: 'kg' }],
          });
        },
      );

      it('still asks for a review after a refused submit moved the clock', async () => {
        vi.setSystemTime(new Date('2026-07-15T11:59:30.000Z'));
        await open({ schedule: scheduleOf([ending, starting]) });
        fireEvent.change(screen.getByLabelText('الكمية 1'), {
          target: { value: '7' },
        });

        vi.setSystemTime(new Date('2026-07-15T12:01:00.000Z'));
        fireEvent.change(screen.getByLabelText('وقت السريان'), {
          target: { value: 'custom' },
        });
        fireEvent.click(save());
        expect(screen.getByRole('alert')).toHaveTextContent('الوقت مش مظبوط');
        expect(setRecipeVersion).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText('وقت السريان'), {
          target: { value: 'now' },
        });
        fireEvent.click(save());
        expect(screen.getByRole('alert')).toHaveTextContent(
          sourceChangedMessage,
        );
        expect(setRecipeVersion).not.toHaveBeenCalled();
        expect(screen.getByLabelText('المكوّن 1')).toHaveValue('item:salt');
        expect(screen.getByLabelText('الكمية 1')).toHaveValue('3');

        fireEvent.click(save());
        await waitFor(() => {
          expect(setRecipeVersion).toHaveBeenCalledTimes(1);
        });
        expect(sent(0)).toMatchObject({
          effectiveFrom: null,
          effectiveTo: null,
          lines: [{ stock_item_id: 'salt', quantity: '3', unit: 'kg' }],
        });
      });

      it('saves normally when the clock stays inside the same version', async () => {
        vi.setSystemTime(new Date('2026-07-15T11:57:00.000Z'));
        await open({ schedule: scheduleOf([ending, starting]) });
        vi.setSystemTime(new Date('2026-07-15T11:59:00.000Z'));
        fireEvent.click(save());
        await waitFor(() => {
          expect(setRecipeVersion).toHaveBeenCalledTimes(1);
        });
        expect(sent(0)).toMatchObject({
          effectiveTo: '2026-07-15T12:00:00.000Z',
          lines: [{ stock_item_id: 'oil', quantity: '0.25', unit: 'liter' }],
        });
      });

      it('does not let a stop skip the review either', async () => {
        vi.setSystemTime(new Date('2026-07-15T11:59:30.000Z'));
        await open({ schedule: scheduleOf([ending, starting]) });
        fireEvent.click(
          screen.getByRole('button', { name: 'وقّف الوصفة من الوقت ده' }),
        );
        vi.setSystemTime(new Date('2026-07-15T12:01:00.000Z'));
        fireEvent.click(
          screen.getByRole('button', { name: 'أيوه، وقّف الوصفة' }),
        );
        expect(screen.getByRole('alert')).toHaveTextContent(
          sourceChangedMessage,
        );
        expect(setRecipeVersion).not.toHaveBeenCalled();
      });
    });

    it('defaults to the start of the current shift, which needs a reason and an impact', async () => {
      await open({ shiftStart: '2026-07-15T06:00:00.000Z' });
      expect(screen.getByLabelText('وقت السريان')).toHaveValue('shift');
      expect(await screen.findByText(impactText)).toBeInTheDocument();
      fireEvent.click(save());
      expect(screen.getByRole('alert')).toHaveTextContent(
        'اكتب سبب التغيير بأثر رجعي',
      );
      expect(setRecipeVersion).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText('سبب التغيير'), {
        target: { value: 'تصحيح' },
      });
      fireEvent.click(save());
      await waitFor(() => {
        expect(setRecipeVersion).toHaveBeenCalledTimes(1);
      });
      expect(sent(0)).toMatchObject({
        effectiveFrom: '2026-07-15T06:00:00.000Z',
        effectiveTo: null,
        reason: 'تصحيح',
      });
      expect(vi.mocked(costingImpact).mock.calls[0]?.slice(0, 2)).toEqual([
        '2026-07-15T06:00:00.000Z',
        null,
      ]);
    });

    it('lets the owner choose "now" even when a shift is open', async () => {
      await open({ shiftStart: '2026-07-15T06:00:00.000Z' });
      fireEvent.change(screen.getByLabelText('وقت السريان'), {
        target: { value: 'now' },
      });
      expect(screen.queryByLabelText('سبب التغيير')).not.toBeInTheDocument();
      fireEvent.click(save());
      await waitFor(() => {
        expect(setRecipeVersion).toHaveBeenCalledTimes(1);
      });
      expect(sent(0)).toMatchObject({ effectiveFrom: null, reason: null });
    });

    it('needs a reason and a ready impact for a past instant', async () => {
      await open();
      chooseTime('2026-07-10T10:00');
      expect(await screen.findByText(impactText)).toBeInTheDocument();
      fireEvent.click(save());
      expect(screen.getByRole('alert')).toHaveTextContent(
        'اكتب سبب التغيير بأثر رجعي',
      );
      expect(setRecipeVersion).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText('سبب التغيير'), {
        target: { value: '  تصحيح  ' },
      });
      fireEvent.click(save());
      await waitFor(() => {
        expect(setRecipeVersion).toHaveBeenCalledTimes(1);
      });
      expect(sent(0)).toMatchObject({
        effectiveFrom: '2026-07-10T07:00:00.000Z',
        effectiveTo: null,
        reason: 'تصحيح',
      });
      expect(costingImpact).toHaveBeenCalledTimes(1);
      expect(vi.mocked(costingImpact).mock.calls[0]?.slice(0, 2)).toEqual([
        '2026-07-10T07:00:00.000Z',
        null,
      ]);
    });

    it('blocks a past instant while the impact is pending', async () => {
      vi.mocked(costingImpact).mockImplementation(
        () => new Promise(() => undefined),
      );
      await open();
      chooseTime('2026-07-10T10:00');
      fireEvent.change(screen.getByLabelText('سبب التغيير'), {
        target: { value: 'تصحيح' },
      });
      fireEvent.click(save());
      expect(screen.getByRole('alert')).toHaveTextContent(impactPendingMessage);
      expect(setRecipeVersion).not.toHaveBeenCalled();
    });

    it('blocks a past instant while the impact failed, and allows saving after a retry', async () => {
      vi.mocked(costingImpact).mockRejectedValueOnce(new Error('تعذر الاتصال'));
      await open();
      chooseTime('2026-07-10T10:00');
      fireEvent.change(screen.getByLabelText('سبب التغيير'), {
        target: { value: 'تصحيح' },
      });
      expect(await screen.findByText(impactErrorMessage)).toBeInTheDocument();
      fireEvent.click(save());
      expect(setRecipeVersion).not.toHaveBeenCalled();
      expect(screen.getAllByText(impactErrorMessage).length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
      expect(await screen.findByText(impactText)).toBeInTheDocument();
      fireEvent.click(save());
      await waitFor(() => {
        expect(setRecipeVersion).toHaveBeenCalledTimes(1);
      });
    });

    describe('interval end', () => {
      const first = versionOf(
        'v1',
        '2026-07-01T00:00:00+00:00',
        '2026-07-10T00:00:00+00:00',
      );
      const second = versionOf('v2', '2026-07-20T00:00:00+00:00', null);

      beforeEach(() => {
        vi.setSystemTime(new Date('2026-07-25T09:00:00.000Z'));
      });

      it('ends at the version the instant falls inside', async () => {
        await open({ schedule: scheduleOf([first, second]) });
        chooseTime('2026-07-05T10:00');
        expect(await screen.findByText(impactText)).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('سبب التغيير'), {
          target: { value: 'تصحيح' },
        });
        fireEvent.click(save());
        await waitFor(() => {
          expect(setRecipeVersion).toHaveBeenCalledTimes(1);
        });
        expect(sent(0)).toMatchObject({
          effectiveFrom: '2026-07-05T07:00:00.000Z',
          effectiveTo: '2026-07-10T00:00:00.000Z',
        });
        expect(vi.mocked(costingImpact).mock.calls[0]?.slice(0, 2)).toEqual([
          '2026-07-05T07:00:00.000Z',
          '2026-07-10T00:00:00.000Z',
        ]);
      });

      it('ends at the next start when the instant is inside a gap', async () => {
        await open({ schedule: scheduleOf([first, second]) });
        chooseTime('2026-07-15T10:00');
        expect(
          screen.getByText('مفيش نسخة سارية في الوقت المختار'),
        ).toBeInTheDocument();
        expect(await screen.findByText(impactText)).toBeInTheDocument();
        addLine('item:oil', '1');
        fireEvent.change(screen.getByLabelText('سبب التغيير'), {
          target: { value: 'تصحيح' },
        });
        fireEvent.click(save());
        await waitFor(() => {
          expect(setRecipeVersion).toHaveBeenCalledTimes(1);
        });
        expect(sent(0)).toMatchObject({
          effectiveFrom: '2026-07-15T07:00:00.000Z',
          effectiveTo: '2026-07-20T00:00:00.000Z',
          lines: [{ stock_item_id: 'oil', quantity: '1', unit: 'liter' }],
        });
        expect(vi.mocked(costingImpact).mock.calls[0]?.slice(0, 2)).toEqual([
          '2026-07-15T07:00:00.000Z',
          '2026-07-20T00:00:00.000Z',
        ]);
      });

      it('leaves the end open when a gap has nothing after it', async () => {
        await open({ schedule: scheduleOf([first]) });
        chooseTime('2026-07-15T10:00');
        expect(await screen.findByText(impactText)).toBeInTheDocument();
        addLine('item:salt', '2');
        fireEvent.change(screen.getByLabelText('سبب التغيير'), {
          target: { value: 'تصحيح' },
        });
        fireEvent.click(save());
        await waitFor(() => {
          expect(setRecipeVersion).toHaveBeenCalledTimes(1);
        });
        expect(sent(0)).toMatchObject({
          effectiveFrom: '2026-07-15T07:00:00.000Z',
          effectiveTo: null,
        });
      });

      it('shows the version in force at the chosen instant, not only now', async () => {
        const early = versionOf(
          'v1',
          '2026-07-01T00:00:00+00:00',
          '2026-07-10T00:00:00+00:00',
          [
            {
              id: 'l9',
              stockItemId: 'salt',
              childRecipeId: null,
              quantity: '9',
              unit: 'kg',
            },
          ],
        );
        await open({ schedule: scheduleOf([early, second]) });
        expect(screen.getByLabelText('المكوّن 1')).toHaveValue('item:oil');
        chooseTime('2026-07-05T10:00');
        await waitFor(() => {
          expect(screen.getByLabelText('المكوّن 1')).toHaveValue('item:salt');
        });
        expect(screen.getByLabelText('الكمية 1')).toHaveValue('9');
      });
    });
  });

  describe('stopping', () => {
    it('publishes null lines from the chosen time after a confirm step', async () => {
      await open();
      fireEvent.click(
        screen.getByRole('button', { name: 'وقّف الوصفة من الوقت ده' }),
      );
      expect(screen.getByText(/الوصفة هتتوقف من الوقت ده/)).toBeInTheDocument();
      expect(setRecipeVersion).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'لأ' }));
      expect(
        screen.queryByText(/الوصفة هتتوقف من الوقت ده/),
      ).not.toBeInTheDocument();

      fireEvent.click(
        screen.getByRole('button', { name: 'وقّف الوصفة من الوقت ده' }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'أيوه، وقّف الوصفة' }),
      );
      expect(
        await screen.findByText('الوصفة اتوقفت من الوقت ده'),
      ).toBeInTheDocument();
      expect(setRecipeVersion).toHaveBeenCalledTimes(1);
      expect(sent(0)).toMatchObject({
        effectiveFrom: null,
        effectiveTo: null,
        lines: null,
        batchQty: null,
        batchUnit: null,
        reason: null,
        token: 'tok-1',
      });
    });

    it('needs a reason for a backdated stop', async () => {
      await open();
      chooseTime('2026-07-10T10:00');
      expect(await screen.findByText(impactText)).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole('button', { name: 'وقّف الوصفة من الوقت ده' }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'أيوه، وقّف الوصفة' }),
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        'اكتب سبب التغيير بأثر رجعي',
      );
      expect(setRecipeVersion).not.toHaveBeenCalled();
    });

    it('cannot stop a recipe that has nothing in force', async () => {
      await open({ schedule: scheduleOf([]) });
      expect(
        screen.getByRole('button', { name: 'وقّف الوصفة من الوقت ده' }),
      ).toBeDisabled();
    });
  });

  describe('saving', () => {
    it('sends exactly one write however many times save is pressed', async () => {
      let release: () => void = () => undefined;
      vi.mocked(setRecipeVersion).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await open();
      const form = screen.getByRole('form', { name: 'نسخة الوصفة' });
      fireEvent.click(save());
      fireEvent.submit(form);
      fireEvent.click(save());
      expect(setRecipeVersion).toHaveBeenCalledTimes(1);
      expect(save()).toBeDisabled();
      expect(screen.getByLabelText('اسم الوصفة')).toBeDisabled();

      await act(async () => {
        release();
        await Promise.resolve();
      });
      expect(await screen.findByText('نسخة الوصفة اتحفظت')).toBeInTheDocument();
      expect(setRecipeVersion).toHaveBeenCalledTimes(1);
      expect(updateRecipe).not.toHaveBeenCalled();
      expect(save()).toBeEnabled();
    });

    it.each([
      ['a lost connection', () => new Error('تعذر الاتصال')],
      [
        'a privilege error',
        () =>
          Object.assign(new Error('المالك بس يقدر يعمل التغيير ده'), {
            code: '42501',
          }),
      ],
      [
        'a generic serialization failure',
        () =>
          Object.assign(new Error(costingChangedMessage), { code: '40001' }),
      ],
    ])(
      'holds the payload after %s and retries it identically only',
      async (_name, failure) => {
        vi.mocked(setRecipeVersion).mockRejectedValueOnce(failure());
        await open();
        fireEvent.click(save());
        expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
        expect(save()).toBeDisabled();
        expect(screen.getByLabelText('الكمية 1')).toBeDisabled();
        expect(
          screen.getByRole('button', { name: 'ضيف مكوّن' }),
        ).toBeDisabled();
        expect(screen.getByLabelText('وقت السريان')).toBeDisabled();
        expect(recipeSchedule).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-07-15T10:30:00.000Z'));
        fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
        await waitFor(() => {
          expect(setRecipeVersion).toHaveBeenCalledTimes(2);
        });
        expect(sent(1)).toEqual(sent(0));
        expect(
          await screen.findByText('نسخة الوصفة اتحفظت'),
        ).toBeInTheDocument();
        expect(screen.queryByText(unknownSaveMessage)).not.toBeInTheDocument();
        expect(save()).toBeEnabled();
      },
    );

    it('retires the request and reloads the schedule on a confirmed configuration change', async () => {
      await open();
      vi.mocked(setRecipeVersion).mockRejectedValueOnce(
        new CostingChangedError(),
      );
      vi.mocked(recipeSchedule).mockResolvedValue(
        scheduleOf([openVersion], 'tok-2'),
      );
      fireEvent.click(save());
      expect(
        await screen.findByText(costingChangedMessage),
      ).toBeInTheDocument();
      expect(screen.queryByText(unknownSaveMessage)).not.toBeInTheDocument();
      expect(recipeSchedule).toHaveBeenCalledTimes(2);
      await waitFor(() => {
        expect(save()).toBeEnabled();
      });

      fireEvent.click(save());
      await waitFor(() => {
        expect(setRecipeVersion).toHaveBeenCalledTimes(2);
      });
      expect(sent(1).requestId).not.toBe(sent(0).requestId);
      expect(sent(0).token).toBe('tok-1');
      expect(sent(1).token).toBe('tok-2');
    });

    it('retires the request and reloads the schedule on a definite refusal', async () => {
      await open();
      vi.mocked(setRecipeVersion).mockRejectedValueOnce(
        Object.assign(new Error('سطر 1: الكمية لازم تكون رقم أكبر من صفر'), {
          code: 'P0001',
        }),
      );
      fireEvent.click(save());
      expect(
        await screen.findByText('سطر 1: الكمية لازم تكون رقم أكبر من صفر'),
      ).toBeInTheDocument();
      expect(screen.queryByText(unknownSaveMessage)).not.toBeInTheDocument();
      expect(recipeSchedule).toHaveBeenCalledTimes(2);

      fireEvent.click(save());
      await waitFor(() => {
        expect(setRecipeVersion).toHaveBeenCalledTimes(2);
      });
      expect(sent(1).requestId).not.toBe(sent(0).requestId);
    });

    it('keeps the edited rows when the schedule is reloaded after a refusal', async () => {
      await open();
      vi.mocked(setRecipeVersion).mockRejectedValueOnce(
        Object.assign(new Error('الوصفة هتبقى غير صالحة في الوقت ده'), {
          code: '23514',
        }),
      );
      fireEvent.change(screen.getByLabelText('الكمية 1'), {
        target: { value: '7' },
      });
      fireEvent.click(save());
      await screen.findByText('الوصفة هتبقى غير صالحة في الوقت ده');
      expect(screen.getByLabelText('الكمية 1')).toHaveValue('7');
    });
  });

  describe('preview', () => {
    it('shows the ready requirements for one portion of a dish, without prices', async () => {
      await open();
      expect(
        await screen.findByRole('list', { name: 'المكونات المطلوبة' }),
      ).toHaveTextContent('زيت: 0.25 لتر');
      expect(expandRecipe).toHaveBeenCalledWith('r1', '1', 'portion', nowIso);
      expect(screen.getByLabelText('كمية المعاينة')).toHaveValue('1');
      expect(document.body.textContent).not.toMatch(/جنيه|EGP|ج\.م|سعر|تكلفة/);
    });

    it('previews a shift start at its own second, not the minute before', async () => {
      const before = versionOf(
        'v1',
        '2026-07-01T00:00:00+00:00',
        '2026-07-15T09:00:35+00:00',
      );
      const after = versionOf('v2', '2026-07-15T09:00:35+00:00', null, [
        saltLine,
      ]);
      vi.setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
      await open({
        shiftStart: '2026-07-15T09:00:35.000Z',
        schedule: scheduleOf([before, after]),
      });
      expect(screen.getByLabelText('المكوّن 1')).toHaveValue('item:salt');
      await waitFor(() => {
        expect(expandRecipe).toHaveBeenCalledWith(
          'r1',
          '1',
          'portion',
          '2026-07-15T09:00:35.000Z',
        );
      });
      expect(expandRecipe).not.toHaveBeenCalledWith(
        'r1',
        '1',
        'portion',
        '2026-07-15T09:00:00.000Z',
      );
    });

    it('previews "now" at the current minute, as the server stamps it', async () => {
      vi.setSystemTime(new Date('2026-07-15T09:00:35.250Z'));
      await open();
      await waitFor(() => {
        expect(expandRecipe).toHaveBeenCalledWith(
          'r1',
          '1',
          'portion',
          '2026-07-15T09:00:00.000Z',
        );
      });
    });

    it('previews one kilo of a cooking recipe', async () => {
      await open({
        recipe: recipeOf('cooking'),
        schedule: scheduleOf([openVersion]),
      });
      await screen.findByRole('list', { name: 'المكونات المطلوبة' });
      expect(expandRecipe).toHaveBeenCalledWith('r1', '1', 'kg', nowIso);
    });

    it('previews the batch quantity of a batch recipe in its own unit', async () => {
      const batchVersion = versionOf(
        'v1',
        '2026-07-01T00:00:00+00:00',
        null,
        [oilLine],
        {
          qty: '2.5',
          unit: 'kg',
        },
      );
      await open({
        recipe: recipeOf('batch'),
        schedule: scheduleOf([batchVersion]),
      });
      await screen.findByRole('list', { name: 'المكونات المطلوبة' });
      expect(expandRecipe).toHaveBeenCalledWith('r1', '2.5', 'kg', nowIso);
      expect(screen.getByLabelText('كمية المعاينة')).toHaveValue('2.5');
      expect(screen.getByLabelText('وحدة المعاينة')).toHaveValue('kg');
    });

    it('lets the owner change the output quantity', async () => {
      await open();
      await screen.findByRole('list', { name: 'المكونات المطلوبة' });
      fireEvent.change(screen.getByLabelText('كمية المعاينة'), {
        target: { value: '2,5' },
      });
      await waitFor(() => {
        expect(expandRecipe).toHaveBeenCalledWith(
          'r1',
          '2.5',
          'portion',
          nowIso,
        );
      });
      fireEvent.change(screen.getByLabelText('كمية المعاينة'), {
        target: { value: '0' },
      });
      expect(
        screen.getByText('الكمية لازم تكون رقم أكبر من صفر'),
      ).toBeInTheDocument();
      expect(expandRecipe).not.toHaveBeenCalledWith(
        'r1',
        '0',
        'portion',
        nowIso,
      );
    });

    it('reports a recipe with nothing in force without asking the server', async () => {
      await open({ schedule: scheduleOf([]) });
      expect(
        screen.getByText('مفيش نسخة سارية للوصفة في الوقت ده'),
      ).toBeInTheDocument();
      expect(expandRecipe).not.toHaveBeenCalled();
    });

    it('shows a failed preview as an error', async () => {
      await open();
      vi.mocked(expandRecipe).mockRejectedValue(new Error('تعذر الاتصال'));
      fireEvent.change(screen.getByLabelText('كمية المعاينة'), {
        target: { value: '3' },
      });
      expect(await screen.findByText('تعذر الاتصال')).toBeInTheDocument();
    });

    it.each([
      ['no_version_in_force', 'مفيش نسخة سارية للوصفة في الوقت ده'],
      ['loss_not_set', 'نسبة الفاقد لسه متحددتش للصنف'],
      ['unit_not_convertible', 'الوحدة دي مالهاش تحويل'],
      ['cycle', 'الوصفة بتدخل في دايرة وبتستخدم نفسها'],
      ['depth_exceeded', 'التحضيرات متداخلة أكتر من اللازم'],
      ['below_precision', 'الكمية صغيرة أوي وبتتقرب لصفر'],
      ['invalid_output_unit', 'وحدة الإخراج مش مناسبة للوصفة دي'],
    ])('translates the blocked issue %s', async (code, message) => {
      await open({
        expansion: {
          status: 'blocked',
          issues: [{ code, recipeId: null, stockItemId: 'oil', unit: null }],
        },
      });
      const issues = await screen.findByRole('list', {
        name: 'مشاكل المعاينة',
      });
      expect(issues).toHaveTextContent(`${message} (زيت)`);
      expect(
        screen.queryByRole('list', { name: 'المكونات المطلوبة' }),
      ).not.toBeInTheDocument();
    });

    it('names a batch recipe in a blocked issue and falls back for an unknown code', async () => {
      await open({
        expansion: {
          status: 'blocked',
          issues: [
            { code: 'cycle', recipeId: 'sauce', stockItemId: null, unit: null },
            {
              code: 'something_new',
              recipeId: null,
              stockItemId: null,
              unit: null,
            },
          ],
        },
      });
      const issues = await screen.findByRole('list', {
        name: 'مشاكل المعاينة',
      });
      const rows = within(issues).getAllByRole('listitem');
      expect(rows[0]).toHaveTextContent(
        'الوصفة بتدخل في دايرة وبتستخدم نفسها (صلصة حمراء)',
      );
      expect(rows[1]).toHaveTextContent(genericCatalogError);
    });

    it('previews the saved version, so a new write refreshes it', async () => {
      await open();
      await screen.findByRole('list', { name: 'المكونات المطلوبة' });
      vi.mocked(recipeSchedule).mockResolvedValue(
        scheduleOf([openVersion], 'tok-2'),
      );
      fireEvent.click(save());
      await screen.findByText('نسخة الوصفة اتحفظت');
      await waitFor(() => {
        expect(expandRecipe).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('history', () => {
    it('lists dated versions in Cairo time with their line count', async () => {
      const winter = versionOf(
        'v0',
        '2026-01-15T10:00:00+00:00',
        '2026-07-01T00:00:00+00:00',
      );
      const summer = versionOf(
        'v1',
        '2026-07-01T00:00:00+00:00',
        '2026-07-10T09:30:00+00:00',
        [
          oilLine,
          {
            id: 'l2',
            stockItemId: 'salt',
            childRecipeId: null,
            quantity: '1',
            unit: 'kg',
          },
        ],
      );
      const current = versionOf('v2', '2026-07-10T09:30:00+00:00', null);
      await open({ schedule: scheduleOf([winter, summer, current]) });
      const history = screen.getByRole('region', { name: 'سجل النسخ' });
      const rows = within(history).getAllByRole('listitem');
      expect(rows).toHaveLength(3);
      expect(rows[0]).toHaveTextContent(
        'من 15/01/2026 12:00 إلى 01/07/2026 03:00 — 1 مكوّن',
      );
      expect(rows[1]).toHaveTextContent(
        'من 01/07/2026 03:00 إلى 10/07/2026 12:30 — 2 مكوّن',
      );
      expect(rows[2]).toHaveTextContent('من 10/07/2026 12:30 وبعدها — 1 مكوّن');
    });

    it('says so when there are no versions', async () => {
      await open({ schedule: scheduleOf([]) });
      expect(screen.getByText('لسه مفيش نسخ للوصفة دي')).toBeInTheDocument();
    });
  });
});
