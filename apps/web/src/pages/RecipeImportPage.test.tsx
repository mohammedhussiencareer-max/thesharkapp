import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { costingImpact } from '@/items/api';
import { impactLine } from '@/items/effective';
import { resetHeldWrites, unknownSaveMessage } from '@/items/request-id';
import { RecipeImportPage } from '@/pages/RecipeImportPage';
import {
  commitRecipeImport,
  fetchImportTokens,
  loadImportContext,
  type ImportAction,
} from '@/recipes/import/api';
import type { ImportContext } from '@/recipes/import/model';
import { parseRecipeWorkbook } from '@/recipes/import/parse';
import { structuralHash } from '@/recipes/import/payload';
import { importContext } from '@/test/import-context';
import {
  sampleNames,
  samplePriceValues,
  sampleWorkbook,
} from '@/test/sample-workbook';

vi.mock('@/items/api', () => ({
  costingImpact: vi.fn(),
  currentShiftStart: vi.fn(),
}));

vi.mock('@/recipes/import/api', () => ({
  loadImportContext: vi.fn(),
  fetchImportTokens: vi.fn(),
  commitRecipeImport: vi.fn(),
}));

const names = sampleNames();

const imported = {
  importId: 'import-1',
  counts: { recipes_created: 3, items_created: 3 },
  recipes: [],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/recipes/import']}>
      <Routes>
        <Route path="/recipes/import" element={<RecipeImportPage />} />
        <Route path="/recipes" element={<p>قائمة الوصفات</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function open(ctx: ImportContext = importContext()) {
  vi.mocked(loadImportContext).mockResolvedValue(ctx);
  renderPage();
  await screen.findByLabelText('ملف الوصفات (xlsx)');
}

function upload(bytes: Uint8Array = sampleWorkbook(), fileName = 'r.xlsx') {
  const file = new File([bytes as BlobPart], fileName);
  fireEvent.change(screen.getByLabelText('ملف الوصفات (xlsx)'), {
    target: { files: [file] },
  });
}

async function openReview(ctx?: ImportContext) {
  await open(ctx);
  upload();
  await screen.findByRole('region', { name: 'ملخص الملف' });
}

function confirmEverything() {
  for (const button of screen.getAllByRole('button', {
    name: /^أكّد (?!كل)/,
  })) {
    fireEvent.click(button);
  }
}

function saveButton() {
  return screen.getByRole('button', { name: 'احفظ الاستيراد' });
}

function sent(call = 0): ImportAction {
  return vi.mocked(commitRecipeImport).mock.calls[call]![0];
}

function ingredient(name: string) {
  return screen.getByRole('listitem', { name: `مكوّن ${name}` });
}

describe('RecipeImportPage', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.mocked(loadImportContext).mockReset();
    vi.mocked(fetchImportTokens).mockReset();
    vi.mocked(commitRecipeImport).mockReset();
    vi.mocked(costingImpact).mockReset();
    vi.mocked(costingImpact).mockResolvedValue({
      orders: 0,
      shifts: 0,
      movements: 0,
    });
    vi.mocked(fetchImportTokens).mockResolvedValue({
      recipes: new Map(),
      losses: new Map(),
    });
  });

  it('shows what the file holds, suggests matches, and shows no workbook price', async () => {
    await openReview();
    expect(
      screen.getByText(/3 وصفة، \d+ مكوّن، \d+ صف فاضي أو تعبئة اتخطى/),
    ).toBeInTheDocument();
    expect(screen.getByText(/نسب الفاقد: 3/)).toBeInTheDocument();
    expect(screen.getByText(/1 صنف تغليف/)).toBeInTheDocument();

    const dish = screen.getByRole('listitem', { name: `وصفة ${names.dish}` });
    expect(within(dish).getByText(/في المنيو/)).toBeInTheDocument();
    const sauce = screen.getByRole('listitem', { name: `وصفة ${names.sauce}` });
    expect(within(sauce).getByLabelText(/نوع الوصفة/)).toHaveValue('batch');
    expect(within(sauce).getByLabelText(/كمية التحضيرة/)).toHaveValue('2400');

    expect(
      within(ingredient(names.salt)).getByText(/مقترح بنفس الاسم: ملح/),
    ).toBeInTheDocument();
    expect(
      within(ingredient(names.sauce)).getByText(
        /مقترح: وصفة بنفس الاسم في الملف/,
      ),
    ).toBeInTheDocument();
    expect(
      within(ingredient(names.fish)).getByText(/الاختيار: صنف جديد/),
    ).toBeInTheDocument();
    expect(
      within(ingredient(names.tomato)).getByLabelText(/اعتمد فاقد/),
    ).not.toBeChecked();

    const text = document.body.textContent ?? '';
    for (const value of samplePriceValues) {
      expect(text).not.toContain(String(value));
    }
  });

  it('refuses a file that is not an xlsx workbook', async () => {
    await open();
    upload(new TextEncoder().encode('not a zip'), 'r.xlsx');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'الملف مش ملف إكسل بصيغة .xlsx',
    );
    expect(screen.queryByRole('button', { name: 'احفظ الاستيراد' })).toBeNull();
  });

  it('retries a failed context load', async () => {
    vi.mocked(loadImportContext).mockRejectedValueOnce(
      new Error('تعذر التحميل'),
    );
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذر التحميل');
    vi.mocked(loadImportContext).mockResolvedValue(importContext());
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await screen.findByLabelText('ملف الوصفات (xlsx)');
  });

  it('notes a structure imported before and recipes the file no longer has', async () => {
    const hash = await structuralHash(parseRecipeWorkbook(sampleWorkbook()));
    await openReview(
      importContext({
        knownHashes: [hash],
        recipes: [
          {
            id: 'rec-old',
            name: 'سمك قديم',
            kind: 'dish',
            active: true,
            inForce: true,
          },
        ],
        bindings: [
          { source: 'سمك قديم', recipeId: 'rec-old', stockItemId: null },
        ],
      }),
    );
    expect(
      screen.getByText(/بنفس شكل استيراد اتعمل قبل كده/),
    ).toBeInTheDocument();
    expect(screen.getByText('سمك قديم')).toBeInTheDocument();
    expect(screen.getByText(/مش هتتوقف/)).toBeInTheDocument();
  });

  it('blocks the save until every row is confirmed and sends nothing', async () => {
    await openReview();
    fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'راجع الملاحظات الحمرا قبل الحفظ',
    );
    expect(commitRecipeImport).not.toHaveBeenCalled();
    expect(fetchImportTokens).not.toHaveBeenCalled();
    expect(
      screen.getAllByText('أكّد المكوّن أو اختار غيره').length,
    ).toBeGreaterThan(0);
  });

  it('sends exactly one commit with the confirmed review and no workbook price', async () => {
    vi.mocked(commitRecipeImport).mockResolvedValue(imported);
    await openReview();
    confirmEverything();
    fireEvent.click(saveButton());
    await screen.findByRole('region', { name: 'نتيجة الاستيراد' });

    expect(commitRecipeImport).toHaveBeenCalledTimes(1);
    const { requestId, payload } = sent();
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.recipes).toHaveLength(3);
    expect(payload.items.map((item) => item.name).sort()).toEqual(
      [names.fish, names.garlic, names.oil, names.tomato].sort(),
    );
    expect(payload.effective_from).toBeNull();
    expect(payload.manual_opening_prices).toEqual([]);
    expect(payload.losses).toEqual([]);
    const text = JSON.stringify(payload);
    for (const value of samplePriceValues) {
      expect(text).not.toContain(String(value));
    }
    expect(screen.getByRole('link', { name: 'شوف الوصفات' })).toHaveAttribute(
      'href',
      '/recipes',
    );
    expect(screen.getByText('وصفات جديدة: 3')).toBeInTheDocument();
  });

  it('covers confirm, pick another, create new, loss approval and a typed price', async () => {
    vi.mocked(commitRecipeImport).mockResolvedValue(imported);
    await openReview();
    confirmEverything();

    fireEvent.click(
      screen.getByRole('button', { name: `اختار غيره لـ ${names.salt}` }),
    );
    fireEvent.change(screen.getByLabelText(`الاختيار لـ ${names.salt}`), {
      target: { value: 'item:item-rice' },
    });
    expect(
      within(ingredient(names.salt)).getByText(/الاختيار: ارز خام/),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', {
        name: `اعمل صنف جديد بدل ${names.riceRaw}`,
      }),
    );
    fireEvent.change(
      screen.getByLabelText(`اسم الصنف الجديد لـ ${names.riceRaw}`),
      {
        target: { value: 'أرز مصري' },
      },
    );

    fireEvent.click(
      within(ingredient(names.tomato)).getByLabelText(/اعتمد فاقد طماطم: 20%/),
    );
    fireEvent.change(screen.getByLabelText(/سعر افتتاحي اختياري لـ سمك بوري/), {
      target: { value: '12.5' },
    });
    expect(
      screen.queryByLabelText(`سعر افتتاحي اختياري لـ ${names.salt}`),
    ).toBeNull();

    fireEvent.click(saveButton());
    await screen.findByRole('region', { name: 'نتيجة الاستيراد' });
    expect(commitRecipeImport).toHaveBeenCalledTimes(1);

    const { payload } = sent();
    const dish = payload.recipes.find((entry) => entry.name === names.dish)!;
    expect(dish.lines).toContainEqual({
      stock_item_id: 'item-rice',
      quantity: '5',
      unit: 'g',
    });
    const created = payload.items.find((item) => item.name === 'أرز مصري')!;
    const tomato = payload.items.find((item) => item.name === names.tomato)!;
    const fish = payload.items.find((item) => item.name === names.fish)!;
    expect(created).toBeDefined();
    expect(payload.losses).toEqual([{ item_key: tomato.key, loss_pct: '0.2' }]);
    expect(payload.manual_opening_prices).toEqual([
      { item_key: fish.key, unit_cost: '12.5' },
    ]);
  });

  it('needs a reason for a typed zero price', async () => {
    vi.mocked(commitRecipeImport).mockResolvedValue(imported);
    await openReview();
    confirmEverything();
    fireEvent.change(screen.getByLabelText(/سعر افتتاحي اختياري لـ سمك بوري/), {
      target: { value: '0' },
    });
    fireEvent.click(saveButton());
    expect(
      await within(ingredient(names.fish)).findByText('اكتب سبب إن السعر صفر'),
    ).toBeInTheDocument();
    expect(commitRecipeImport).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(`سبب السعر صفر لـ ${names.fish}`), {
      target: { value: 'هدية' },
    });
    fireEvent.click(saveButton());
    await screen.findByRole('region', { name: 'نتيجة الاستيراد' });
    const fish = sent().payload.items.find((item) => item.name === names.fish)!;
    expect(sent().payload.manual_opening_prices).toEqual([
      { item_key: fish.key, unit_cost: '0', zero_cost_reason: 'هدية' },
    ]);
  });

  it('sends the tokens of the existing recipes and losses it touches', async () => {
    vi.mocked(commitRecipeImport).mockResolvedValue(imported);
    vi.mocked(fetchImportTokens).mockResolvedValue({
      recipes: new Map([['rec-dish', 'token-dish']]),
      losses: new Map(),
    });
    await openReview(
      importContext({
        recipes: [
          {
            id: 'rec-dish',
            name: names.dish,
            kind: 'dish',
            active: true,
            inForce: true,
          },
        ],
      }),
    );
    confirmEverything();
    fireEvent.click(saveButton());
    await screen.findByRole('region', { name: 'نتيجة الاستيراد' });
    expect(fetchImportTokens).toHaveBeenCalledWith({
      recipeIds: ['rec-dish'],
      itemIds: [],
    });
    const dish = sent().payload.recipes.find(
      (entry) => entry.recipe_id === 'rec-dish',
    )!;
    expect(dish.expected_token).toBe('token-dish');
    expect(dish).not.toHaveProperty('name');
  });

  describe('effective time', () => {
    const shiftStart = new Date(Date.now() - 3 * 3_600_000).toISOString();

    it('needs a reason and a ready impact for a backdated start', async () => {
      vi.mocked(commitRecipeImport).mockResolvedValue(imported);
      vi.mocked(costingImpact).mockResolvedValue({
        orders: 2,
        shifts: 1,
        movements: 0,
      });
      await openReview(importContext({ shiftStart }));
      confirmEverything();

      expect(screen.getByLabelText('وقت السريان')).toHaveValue('shift');
      fireEvent.click(saveButton());
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'اكتب سبب التغيير بأثر رجعي',
      );
      expect(commitRecipeImport).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText('سبب التغيير'), {
        target: { value: 'سعر قديم' },
      });
      await screen.findByText(impactLine(2, 1));
      fireEvent.click(saveButton());
      await screen.findByRole('region', { name: 'نتيجة الاستيراد' });
      expect(sent().payload.effective_from).toBe(shiftStart);
      expect(sent().payload.reason).toBe('سعر قديم');
    });

    it('sends no start and no reason for now', async () => {
      vi.mocked(commitRecipeImport).mockResolvedValue(imported);
      await openReview(importContext({ shiftStart }));
      confirmEverything();
      fireEvent.change(screen.getByLabelText('وقت السريان'), {
        target: { value: 'now' },
      });
      expect(screen.queryByLabelText('سبب التغيير')).toBeNull();
      fireEvent.click(saveButton());
      await screen.findByRole('region', { name: 'نتيجة الاستيراد' });
      expect(sent().payload.effective_from).toBeNull();
      expect(sent().payload.reason).toBeNull();
    });
  });

  describe('unknown outcomes', () => {
    it('locks the review and retries the identical request', async () => {
      vi.mocked(commitRecipeImport)
        .mockRejectedValueOnce(new Error('فشل الاتصال'))
        .mockResolvedValueOnce(imported);
      await openReview();
      confirmEverything();
      fireEvent.click(saveButton());

      expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
      expect(screen.getByLabelText('ملف الوصفات (xlsx)')).toBeDisabled();
      expect(commitRecipeImport).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
      await screen.findByRole('region', { name: 'نتيجة الاستيراد' });
      expect(commitRecipeImport).toHaveBeenCalledTimes(2);
      expect(sent(1).requestId).toBe(sent(0).requestId);
      expect(sent(1).payload).toEqual(sent(0).payload);
      expect(fetchImportTokens).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(unknownSaveMessage)).toBeNull();
    });

    it('frees the form after a refusal and uses a new request id for the next save', async () => {
      vi.mocked(commitRecipeImport)
        .mockRejectedValueOnce(
          Object.assign(new Error('في اسم متكرر في الاستيراد'), {
            code: '22023',
          }),
        )
        .mockResolvedValueOnce(imported);
      await openReview();
      confirmEverything();
      fireEvent.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'في اسم متكرر في الاستيراد',
      );
      expect(screen.queryByText(unknownSaveMessage)).toBeNull();
      await waitFor(() => expect(saveButton()).toBeEnabled());

      fireEvent.click(saveButton());
      await screen.findByRole('region', { name: 'نتيجة الاستيراد' });
      expect(commitRecipeImport).toHaveBeenCalledTimes(2);
      expect(sent(1).requestId).not.toBe(sent(0).requestId);
    });
  });
});
