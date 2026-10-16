import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addConversion,
  createItem,
  listConversions,
  listItems,
  updateConversion,
  updateItem,
} from '@/items/api';
import { StaleWriteError } from '@/items/errors';
import type { BaseUnit, CatalogItem, UnitConversion } from '@/items/types';
import { ItemsPage } from '@/pages/ItemsPage';

vi.mock('@/items/api', () => ({
  listItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  listConversions: vi.fn(),
  addConversion: vi.fn(),
  updateConversion: vi.fn(),
  deleteConversion: vi.fn(),
}));

function item(
  overrides: Partial<CatalogItem> & Pick<CatalogItem, 'id' | 'name' | 'kind'>,
): CatalogItem {
  const row: CatalogItem = {
    baseUnit: 'kg',
    countFrequency: 'daily',
    lossPct: 0,
    storedLossPct: 0,
    parentItemId: null,
    active: true,
    onHandQty: 0,
    avgCost: 0,
    onHandValue: 0,
    ...overrides,
  };
  if (overrides.storedLossPct === undefined) row.storedLossPct = row.lossPct;
  return row;
}

const catalog: CatalogItem[] = [
  item({
    id: 'mixed',
    name: 'بوري مخلوط',
    kind: 'fish_mixed',
    onHandQty: 1.5,
    avgCost: 100,
    onHandValue: 150,
  }),
  item({
    id: 'size',
    name: 'بوري كبير',
    kind: 'fish_size',
    parentItemId: 'mixed',
  }),
  item({
    id: 'mixed-off',
    name: 'مرجان مخلوط',
    kind: 'fish_mixed',
    active: false,
  }),
  item({
    id: 'size-off',
    name: 'مرجان صغير',
    kind: 'fish_size',
    parentItemId: 'mixed-off',
  }),
  item({
    id: 'shrimp',
    name: 'جمبري',
    kind: 'seafood',
    countFrequency: 'weekly',
    lossPct: 0.125,
    onHandQty: 2,
    avgCost: 80.5,
    onHandValue: 161,
  }),
  item({
    id: 'oil',
    name: 'زيت',
    kind: 'ingredient',
    baseUnit: 'liter',
    countFrequency: 'weekly',
    active: false,
  }),
  item({
    id: 'box',
    name: 'علبة',
    kind: 'packaging',
    baseUnit: 'piece',
    countFrequency: 'weekly',
  }),
];

function listed(rows: UnitConversion[], baseUnit: BaseUnit) {
  return { baseUnit, rows };
}

async function renderCatalog(items: CatalogItem[] = catalog) {
  vi.mocked(listItems).mockResolvedValue(items);
  render(
    <MemoryRouter>
      <ItemsPage />
    </MemoryRouter>,
  );
  if (items.some((row) => row.name === 'بوري مخلوط')) {
    expect(
      await screen.findByRole('heading', { name: 'بوري مخلوط' }),
    ).toBeInTheDocument();
  }
}

describe('ItemsPage', () => {
  beforeEach(() => {
    vi.mocked(listItems).mockReset();
    vi.mocked(listItems).mockResolvedValue([]);
    vi.mocked(createItem).mockReset();
    vi.mocked(createItem).mockResolvedValue(undefined);
    vi.mocked(updateItem).mockReset();
    vi.mocked(updateItem).mockResolvedValue(undefined);
    vi.mocked(listConversions).mockReset();
    vi.mocked(listConversions).mockResolvedValue({ baseUnit: 'kg', rows: [] });
    vi.mocked(addConversion).mockReset();
    vi.mocked(addConversion).mockResolvedValue(undefined);
  });

  it('shows a loading state and then the grouped Arabic catalog', async () => {
    let resolveItems: (value: CatalogItem[]) => void = () => undefined;
    vi.mocked(listItems).mockReturnValue(
      new Promise((resolve) => {
        resolveItems = resolve;
      }),
    );
    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('جاري تحميل الأصناف…')).toBeInTheDocument();
    resolveItems(catalog);

    expect(
      await screen.findByRole('heading', { name: 'سمك مخلوط' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'مأكولات بحرية' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'تغليف' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'مكونات' }),
    ).not.toBeInTheDocument();

    const mixed = screen.getByRole('article', { name: 'بوري مخلوط' });
    const block = mixed.parentElement;
    if (!block) throw new Error('missing fish block');
    expect(
      within(block).getByRole('heading', { name: 'حجم سمك' }),
    ).toBeInTheDocument();
    expect(
      within(block).getByRole('heading', { name: 'بوري كبير' }),
    ).toBeInTheDocument();
    expect(within(mixed).getByText('يومي')).toBeInTheDocument();
    expect(within(mixed).getByText('1.5 كيلو')).toBeInTheDocument();
    expect(within(mixed).getByText('100.00 ج.م')).toBeInTheDocument();
    expect(within(mixed).getByText('150.00 ج.م')).toBeInTheDocument();

    const shrimp = screen.getByRole('article', { name: 'جمبري' });
    expect(within(shrimp).getByText('فاقد 12.5%')).toBeInTheDocument();
    expect(within(shrimp).getByText('أسبوعي')).toBeInTheDocument();
    const box = screen.getByRole('article', { name: 'علبة' });
    expect(within(box).getByText('0 قطعة')).toBeInTheDocument();
    expect(within(box).getAllByText('0.00 ج.م')).toHaveLength(2);

    expect(screen.getByText('تحت مرجان مخلوط (موقوف)')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'مرجان مخلوط' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'مرجان صغير' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'زيت' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('موقوف')).not.toBeInTheDocument();
  });

  it('reveals inactive items from the toggle', async () => {
    await renderCatalog();

    fireEvent.click(screen.getByRole('checkbox', { name: 'عرض الموقوف' }));

    const oil = screen.getByRole('article', { name: 'زيت' });
    expect(within(oil).getByText('موقوف')).toBeInTheDocument();
    expect(within(oil).getByText('لتر')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'مكونات' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'مرجان مخلوط' }),
    ).toBeInTheDocument();
  });

  it('shows the empty catalog message', async () => {
    vi.mocked(listItems).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('لسه مفيش أصناف — ضيف أول صنف'),
    ).toBeInTheDocument();
  });

  it('retries a failed load', async () => {
    let calls = 0;
    vi.mocked(listItems).mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('حصل خطأ. حاول تاني.'));
      return Promise.resolve(catalog);
    });
    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'حصل خطأ. حاول تاني.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByRole('heading', { name: 'بوري مخلوط' }),
    ).toBeInTheDocument();
  });

  it('validates the form and stores loss percent as a fraction', async () => {
    await renderCatalog();
    fireEvent.click(screen.getByRole('button', { name: 'ضيف صنف' }));

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(screen.getByText('اكتب اسم الصنف')).toBeInTheDocument();
    expect(createItem).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('النوع'), {
      target: { value: 'packaging' },
    });
    expect(screen.getByLabelText('الوحدة الأساسية')).toHaveValue('piece');
    expect(screen.getByLabelText('الجرد')).toHaveValue('weekly');

    fireEvent.change(screen.getByLabelText('النوع'), {
      target: { value: 'seafood' },
    });
    expect(screen.getByLabelText('الوحدة الأساسية')).toHaveValue('kg');
    expect(screen.getByLabelText('الجرد')).toHaveValue('daily');
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: '  جمبري وسط  ' },
    });
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(screen.getByText('نسبة الفاقد من 0 لحد 99.999')).toBeInTheDocument();
    expect(createItem).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '12.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    await waitFor(() => {
      expect(createItem).toHaveBeenCalledWith({
        name: 'جمبري وسط',
        kind: 'seafood',
        baseUnit: 'kg',
        countFrequency: 'daily',
        lossPct: '0.125',
        parentItemId: null,
        active: true,
      });
    });
  });

  it('requires a mixed-fish parent for a size', async () => {
    await renderCatalog();
    fireEvent.click(screen.getByRole('button', { name: 'ضيف صنف' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'بوري وسط' },
    });
    fireEvent.change(screen.getByLabelText('النوع'), {
      target: { value: 'fish_size' },
    });
    expect(screen.getByLabelText('الوحدة الأساسية')).toHaveValue('kg');
    expect(screen.getByLabelText('الجرد')).toHaveValue('daily');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(screen.getByText('اختار السمك المخلوط')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('السمك المخلوط'), {
      target: { value: 'mixed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    await waitFor(() => {
      expect(createItem).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'بوري وسط',
          kind: 'fish_size',
          parentItemId: 'mixed',
          lossPct: '0',
        }),
      );
    });
  });

  it('shows a duplicate-name error from the server', async () => {
    await renderCatalog();
    vi.mocked(createItem).mockRejectedValueOnce(
      new Error('الاسم ده موجود قبل كده'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'ضيف صنف' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'بوري مخلوط' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'الاسم ده موجود قبل كده',
    );
    expect(screen.getByRole('form', { name: 'صنف جديد' })).toBeInTheDocument();
  });

  it('edits an item and blocks changing a mixed fish that has sizes', async () => {
    await renderCatalog();
    const mixed = screen.getByRole('article', { name: 'بوري مخلوط' });
    fireEvent.click(within(mixed).getByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('النوع'), {
      target: { value: 'seafood' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(
      screen.getByText('مينفعش تغيّر نوع السمك المخلوط وعنده أحجام'),
    ).toBeInTheDocument();
    expect(updateItem).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('النوع'), {
      target: { value: 'fish_mixed' },
    });
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'بوري جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    await waitFor(() => {
      expect(updateItem).toHaveBeenCalledWith(
        'mixed',
        expect.objectContaining({ name: 'بوري جديد', kind: 'fish_mixed' }),
        expect.objectContaining({ name: 'بوري مخلوط', kind: 'fish_mixed' }),
      );
    });
  });

  it('adds a conversion and rejects the item base unit', async () => {
    await renderCatalog();
    const rows: UnitConversion[] = [];
    vi.mocked(listConversions).mockImplementation(() =>
      Promise.resolve(listed([...rows], 'piece')),
    );
    vi.mocked(addConversion).mockImplementation((itemId, unit, factor) => {
      rows.push({
        itemId,
        unit,
        factorToBase: Number(factor),
        storedFactor: factor,
      });
      return Promise.resolve();
    });

    const box = screen.getByRole('article', { name: 'علبة' });
    fireEvent.click(within(box).getByRole('button', { name: 'التحويلات' }));
    expect(
      await within(box).findByText('مفيش تحويلات للصنف ده'),
    ).toBeInTheDocument();

    fireEvent.change(within(box).getByLabelText('اسم الوحدة'), {
      target: { value: 'piece' },
    });
    fireEvent.change(within(box).getByLabelText('المعامل'), {
      target: { value: '2' },
    });
    fireEvent.click(within(box).getByRole('button', { name: 'ضيف التحويل' }));
    expect(
      within(box).getByText('مينفعش التحويل يبقى بنفس الوحدة الأساسية'),
    ).toBeInTheDocument();
    expect(addConversion).not.toHaveBeenCalled();

    fireEvent.change(within(box).getByLabelText('اسم الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(within(box).getByLabelText('المعامل'), {
      target: { value: '12' },
    });
    fireEvent.click(within(box).getByRole('button', { name: 'ضيف التحويل' }));

    expect(
      await within(box).findByText('1 كرتونة = 12 قطعة'),
    ).toBeInTheDocument();
    expect(addConversion).toHaveBeenCalledWith('box', 'كرتونة', '12', 'piece');
  });

  it('locks the inactive filter while an inactive item conversion saves', async () => {
    vi.mocked(updateConversion).mockReset();
    await renderCatalog();
    const initial: UnitConversion = {
      itemId: 'oil',
      unit: 'جركن',
      factorToBase: 1,
      storedFactor: 1,
    };
    let resolveReload: (value: ReturnType<typeof listed>) => void = () =>
      undefined;
    let calls = 0;
    vi.mocked(listConversions).mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(listed([initial], 'liter'));
      return new Promise((resolve) => {
        resolveReload = resolve;
      });
    });
    vi.mocked(updateConversion).mockResolvedValue(undefined);

    const filter = screen.getByRole('checkbox', { name: 'عرض الموقوف' });
    fireEvent.click(filter);
    const oil = await screen.findByRole('article', { name: 'زيت' });
    fireEvent.click(within(oil).getByRole('button', { name: 'التحويلات' }));
    expect(await within(oil).findByText('1 جركن = 1 لتر')).toBeInTheDocument();

    fireEvent.change(within(oil).getByLabelText('معامل جركن'), {
      target: { value: '2' },
    });
    fireEvent.click(within(oil).getByRole('button', { name: 'حفظ المعامل' }));
    await waitFor(() => expect(filter).toBeDisabled());

    resolveReload(
      listed([{ ...initial, factorToBase: 2, storedFactor: 2 }], 'liter'),
    );
    expect(await within(oil).findByText('1 جركن = 2 لتر')).toBeInTheDocument();
    await waitFor(() => expect(filter).toBeEnabled());
  });

  it('locks an open item editor while a conversion save reloads', async () => {
    vi.mocked(updateConversion).mockReset();
    await renderCatalog();
    const initial: UnitConversion = {
      itemId: 'box',
      unit: 'كرتونة',
      factorToBase: 1,
      storedFactor: 1,
    };
    let resolveReload: (value: ReturnType<typeof listed>) => void = () =>
      undefined;
    let calls = 0;
    vi.mocked(listConversions).mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(listed([initial], 'piece'));
      return new Promise((resolve) => {
        resolveReload = resolve;
      });
    });
    vi.mocked(updateConversion).mockResolvedValue(undefined);

    const box = screen.getByRole('article', { name: 'علبة' });
    fireEvent.click(within(box).getByRole('button', { name: 'تعديل' }));
    fireEvent.click(within(box).getByRole('button', { name: 'التحويلات' }));
    expect(
      await within(box).findByText('1 كرتونة = 1 قطعة'),
    ).toBeInTheDocument();

    fireEvent.change(within(box).getByLabelText('معامل كرتونة'), {
      target: { value: '2' },
    });
    fireEvent.click(within(box).getByRole('button', { name: 'حفظ المعامل' }));

    const save = () => screen.getByRole('button', { name: /^حفظ$/ });
    await waitFor(() => expect(save()).toBeDisabled());
    expect(within(box).getByRole('button', { name: 'تعديل' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeDisabled();
    fireEvent.click(save());
    expect(updateItem).not.toHaveBeenCalled();

    resolveReload(
      listed([{ ...initial, factorToBase: 2, storedFactor: 2 }], 'piece'),
    );
    expect(
      await within(box).findByText('1 كرتونة = 2 قطعة'),
    ).toBeInTheDocument();
    await waitFor(() => expect(save()).toBeEnabled());
  });

  it('locks conversion actions while an item save is in flight', async () => {
    await renderCatalog();
    vi.mocked(listConversions).mockResolvedValue(
      listed(
        [{ itemId: 'box', unit: 'كرتونة', factorToBase: 1, storedFactor: 1 }],
        'piece',
      ),
    );
    let resolveSave: () => void = () => undefined;
    vi.mocked(updateItem).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const box = screen.getByRole('article', { name: 'علبة' });
    fireEvent.click(within(box).getByRole('button', { name: 'التحويلات' }));
    expect(
      await within(box).findByText('1 كرتونة = 1 قطعة'),
    ).toBeInTheDocument();
    fireEvent.click(within(box).getByRole('button', { name: 'تعديل' }));
    fireEvent.click(screen.getByRole('button', { name: /^حفظ$/ }));

    await waitFor(() =>
      expect(
        within(box).getByRole('button', { name: 'حفظ المعامل' }),
      ).toBeDisabled(),
    );
    expect(
      within(box).getByRole('button', { name: 'ضيف التحويل' }),
    ).toBeDisabled();
    expect(
      within(box).getByRole('button', { name: 'التحويلات' }),
    ).toBeDisabled();

    resolveSave();
    await waitFor(() =>
      expect(
        within(box).getByRole('button', { name: 'حفظ المعامل' }),
      ).toBeEnabled(),
    );
  });

  it('does not switch editors while a save is in flight', async () => {
    let resolveSave: (value: void) => void = () => undefined;
    vi.mocked(updateItem).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    await renderCatalog();

    const mixed = screen.getByRole('article', { name: 'بوري مخلوط' });
    fireEvent.click(within(mixed).getByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'بوري جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeDisabled();
    const size = screen.getByRole('article', { name: 'بوري كبير' });
    const sizeEdit = within(size).getByRole('button', { name: 'تعديل' });
    expect(sizeEdit).toBeDisabled();

    fireEvent.click(sizeEdit);
    fireEvent.click(screen.getByRole('button', { name: 'ضيف صنف' }));
    expect(screen.getByLabelText('الاسم')).toHaveValue('بوري جديد');

    resolveSave();
    await waitFor(() => {
      expect(screen.queryByRole('form')).not.toBeInTheDocument();
    });
  });

  it('keeps the editor closed until the saved name reloads', async () => {
    await renderCatalog();
    let resolveReload: (value: CatalogItem[]) => void = () => undefined;
    vi.mocked(listItems).mockReturnValue(
      new Promise((resolve) => {
        resolveReload = resolve;
      }),
    );

    const mixed = screen.getByRole('article', { name: 'بوري مخلوط' });
    fireEvent.click(within(mixed).getByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'بوري جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    await waitFor(() => {
      expect(screen.queryByRole('form')).not.toBeInTheDocument();
    });
    const edit = within(
      screen.getByRole('article', { name: 'بوري مخلوط' }),
    ).getByRole('button', { name: 'تعديل' });
    expect(edit).toBeDisabled();
    fireEvent.click(edit);
    expect(screen.queryByRole('form')).not.toBeInTheDocument();

    resolveReload(
      catalog.map((row) =>
        row.id === 'mixed' ? { ...row, name: 'بوري جديد' } : row,
      ),
    );

    expect(
      await screen.findByRole('heading', { name: 'بوري جديد' }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('article', { name: 'بوري جديد' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    expect(screen.getByLabelText('الاسم')).toHaveValue('بوري جديد');
  });

  it('refuses a stale item rename and shows the name that landed', async () => {
    let releaseFirst: () => void = () => undefined;
    let updates = 0;
    vi.mocked(updateItem).mockImplementation(() => {
      updates += 1;
      if (updates === 1) {
        return new Promise<void>((resolve) => {
          releaseFirst = () => resolve();
        });
      }
      throw new StaleWriteError();
    });
    const landed = catalog.map((row) =>
      row.id === 'mixed' ? { ...row, name: 'بوري جديد' } : row,
    );
    let loads = 0;
    vi.mocked(listItems).mockImplementation(() => {
      loads += 1;
      return Promise.resolve(loads >= 4 ? landed : catalog);
    });

    const first = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { name: 'بوري مخلوط' }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('article', { name: 'بوري مخلوط' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'بوري جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(updates).toBe(1));

    first.unmount();
    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { name: 'بوري مخلوط' }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('article', { name: 'بوري مخلوط' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    expect(screen.getByLabelText('الاسم')).toHaveValue('بوري مخلوط');

    releaseFirst();
    await waitFor(() => expect(loads).toBe(3));
    expect(screen.getByLabelText('الاسم')).toHaveValue('بوري مخلوط');

    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'اسم تاني' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'البيانات اتغيّرت من مكان تاني — اتعملها تحديث، راجعها واحفظ تاني',
    );
    expect(
      screen.getByRole('form', { name: 'تعديل الصنف' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('الاسم')).toHaveValue('بوري جديد');
    expect(updates).toBe(2);
    expect(vi.mocked(updateItem).mock.calls[1]?.[1]).toMatchObject({
      name: 'اسم تاني',
    });
    expect(vi.mocked(updateItem).mock.calls[1]?.[2]).toMatchObject({
      name: 'بوري مخلوط',
    });
  });

  it('refuses a stale factor save after leaving and reopening the page', async () => {
    let releaseFirst: () => void = () => undefined;
    vi.mocked(updateConversion).mockImplementation((_id, _unit, factor) => {
      if (factor === '2') {
        return new Promise<void>((resolve) => {
          releaseFirst = () => resolve();
        });
      }
      throw new StaleWriteError();
    });
    const row = (factor: number): UnitConversion => ({
      itemId: 'box',
      unit: 'كرتونة',
      factorToBase: factor,
      storedFactor: factor,
    });
    let loads = 0;
    vi.mocked(listConversions).mockImplementation(() => {
      loads += 1;
      return Promise.resolve(listed([row(loads >= 4 ? 2 : 1)], 'piece'));
    });
    vi.mocked(listItems).mockResolvedValue(catalog);

    const first = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    const opened = await screen.findByRole('article', { name: 'علبة' });
    fireEvent.click(within(opened).getByRole('button', { name: 'التحويلات' }));
    expect(
      await within(opened).findByText('1 كرتونة = 1 قطعة'),
    ).toBeInTheDocument();
    fireEvent.change(within(opened).getByLabelText('معامل كرتونة'), {
      target: { value: '2' },
    });
    fireEvent.click(
      within(opened).getByRole('button', { name: 'حفظ المعامل' }),
    );
    await waitFor(() =>
      expect(vi.mocked(updateConversion)).toHaveBeenCalledTimes(1),
    );
    expect(vi.mocked(updateConversion).mock.calls[0]?.[3]).toBe('1');
    expect(vi.mocked(updateConversion).mock.calls[0]?.[4]).toBe('piece');

    first.unmount();
    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    const reopened = await screen.findByRole('article', { name: 'علبة' });
    fireEvent.click(
      within(reopened).getByRole('button', { name: 'التحويلات' }),
    );
    expect(
      await within(reopened).findByText('1 كرتونة = 1 قطعة'),
    ).toBeInTheDocument();

    releaseFirst();
    await waitFor(() => expect(loads).toBe(3));
    expect(within(reopened).getByText('1 كرتونة = 1 قطعة')).toBeInTheDocument();

    fireEvent.change(within(reopened).getByLabelText('معامل كرتونة'), {
      target: { value: '3' },
    });
    fireEvent.click(
      within(reopened).getByRole('button', { name: 'حفظ المعامل' }),
    );

    expect(await within(reopened).findByRole('alert')).toHaveTextContent(
      'البيانات اتغيّرت من مكان تاني — اتعملها تحديث، راجعها واحفظ تاني',
    );
    expect(
      await within(reopened).findByText('1 كرتونة = 2 قطعة'),
    ).toBeInTheDocument();
    expect(
      within(reopened).queryByText('1 كرتونة = 3 قطعة'),
    ).not.toBeInTheDocument();
    expect(vi.mocked(updateConversion)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(updateConversion).mock.calls[1]).toEqual([
      'box',
      'كرتونة',
      '3',
      '1',
      'piece',
    ]);
  });

  it('reloads items when a conversion snapshot has a newer base unit', async () => {
    const oil = item({
      id: 'oil',
      name: 'زيت',
      kind: 'ingredient',
      baseUnit: 'kg',
      active: true,
    });
    const oilLiter = { ...oil, baseUnit: 'liter' as const };
    let loads = 0;
    vi.mocked(listItems).mockImplementation(() => {
      loads += 1;
      return Promise.resolve(loads === 1 ? [oil] : [oilLiter]);
    });
    vi.mocked(listConversions).mockResolvedValue(
      listed(
        [{ itemId: 'oil', unit: 'كيس', factorToBase: 2, storedFactor: '2' }],
        'liter',
      ),
    );

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );

    const card = await screen.findByRole('article', { name: 'زيت' });
    fireEvent.click(within(card).getByRole('button', { name: 'تعديل' }));
    expect(screen.getByLabelText('الوحدة الأساسية')).toHaveValue('kg');
    fireEvent.click(within(card).getByRole('button', { name: 'التحويلات' }));

    expect(await within(card).findByText('1 كيس = 2 لتر')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('الوحدة الأساسية')).toHaveValue('liter');
    });
    expect(loads).toBeGreaterThanOrEqual(2);
  });

  it('re-initializes the editor from the same row as its expectation', async () => {
    const oil = item({
      id: 'oil',
      name: 'زيت',
      kind: 'ingredient',
      baseUnit: 'kg',
      active: true,
    });
    const box = item({
      id: 'box',
      name: 'علبة',
      kind: 'packaging',
      baseUnit: 'piece',
      countFrequency: 'weekly',
    });
    const boxRenamed = { ...box, name: 'علبة كبيرة' };
    const oilLiter = { ...oil, baseUnit: 'liter' as const };
    let loads = 0;
    vi.mocked(listItems).mockImplementation(() => {
      loads += 1;
      return Promise.resolve(loads === 1 ? [oil, box] : [oilLiter, boxRenamed]);
    });
    vi.mocked(listConversions).mockResolvedValue(listed([], 'liter'));

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );

    const boxCard = await screen.findByRole('article', { name: 'علبة' });
    fireEvent.click(within(boxCard).getByRole('button', { name: 'تعديل' }));
    expect(screen.getByLabelText('الاسم')).toHaveValue('علبة');

    // Another item's stale conversion snapshot reloads the whole catalog.
    const oilCard = screen.getByRole('article', { name: 'زيت' });
    fireEvent.click(within(oilCard).getByRole('button', { name: 'التحويلات' }));
    const renamedCard = await screen.findByRole('article', {
      name: 'علبة كبيرة',
    });

    fireEvent.click(within(renamedCard).getByRole('button', { name: 'تعديل' }));
    expect(screen.getByLabelText('الاسم')).toHaveValue('علبة كبيرة');
    fireEvent.click(screen.getByRole('button', { name: /^حفظ$/ }));

    await waitFor(() => {
      expect(updateItem).toHaveBeenCalledWith(
        'box',
        expect.objectContaining({ name: 'علبة كبيرة' }),
        expect.objectContaining({ name: 'علبة كبيرة' }),
      );
    });
  });
});
