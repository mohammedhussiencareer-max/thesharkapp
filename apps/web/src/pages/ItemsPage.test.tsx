import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addConversion,
  costingImpact,
  createItem,
  currentShiftStart,
  deleteConversion,
  listConversions,
  listCostingSchedule,
  listItems,
  setItemLoss,
  setOpeningPrice,
  updateConversion,
  updateItem,
} from '@/items/api';
import {
  emptyScheduleToken,
  impactErrorMessage,
  impactLoadingMessage,
  impactPendingMessage,
} from '@/items/effective';
import {
  CostingChangedError,
  identityOutOfDateMessage,
  saveDetailsFirstMessage,
  StaleWriteError,
} from '@/items/errors';
import { resetHeldWrites, unknownSaveMessage } from '@/items/request-id';
import {
  itemIdentity,
  type BaseUnit,
  type CatalogItem,
  type CostingSchedule,
  type UnitConversion,
} from '@/items/types';
import { ItemsPage } from '@/pages/ItemsPage';

vi.mock('@/items/api', () => ({
  listItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  setItemLoss: vi.fn(),
  setOpeningPrice: vi.fn(),
  listConversions: vi.fn(),
  addConversion: vi.fn(),
  updateConversion: vi.fn(),
  deleteConversion: vi.fn(),
  currentShiftStart: vi.fn(() => Promise.resolve(null)),
  listCostingSchedule: vi.fn(() =>
    Promise.resolve({
      lossToken: 'd41d8cd98f00b204e9800998ecf8427e',
      identity: 'kg|seafood||',
      lossVersions: [],
      conversions: [],
    }),
  ),
  costingImpact: vi.fn(() =>
    Promise.resolve({ orders: 2, shifts: 1, movements: 4 }),
  ),
  listUnitOptions: vi.fn(() =>
    Promise.resolve([
      { code: 'piece', labelAr: 'قطعة' },
      { code: 'كرتونة', labelAr: 'كرتونة' },
      { code: 'كيس', labelAr: 'كيس' },
    ]),
  ),
  addCustomUnit: vi.fn((code: string) => Promise.resolve(code)),
}));

function item(
  overrides: Partial<CatalogItem> & Pick<CatalogItem, 'id' | 'name' | 'kind'>,
): CatalogItem {
  const row: CatalogItem = {
    baseUnit: 'kg',
    countFrequency: 'daily',
    lossPct: 0,
    parentItemId: null,
    active: true,
    onHandQty: 0,
    avgCost: 0,
    onHandValue: 0,
    ...overrides,
  };
  return row;
}

const scheduleIdentity = 'kg|seafood||';
const sizeIdentity = 'kg|fish_size|mixed|';

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

let served: CatalogItem[] = catalog;

function emptySchedule(itemId: string): CostingSchedule {
  const row = served.find((candidate) => candidate.id === itemId);
  return {
    lossToken: 'd41d8cd98f00b204e9800998ecf8427e',
    identity: row ? itemIdentity(row) : scheduleIdentity,
    lossVersions: [],
    conversions: [],
  };
}

async function renderCatalog(items: CatalogItem[] = catalog) {
  served = items;
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
    resetHeldWrites();
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
    vi.mocked(setItemLoss).mockReset();
    vi.mocked(setItemLoss).mockResolvedValue(undefined);
    vi.mocked(setOpeningPrice).mockReset();
    vi.mocked(setOpeningPrice).mockResolvedValue(undefined);
    vi.mocked(currentShiftStart).mockReset();
    vi.mocked(currentShiftStart).mockResolvedValue(null);
    vi.mocked(costingImpact).mockReset();
    vi.mocked(costingImpact).mockResolvedValue({
      orders: 2,
      shifts: 1,
      movements: 4,
    });
    served = catalog;
    vi.mocked(listCostingSchedule).mockReset();
    vi.mocked(listCostingSchedule).mockImplementation((itemId) =>
      Promise.resolve(emptySchedule(itemId)),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
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
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

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
    expect(
      await within(box).findByRole('option', { name: 'قطعة' }),
    ).toBeInTheDocument();

    fireEvent.change(within(box).getByLabelText('الوحدة'), {
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

    fireEvent.change(within(box).getByLabelText('الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(within(box).getByLabelText('المعامل'), {
      target: { value: '12' },
    });
    fireEvent.click(within(box).getByRole('button', { name: 'ضيف التحويل' }));

    expect(
      await within(box).findByText('1 كرتونة = 12 قطعة'),
    ).toBeInTheDocument();
    expect(addConversion).toHaveBeenCalledWith(
      'box',
      'كرتونة',
      '12',
      'piece',
      expect.objectContaining({ effectiveFrom: null, reason: null }),
    );
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

    const save = () => screen.getByRole('button', { name: 'حفظ البيانات' });
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
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

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
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeDisabled();
    const size = screen.getByRole('article', { name: 'بوري كبير' });
    const sizeEdit = within(size).getByRole('button', { name: 'تعديل' });
    expect(sizeEdit).toBeDisabled();

    fireEvent.click(sizeEdit);
    fireEvent.click(screen.getByRole('button', { name: 'ضيف صنف' }));
    expect(screen.getByLabelText('الاسم')).toHaveValue('بوري جديد');

    resolveSave();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeEnabled();
    });
    expect(screen.getByLabelText('الاسم')).toHaveValue('بوري جديد');
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
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'حفظ البيانات' }),
      ).toBeDisabled();
    });
    const edit = within(
      screen.getByRole('article', { name: 'بوري مخلوط' }),
    ).getByRole('button', { name: 'تعديل' });
    expect(edit).toBeDisabled();
    fireEvent.click(edit);
    expect(screen.getByLabelText('الاسم')).toHaveValue('بوري جديد');

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
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

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
      expect.objectContaining({
        effectiveFrom: null,
        effectiveTo: null,
        reason: null,
        token: emptyScheduleToken,
      }),
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
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    await waitFor(() => {
      expect(updateItem).toHaveBeenCalledWith(
        'box',
        expect.objectContaining({ name: 'علبة كبيرة' }),
        expect.objectContaining({ name: 'علبة كبيرة' }),
      );
    });
  });

  it('keeps the page locked until a reload after a landed save succeeds', async () => {
    await renderCatalog();
    vi.mocked(listItems).mockRejectedValueOnce(
      new Error('حصل خطأ. حاول تاني.'),
    );

    const mixed = screen.getByRole('article', { name: 'بوري مخلوط' });
    fireEvent.click(within(mixed).getByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'بوري جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'حصل خطأ. حاول تاني.',
    );
    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeDisabled();

    let resolveRetry: (value: CatalogItem[]) => void = () => undefined;
    vi.mocked(listItems).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRetry = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeDisabled();

    resolveRetry(
      catalog.map((row) =>
        row.id === 'mixed' ? { ...row, name: 'بوري جديد' } : row,
      ),
    );
    expect(
      await screen.findByRole('heading', { name: 'بوري جديد' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeEnabled();
  });

  it('does not let a retry finish unlock a save that is still running', async () => {
    const oil = item({
      id: 'oil',
      name: 'زيت',
      kind: 'ingredient',
      baseUnit: 'kg',
      active: true,
    });
    served = [oil];
    let loads = 0;
    vi.mocked(listItems).mockImplementation(() => {
      loads += 1;
      if (loads === 2) return Promise.reject(new Error('حصل خطأ. حاول تاني.'));
      return Promise.resolve([oil]);
    });
    // A newer base unit makes the panel reload the catalog, and that fails.
    vi.mocked(listConversions).mockResolvedValue(listed([], 'liter'));
    let releaseSave: () => void = () => undefined;
    vi.mocked(updateItem).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseSave = () => resolve(undefined);
      }),
    );

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('article', { name: 'زيت' });
    fireEvent.click(within(card).getByRole('button', { name: 'التحويلات' }));
    const retry = await screen.findByRole('button', {
      name: 'إعادة المحاولة',
    });

    fireEvent.click(within(card).getByRole('button', { name: 'تعديل' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    await waitFor(() => {
      expect(updateItem).toHaveBeenCalledTimes(1);
    });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(loads).toBe(2);

    releaseSave();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeEnabled();
    });
    expect(
      screen.getByRole('form', { name: 'تعديل الصنف' }),
    ).toBeInTheDocument();
  });

  it('locks the page while a stale-snapshot catalog reload is in flight', async () => {
    const oil = item({
      id: 'oil',
      name: 'زيت',
      kind: 'ingredient',
      baseUnit: 'kg',
      active: true,
    });
    served = [oil];
    let resolveStaleReload: (value: CatalogItem[]) => void = () => undefined;
    let loads = 0;
    vi.mocked(listItems).mockImplementation(() => {
      loads += 1;
      if (loads === 2) {
        return new Promise((resolve) => {
          resolveStaleReload = resolve;
        });
      }
      return Promise.resolve([oil]);
    });
    vi.mocked(listConversions).mockResolvedValue(listed([], 'liter'));

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('article', { name: 'زيت' });
    fireEvent.click(within(card).getByRole('button', { name: 'تعديل' }));
    fireEvent.click(within(card).getByRole('button', { name: 'التحويلات' }));

    await waitFor(() => {
      expect(loads).toBe(2);
    });
    expect(screen.getByRole('button', { name: 'حفظ البيانات' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    expect(updateItem).not.toHaveBeenCalled();

    served = [{ ...oil, baseUnit: 'liter' }];
    resolveStaleReload(served);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeEnabled();
    });
    expect(screen.getByLabelText('الوحدة الأساسية')).toHaveValue('liter');
  });

  it('stays locked after a landed save when a newer catalog read fails', async () => {
    const oil = item({
      id: 'oil',
      name: 'زيت',
      kind: 'ingredient',
      baseUnit: 'kg',
      active: true,
    });
    served = [oil];
    let resolveSaveRead: (value: CatalogItem[]) => void = () => undefined;
    let loads = 0;
    vi.mocked(listItems).mockImplementation(() => {
      loads += 1;
      if (loads === 1) return Promise.resolve([oil]);
      if (loads === 2) {
        return new Promise((resolve) => {
          resolveSaveRead = resolve;
        });
      }
      return Promise.reject(new Error('حصل خطأ. حاول تاني.'));
    });
    // The panel's snapshot read started before the save and lands after it.
    let resolveSnapshot: (value: ReturnType<typeof listed>) => void = () =>
      undefined;
    vi.mocked(listConversions).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('article', { name: 'زيت' });
    fireEvent.click(within(card).getByRole('button', { name: 'التحويلات' }));
    fireEvent.click(within(card).getByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    await waitFor(() => {
      expect(loads).toBe(2);
    });

    resolveSnapshot(listed([], 'liter'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'حصل خطأ. حاول تاني.',
    );
    resolveSaveRead([{ ...oil, name: 'زيت جديد' }]);
    await waitFor(() => {
      expect(loads).toBe(3);
    });
    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'إعادة المحاولة' }),
    ).toBeEnabled();
  });

  it('asks for a reason when a loss starts at the open shift and sets an opening price', async () => {
    vi.mocked(currentShiftStart).mockResolvedValueOnce(
      '2020-01-01T00:00:00.000Z',
    );
    await renderCatalog();
    const shrimp = screen.getByRole('article', { name: 'جمبري' });
    fireEvent.click(within(shrimp).getByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });

    expect(
      await screen.findByText('ممكن يأثر على 2 طلب في 1 وردية (تقدير)'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(screen.getByText('اكتب سبب التغيير بأثر رجعي')).toBeInTheDocument();
    expect(setItemLoss).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('سبب التغيير'), {
      target: { value: 'تصحيح' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledWith(
        'shrimp',
        '0.1',
        expect.objectContaining({
          effectiveFrom: '2020-01-01T00:00:00.000Z',
          effectiveTo: null,
          token: emptyScheduleToken,
          reason: 'تصحيح',
        }),
      );
    });
    expect(setOpeningPrice).not.toHaveBeenCalled();
    expect(updateItem).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    expect(screen.getByText('اكتب سبب إن السعر صفر')).toBeInTheDocument();
    expect(setOpeningPrice).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('سبب إن السعر صفر'), {
      target: { value: 'لسه من غير سعر' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    await waitFor(() => {
      expect(setOpeningPrice).toHaveBeenCalledWith(
        'shrimp',
        '0',
        'لسه من غير سعر',
        null,
        expect.any(String),
        scheduleIdentity,
      );
    });
    expect(setItemLoss).toHaveBeenCalledTimes(1);
  });

  function lossRequest(index: number): {
    requestId: string;
    effectiveFrom: string | null;
  } {
    const timing = vi.mocked(setItemLoss).mock.calls[index]?.[2] as
      { requestId: string; effectiveFrom: string | null } | undefined;
    return timing ?? { requestId: '', effectiveFrom: null };
  }

  it('asks for a reason when the clock passes a future loss instant before submit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));
    vi.mocked(setItemLoss).mockRejectedValueOnce(new Error('تعذر الاتصال'));
    await renderCatalog();
    const shrimp = screen.getByRole('article', { name: 'جمبري' });
    fireEvent.click(within(shrimp).getByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalled();
    });
    fireEvent.change(screen.getByLabelText('وقت السريان'), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByLabelText('الوقت'), {
      target: { value: '2026-07-15T12:02' },
    });
    expect(screen.queryByLabelText('سبب التغيير')).not.toBeInTheDocument();

    vi.setSystemTime(new Date('2026-07-15T09:05:00.000Z'));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(screen.getByLabelText('سبب التغيير')).toBeInTheDocument();
    expect(screen.getByText('اكتب سبب التغيير بأثر رجعي')).toBeInTheDocument();
    expect(setItemLoss).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('سبب التغيير'), {
      target: { value: 'تصحيح' },
    });
    expect(
      await screen.findByText('ممكن يأثر على 2 طلب في 1 وردية (تقدير)'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledTimes(1);
    });
    expect(lossRequest(0).effectiveFrom).toBe('2026-07-15T09:02:00.000Z');

    expect(
      await screen.findByRole('button', { name: 'إعادة المحاولة' }),
    ).toBeInTheDocument();
    vi.setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledTimes(2);
    });
    expect(lossRequest(1).requestId).toBe(lossRequest(0).requestId);
    expect(lossRequest(1).effectiveFrom).toBe(lossRequest(0).effectiveFrom);
  });

  it('blocks a backdated loss while the impact estimate is pending or rejected', async () => {
    vi.mocked(currentShiftStart).mockResolvedValue('2020-01-01T00:00:00.000Z');
    let rejectImpact: (error: unknown) => void = () => undefined;
    vi.mocked(costingImpact).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectImpact = reject;
        }),
    );
    await renderCatalog();
    const shrimp = screen.getByRole('article', { name: 'جمبري' });
    fireEvent.click(within(shrimp).getByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    expect(await screen.findByText(impactLoadingMessage)).toBeInTheDocument();
    expect(screen.queryByText(/0 طلب/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('سبب التغيير'), {
      target: { value: 'تصحيح' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(screen.getByText(impactPendingMessage)).toBeInTheDocument();
    expect(setItemLoss).not.toHaveBeenCalled();

    rejectImpact(new Error('nope'));
    expect(await screen.findByText(impactErrorMessage)).toBeInTheDocument();
    expect(screen.queryByText(/0 طلب/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(setItemLoss).not.toHaveBeenCalled();

    vi.mocked(costingImpact).mockResolvedValue({
      orders: 4,
      shifts: 2,
      movements: 1,
    });
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByText('ممكن يأثر على 4 طلب في 2 وردية (تقدير)'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledTimes(1);
    });
  });

  it('reuses an opening-price request id only when the outcome is unknown', async () => {
    await renderCatalog();
    const shrimp = screen.getByRole('article', { name: 'جمبري' });
    fireEvent.click(within(shrimp).getByRole('button', { name: 'تعديل' }));
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة'), {
      target: { value: '15' },
    });
    vi.mocked(setOpeningPrice).mockRejectedValueOnce(new Error('تعذر الاتصال'));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(
      screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة'),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    expect(setOpeningPrice).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(setOpeningPrice).toHaveBeenCalledTimes(2);
    });
    const first = vi.mocked(setOpeningPrice).mock.calls[0]?.[4];
    const retry = vi.mocked(setOpeningPrice).mock.calls[1]?.[4];
    expect(retry).toBe(first);

    fireEvent.change(screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة'), {
      target: { value: '16' },
    });
    vi.mocked(setOpeningPrice).mockRejectedValueOnce(
      Object.assign(new Error('مرفوض'), { code: '22023' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('مرفوض');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    await waitFor(() => {
      expect(setOpeningPrice).toHaveBeenCalledTimes(4);
    });
    const refused = vi.mocked(setOpeningPrice).mock.calls[2]?.[4];
    const refusedRetry = vi.mocked(setOpeningPrice).mock.calls[3]?.[4];
    expect(refusedRetry).not.toBe(refused);
    expect(refused).not.toBe(first);
  });

  function lossTiming(index: number): { requestId: string; token: string } {
    const timing = vi.mocked(setItemLoss).mock.calls[index]?.[2] as
      { requestId: string; token: string } | undefined;
    return timing ?? { requestId: '', token: '' };
  }

  it('sends the refreshed loss token on the next save', async () => {
    let lossToken = 'token-1';
    let shrimpLoss = 0.125;
    vi.mocked(listCostingSchedule).mockImplementation(() =>
      Promise.resolve({
        lossToken,
        identity: scheduleIdentity,
        lossVersions: [],
        conversions: [],
      }),
    );
    vi.mocked(listItems).mockImplementation(() =>
      Promise.resolve(
        catalog.map((row) =>
          row.id === 'shrimp' ? { ...row, lossPct: shrimpLoss } : row,
        ),
      ),
    );
    vi.mocked(setItemLoss).mockImplementation((_id, fraction) => {
      lossToken = 'token-2';
      shrimpLoss = Number(fraction);
      return Promise.resolve();
    });
    await renderCatalog();
    fireEvent.click(
      within(screen.getByRole('article', { name: 'جمبري' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledTimes(1);
    });
    expect(lossTiming(0).token).toBe('token-1');
    expect(setItemLoss).toHaveBeenCalledWith(
      'shrimp',
      '0.2',
      expect.objectContaining({ token: 'token-1' }),
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ الفاقد' })).toBeEnabled();
    });
    expect(screen.getByLabelText('نسبة الفاقد')).toHaveValue('20');
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledTimes(2);
    });
    expect(lossTiming(1).token).toBe('token-2');
    expect(lossTiming(1).requestId).not.toBe(lossTiming(0).requestId);
    expect(setItemLoss).toHaveBeenLastCalledWith(
      'shrimp',
      '0.3',
      expect.objectContaining({ token: 'token-2' }),
    );
  });

  it('refreshes the loss schedule after a conflict and keeps an unresolved price', async () => {
    let lossToken = 'token-1';
    vi.mocked(listCostingSchedule).mockImplementation(() =>
      Promise.resolve({
        lossToken,
        identity: scheduleIdentity,
        lossVersions: [],
        conversions: [],
      }),
    );
    vi.mocked(setItemLoss).mockImplementationOnce(() => {
      lossToken = 'token-2';
      return Promise.reject(new CostingChangedError());
    });
    await renderCatalog();
    fireEvent.click(
      within(screen.getByRole('article', { name: 'جمبري' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة'), {
      target: { value: '15' },
    });
    vi.mocked(setOpeningPrice).mockRejectedValueOnce(new Error('تعذر الاتصال'));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذر الاتصال');
    const priceId = vi.mocked(setOpeningPrice).mock.calls[0]?.[4];

    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'البيانات اتغيرت — حدّث الصفحة وجرّب تاني',
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ الفاقد' })).toBeEnabled();
    });
    expect(screen.getByLabelText('نسبة الفاقد')).toHaveValue('20');
    expect(screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة')).toHaveValue(
      '15',
    );

    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledTimes(2);
    });
    expect(lossTiming(0).token).toBe('token-1');
    expect(lossTiming(1).token).toBe('token-2');
    expect(lossTiming(1).requestId).not.toBe(lossTiming(0).requestId);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'إعادة المحاولة' }),
      ).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(setOpeningPrice).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(setOpeningPrice).mock.calls[1]?.[4]).toBe(priceId);
    expect(screen.getByLabelText('نسبة الفاقد')).toBeEnabled();
  });

  it('retires an unknown loss when configuration changed proves it was not stored', async () => {
    let lossToken = 'token-1';
    vi.mocked(listCostingSchedule).mockImplementation(() =>
      Promise.resolve({
        lossToken,
        identity: scheduleIdentity,
        lossVersions: [],
        conversions: [],
      }),
    );
    vi.mocked(setItemLoss)
      .mockRejectedValueOnce(new Error('تعذر الاتصال'))
      .mockImplementationOnce(() => {
        lossToken = 'token-2';
        return Promise.reject(new CostingChangedError());
      });
    await renderCatalog();
    fireEvent.click(
      within(screen.getByRole('article', { name: 'جمبري' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('نسبة الفاقد')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '30' },
    });
    expect(screen.getByLabelText('نسبة الفاقد')).toHaveValue('20');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(setItemLoss).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'البيانات اتغيرت — حدّث الصفحة وجرّب تاني',
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ الفاقد' })).toBeEnabled();
    });
    expect(screen.getByLabelText('نسبة الفاقد')).toBeEnabled();
    expect(lossTiming(1).requestId).toBe(lossTiming(0).requestId);
    expect(lossTiming(1).token).toBe('token-1');

    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledTimes(3);
    });
    expect(lossTiming(2).requestId).not.toBe(lossTiming(0).requestId);
    expect(lossTiming(2).token).toBe('token-2');
    expect(setItemLoss).toHaveBeenLastCalledWith(
      'shrimp',
      '0.3',
      expect.objectContaining({ token: 'token-2' }),
    );
  });

  const identityHoldHint =
    'في حفظ للتكلفة لسه معلّق، فالنوع والوحدة الأساسية والأب متقفلين';

  async function editSize() {
    fireEvent.click(
      within(screen.getByRole('article', { name: 'بوري كبير' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('locks identity fields while a loss save for the item is unresolved', async () => {
    vi.mocked(setItemLoss)
      .mockRejectedValueOnce(new Error('تعذر الاتصال'))
      .mockRejectedValueOnce(new CostingChangedError());
    await renderCatalog();
    await editSize();

    expect(screen.getByLabelText('النوع')).toBeEnabled();
    expect(screen.getByLabelText('الوحدة الأساسية')).toBeEnabled();
    expect(screen.getByLabelText('السمك المخلوط')).toBeEnabled();
    expect(screen.queryByText(identityHoldHint)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByLabelText('النوع')).toBeDisabled();
    });
    expect(screen.getByLabelText('الوحدة الأساسية')).toBeDisabled();
    expect(screen.getByLabelText('السمك المخلوط')).toBeDisabled();
    expect(screen.getByText(identityHoldHint)).toBeInTheDocument();
    expect(screen.getByLabelText('الاسم')).toBeEnabled();
    expect(screen.getByLabelText('الجرد')).toBeEnabled();

    fireEvent.change(screen.getByLabelText('النوع'), {
      target: { value: 'ingredient' },
    });
    fireEvent.change(screen.getByLabelText('الوحدة الأساسية'), {
      target: { value: 'liter' },
    });
    fireEvent.change(screen.getByLabelText('السمك المخلوط'), {
      target: { value: '' },
    });
    expect(screen.getByLabelText('النوع')).toHaveValue('fish_size');
    expect(screen.getByLabelText('الوحدة الأساسية')).toHaveValue('kg');
    expect(screen.getByLabelText('السمك المخلوط')).toHaveValue('mixed');

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'البيانات اتغيرت — حدّث الصفحة وجرّب تاني',
    );
    await waitFor(() => {
      expect(screen.getByLabelText('النوع')).toBeEnabled();
    });
    expect(screen.getByLabelText('الوحدة الأساسية')).toBeEnabled();
    expect(screen.getByLabelText('السمك المخلوط')).toBeEnabled();
    expect(screen.queryByText(identityHoldHint)).not.toBeInTheDocument();
  });

  it('locks identity fields while an opening-price save for the item is unresolved', async () => {
    vi.mocked(setOpeningPrice)
      .mockRejectedValueOnce(new Error('تعذر الاتصال'))
      .mockRejectedValueOnce(new CostingChangedError());
    await renderCatalog();
    await editSize();

    fireEvent.change(screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByLabelText('النوع')).toBeDisabled();
    });
    expect(screen.getByLabelText('الوحدة الأساسية')).toBeDisabled();
    expect(screen.getByLabelText('السمك المخلوط')).toBeDisabled();
    expect(screen.getByText(identityHoldHint)).toBeInTheDocument();
    expect(screen.getByLabelText('الاسم')).toBeEnabled();
    expect(screen.getByLabelText('الجرد')).toBeEnabled();

    fireEvent.change(screen.getByLabelText('النوع'), {
      target: { value: 'ingredient' },
    });
    fireEvent.change(screen.getByLabelText('الوحدة الأساسية'), {
      target: { value: 'liter' },
    });
    fireEvent.change(screen.getByLabelText('السمك المخلوط'), {
      target: { value: '' },
    });
    expect(screen.getByLabelText('النوع')).toHaveValue('fish_size');
    expect(screen.getByLabelText('الوحدة الأساسية')).toHaveValue('kg');
    expect(screen.getByLabelText('السمك المخلوط')).toHaveValue('mixed');
    expect(setOpeningPrice).toHaveBeenCalledWith(
      'size',
      '100',
      null,
      null,
      expect.any(String),
      sizeIdentity,
    );

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'البيانات اتغيرت — حدّث الصفحة وجرّب تاني',
    );
    await waitFor(() => {
      expect(screen.getByLabelText('النوع')).toBeEnabled();
    });
    expect(screen.getByLabelText('الوحدة الأساسية')).toBeEnabled();
    expect(screen.getByLabelText('السمك المخلوط')).toBeEnabled();
    expect(screen.queryByText(identityHoldHint)).not.toBeInTheDocument();
    const first = vi.mocked(setOpeningPrice).mock.calls[0];
    const retry = vi.mocked(setOpeningPrice).mock.calls[1];
    expect(retry?.[4]).toBe(first?.[4]);
    expect(retry?.[5]).toBe(sizeIdentity);
  });

  it('saves the next opening price with the identity from after a conflict', async () => {
    let identity = scheduleIdentity;
    vi.mocked(listCostingSchedule).mockImplementation(() =>
      Promise.resolve({
        lossToken: emptyScheduleToken,
        identity,
        lossVersions: [],
        conversions: [],
      }),
    );
    vi.mocked(setOpeningPrice).mockImplementation(
      (_itemId, _price, _reason, _expectedId, _requestId, sentIdentity) => {
        if (sentIdentity === scheduleIdentity) {
          identity = 'liter|seafood||';
          return Promise.reject(new CostingChangedError());
        }
        return Promise.resolve();
      },
    );
    await renderCatalog();
    vi.mocked(listItems).mockImplementation(() =>
      Promise.resolve(
        catalog.map((row) =>
          row.id === 'shrimp' && identity.startsWith('liter')
            ? { ...row, baseUnit: 'liter' }
            : row,
        ),
      ),
    );
    fireEvent.click(
      within(screen.getByRole('article', { name: 'جمبري' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const scheduleReads = vi.mocked(listCostingSchedule).mock.calls.length;
    fireEvent.change(screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'البيانات اتغيرت — حدّث الصفحة وجرّب تاني',
    );
    await waitFor(() => {
      expect(vi.mocked(listCostingSchedule).mock.calls.length).toBeGreaterThan(
        scheduleReads,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByLabelText('الوحدة الأساسية')).toHaveValue('liter');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ السعر' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    await waitFor(() => {
      expect(setOpeningPrice).toHaveBeenCalledTimes(2);
    });
    const first = vi.mocked(setOpeningPrice).mock.calls[0];
    const next = vi.mocked(setOpeningPrice).mock.calls[1];
    expect(first?.[5]).toBe(scheduleIdentity);
    expect(next?.[1]).toBe('100');
    expect(next?.[4]).not.toBe(first?.[4]);
    expect(next?.[5]).toBe('liter|seafood||');
    expect(screen.queryByText(unknownSaveMessage)).not.toBeInTheDocument();
  });

  it('loads the new identity after a base-unit save before the next price', async () => {
    let identity = scheduleIdentity;
    vi.mocked(listCostingSchedule).mockImplementation(() =>
      Promise.resolve({
        lossToken: emptyScheduleToken,
        identity,
        lossVersions: [],
        conversions: [],
      }),
    );
    vi.mocked(updateItem).mockImplementation(() => {
      identity = 'liter|seafood||';
      vi.mocked(listItems).mockResolvedValue(
        catalog.map((row) =>
          row.id === 'shrimp' ? { ...row, baseUnit: 'liter' } : row,
        ),
      );
      return Promise.resolve();
    });
    await renderCatalog();
    fireEvent.click(
      within(screen.getByRole('article', { name: 'جمبري' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const scheduleReads = vi.mocked(listCostingSchedule).mock.calls.length;
    fireEvent.change(screen.getByLabelText('الوحدة الأساسية'), {
      target: { value: 'liter' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    await waitFor(() => {
      expect(vi.mocked(listCostingSchedule).mock.calls.length).toBeGreaterThan(
        scheduleReads,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    await waitFor(() => {
      expect(setOpeningPrice).toHaveBeenCalledWith(
        'shrimp',
        '100',
        null,
        null,
        expect.any(String),
        'liter|seafood||',
      );
    });
  });

  async function editShrimp() {
    fireEvent.click(
      within(screen.getByRole('article', { name: 'جمبري' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('blocks an opening price while the base unit shown is not the saved one', async () => {
    await renderCatalog();
    await editShrimp();
    fireEvent.change(screen.getByLabelText('الوحدة الأساسية'), {
      target: { value: 'liter' },
    });
    fireEvent.change(screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة'), {
      target: { value: '100' },
    });

    expect(screen.getByText(saveDetailsFirstMessage)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ السعر' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    expect(setOpeningPrice).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('الوحدة الأساسية'), {
      target: { value: 'kg' },
    });
    expect(screen.queryByText(saveDetailsFirstMessage)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    await waitFor(() => {
      expect(setOpeningPrice).toHaveBeenCalledWith(
        'shrimp',
        '100',
        null,
        null,
        expect.any(String),
        scheduleIdentity,
      );
    });
  });

  it('blocks an opening price while the kind shown is not the saved one', async () => {
    await renderCatalog();
    await editShrimp();
    fireEvent.change(screen.getByLabelText('النوع'), {
      target: { value: 'ingredient' },
    });
    fireEvent.change(screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة'), {
      target: { value: '100' },
    });

    expect(screen.getByText(saveDetailsFirstMessage)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    expect(setOpeningPrice).not.toHaveBeenCalled();
  });

  it('blocks an opening price while the parent shown is not the saved one', async () => {
    await renderCatalog();
    fireEvent.click(
      within(screen.getByRole('article', { name: 'بوري كبير' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('السمك المخلوط'), {
      target: { value: 'mixed-off' },
    });
    fireEvent.change(screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة'), {
      target: { value: '100' },
    });

    expect(screen.getByText(saveDetailsFirstMessage)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    expect(setOpeningPrice).not.toHaveBeenCalled();
  });

  it('blocks a loss save while the base unit shown is not the saved one', async () => {
    await renderCatalog();
    await editShrimp();
    fireEvent.change(screen.getByLabelText('الوحدة الأساسية'), {
      target: { value: 'liter' },
    });
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '20' },
    });

    expect(screen.getByText(saveDetailsFirstMessage)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ الفاقد' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(setItemLoss).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('الوحدة الأساسية'), {
      target: { value: 'kg' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledTimes(1);
    });
  });

  it('blocks conversion saves while the base unit shown is not the saved one', async () => {
    vi.mocked(updateConversion).mockClear();
    vi.mocked(deleteConversion).mockClear();
    vi.mocked(listConversions).mockResolvedValue(
      listed(
        [
          {
            itemId: 'shrimp',
            unit: 'كيس',
            factorToBase: 2,
            storedFactor: '2',
          },
        ],
        'kg',
      ),
    );
    await renderCatalog();
    await editShrimp();
    const shrimp = screen.getByRole('article', { name: 'جمبري' });
    fireEvent.click(within(shrimp).getByRole('button', { name: 'التحويلات' }));
    expect(
      await within(shrimp).findByText('1 كيس = 2 كيلو'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(shrimp).getByRole('button', { name: 'ضيف التحويل' }),
      ).toBeEnabled();
    });

    fireEvent.change(screen.getByLabelText('الوحدة الأساسية'), {
      target: { value: 'liter' },
    });
    fireEvent.change(within(shrimp).getByLabelText('معامل كيس'), {
      target: { value: '3' },
    });

    expect(
      await within(shrimp).findByText(saveDetailsFirstMessage),
    ).toBeInTheDocument();
    for (const name of ['ضيف التحويل', 'حفظ المعامل', 'احذف التحويل']) {
      const button = within(shrimp).getByRole('button', { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(addConversion).not.toHaveBeenCalled();
    expect(updateConversion).not.toHaveBeenCalled();
    expect(deleteConversion).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('الوحدة الأساسية'), {
      target: { value: 'kg' },
    });
    await waitFor(() => {
      expect(
        within(shrimp).getByRole('button', { name: 'حفظ المعامل' }),
      ).toBeEnabled();
    });
  });

  it('locks identity fields while a conversion save for the item is unresolved', async () => {
    vi.mocked(addConversion).mockRejectedValueOnce(new Error('تعذر الاتصال'));
    await renderCatalog();
    await editSize();

    const size = screen.getByRole('article', { name: 'بوري كبير' });
    fireEvent.click(within(size).getByRole('button', { name: 'التحويلات' }));
    expect(
      await within(size).findByRole('option', { name: 'قطعة' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(size).getByRole('button', { name: 'ضيف التحويل' }),
      ).toBeEnabled();
    });
    fireEvent.change(within(size).getByLabelText('الوحدة'), {
      target: { value: 'piece' },
    });
    fireEvent.change(within(size).getByLabelText('المعامل'), {
      target: { value: '4' },
    });
    fireEvent.click(within(size).getByRole('button', { name: 'ضيف التحويل' }));

    expect(
      await within(size).findByText(unknownSaveMessage),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('النوع')).toBeDisabled();
    });
    expect(screen.getByLabelText('الوحدة الأساسية')).toBeDisabled();
    expect(screen.getByLabelText('السمك المخلوط')).toBeDisabled();
    expect(screen.getByText(identityHoldHint)).toBeInTheDocument();
    expect(screen.getByLabelText('الاسم')).toBeEnabled();

    fireEvent.change(screen.getByLabelText('النوع'), {
      target: { value: 'seafood' },
    });
    fireEvent.change(screen.getByLabelText('الوحدة الأساسية'), {
      target: { value: 'piece' },
    });
    fireEvent.change(screen.getByLabelText('السمك المخلوط'), {
      target: { value: 'mixed-off' },
    });
    expect(screen.getByLabelText('النوع')).toHaveValue('fish_size');
    expect(screen.getByLabelText('الوحدة الأساسية')).toHaveValue('kg');
    expect(screen.getByLabelText('السمك المخلوط')).toHaveValue('mixed');
  });

  it('applies a later return to an earlier loss with a fresh request id', async () => {
    await renderCatalog();
    fireEvent.click(
      within(screen.getByRole('article', { name: 'جمبري' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    vi.mocked(setItemLoss).mockRejectedValueOnce(new Error('تعذر الاتصال'));
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('نسبة الفاقد')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '30' },
    });
    expect(screen.getByLabelText('نسبة الفاقد')).toHaveValue('20');
    expect(setItemLoss).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledTimes(2);
    });
    expect(lossTiming(1).requestId).toBe(lossTiming(0).requestId);
    expect(setItemLoss).toHaveBeenLastCalledWith(
      'shrimp',
      '0.2',
      expect.objectContaining({ requestId: lossTiming(0).requestId }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('نسبة الفاقد')).toBeEnabled();
    });

    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledTimes(3);
    });
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledTimes(4);
    });
    expect(lossTiming(2).requestId).not.toBe(lossTiming(0).requestId);
    expect(lossTiming(3).requestId).not.toBe(lossTiming(2).requestId);
    expect(lossTiming(3).requestId).not.toBe(lossTiming(0).requestId);
    expect(vi.mocked(setItemLoss).mock.calls[2]?.[1]).toBe('0.3');
    expect(vi.mocked(setItemLoss).mock.calls[3]?.[1]).toBe('0.2');
  });

  it('requires a reason when the shift starts earlier in the current minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T09:00:45.000Z'));
    vi.mocked(currentShiftStart).mockResolvedValue('2026-07-15T09:00:30.000Z');
    await renderCatalog();
    fireEvent.click(
      within(screen.getByRole('article', { name: 'جمبري' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    expect(await screen.findByLabelText('سبب التغيير')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(screen.getByText('اكتب سبب التغيير بأثر رجعي')).toBeInTheDocument();
    expect(setItemLoss).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('سبب التغيير'), {
      target: { value: 'تصحيح' },
    });
    expect(
      await screen.findByText('ممكن يأثر على 2 طلب في 1 وردية (تقدير)'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledTimes(1);
    });
    expect(lossRequest(0).effectiveFrom).toBe('2026-07-15T09:00:30.000Z');
    expect(setItemLoss).toHaveBeenCalledWith(
      'shrimp',
      '0.1',
      expect.objectContaining({
        effectiveFrom: '2026-07-15T09:00:30.000Z',
        reason: 'تصحيح',
      }),
    );
  });

  const priceLabel = 'السعر الافتتاحي المعتمد للوحدة';
  const datedLossLabel = 'اعتمد النسبة الحالية من وقت سابق';

  it('blocks fresh loss and price saves while the schedule identity differs from the one shown', async () => {
    await renderCatalog();
    vi.mocked(listCostingSchedule).mockImplementation(() =>
      Promise.resolve({
        lossToken: emptyScheduleToken,
        identity: 'liter|seafood||',
        lossVersions: [],
        conversions: [],
      }),
    );
    fireEvent.click(
      within(screen.getByRole('article', { name: 'جمبري' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    expect(
      await screen.findByText(identityOutOfDateMessage),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(listItems).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeEnabled();
    });
    expect(screen.getByLabelText('الوحدة الأساسية')).toHaveValue('kg');

    fireEvent.change(screen.getByLabelText(priceLabel), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    expect(screen.getByRole('button', { name: 'حفظ السعر' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'حفظ الفاقد' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(setOpeningPrice).not.toHaveBeenCalled();
    expect(setItemLoss).not.toHaveBeenCalled();
  });

  it('reloads the item shown and saves the price with the newer identity', async () => {
    await renderCatalog();
    const moved: CatalogItem[] = catalog.map((row) =>
      row.id === 'shrimp' ? { ...row, baseUnit: 'liter' } : row,
    );
    let resolveReload: (rows: CatalogItem[]) => void = () => undefined;
    vi.mocked(listItems).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReload = resolve;
        }),
    );
    served = moved;
    await editShrimp();
    expect(
      await screen.findByText(identityOutOfDateMessage),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('الوحدة الأساسية')).toHaveValue('kg');
    expect(screen.getByRole('button', { name: 'حفظ السعر' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'حفظ الفاقد' })).toBeDisabled();
    expect(setOpeningPrice).not.toHaveBeenCalled();

    await act(async () => {
      resolveReload(moved);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('الوحدة الأساسية')).toHaveValue('liter');
    });
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        screen.queryByText(identityOutOfDateMessage),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ السعر' })).toBeEnabled();
    });

    fireEvent.change(screen.getByLabelText(priceLabel), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    await waitFor(() => {
      expect(setOpeningPrice).toHaveBeenCalledTimes(1);
    });
    expect(setOpeningPrice).toHaveBeenCalledWith(
      'shrimp',
      '100',
      null,
      null,
      expect.any(String),
      'liter|seafood||',
    );
  });

  it('retries a held price with its own identity while a newer schedule is shown', async () => {
    let identity = scheduleIdentity;
    vi.mocked(listCostingSchedule).mockImplementation(() =>
      Promise.resolve({
        lossToken: emptyScheduleToken,
        identity,
        lossVersions: [],
        conversions: [],
      }),
    );
    await renderCatalog();
    await editShrimp();
    fireEvent.change(screen.getByLabelText(priceLabel), {
      target: { value: '100' },
    });
    vi.mocked(setOpeningPrice).mockRejectedValueOnce(new Error('تعذر الاتصال'));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ السعر' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();

    identity = 'liter|seafood||';
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(
      await screen.findByText(identityOutOfDateMessage),
    ).toBeInTheDocument();
    expect(setItemLoss).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(setOpeningPrice).toHaveBeenCalledTimes(2);
    });
    const first = vi.mocked(setOpeningPrice).mock.calls[0];
    const retry = vi.mocked(setOpeningPrice).mock.calls[1];
    expect(retry?.[4]).toBe(first?.[4]);
    expect(first?.[5]).toBe(scheduleIdentity);
    expect(retry?.[5]).toBe(scheduleIdentity);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeEnabled();
    });
    expect(screen.getByRole('button', { name: 'حفظ السعر' })).toBeDisabled();
  });

  it('approves the unchanged loss for an earlier interval with a reason and a reviewed impact', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));
    vi.mocked(listCostingSchedule).mockImplementation(() =>
      Promise.resolve({
        lossToken: 'loss-token',
        identity: scheduleIdentity,
        lossVersions: [
          {
            id: 'v1',
            effectiveFrom: '2026-07-01T00:00:00.000Z',
            effectiveTo: null,
            valueText: '0.125',
          },
        ],
        conversions: [],
      }),
    );
    let resolveImpact: (value: {
      orders: number;
      shifts: number;
      movements: number;
    }) => void = () => undefined;
    vi.mocked(costingImpact).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImpact = resolve;
        }),
    );
    await renderCatalog();
    await editShrimp();
    expect(screen.getByLabelText('نسبة الفاقد')).toHaveValue('12.5');
    expect(screen.queryByLabelText('وقت السريان')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(datedLossLabel));
    fireEvent.change(screen.getByLabelText('وقت السريان'), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByLabelText('الوقت'), {
      target: { value: '2026-06-20T10:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(screen.getByText('اكتب سبب التغيير بأثر رجعي')).toBeInTheDocument();
    expect(setItemLoss).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('سبب التغيير'), {
      target: { value: 'تصحيح' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(screen.getByText(impactPendingMessage)).toBeInTheDocument();
    expect(setItemLoss).not.toHaveBeenCalled();

    await act(async () => {
      resolveImpact({ orders: 2, shifts: 1, movements: 4 });
      await Promise.resolve();
    });
    expect(
      await screen.findByText('ممكن يأثر على 2 طلب في 1 وردية (تقدير)'),
    ).toBeInTheDocument();
    expect(costingImpact).toHaveBeenCalledWith(
      '2026-06-20T07:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
      'shrimp',
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => {
      expect(setItemLoss).toHaveBeenCalledTimes(1);
    });
    expect(setItemLoss).toHaveBeenCalledWith(
      'shrimp',
      '0.125',
      expect.objectContaining({
        effectiveFrom: '2026-06-20T07:00:00.000Z',
        effectiveTo: '2026-07-01T00:00:00.000Z',
        token: 'loss-token',
        reason: 'تصحيح',
      }),
    );
    expect(updateItem).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByLabelText('سبب التغيير')).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText(datedLossLabel)).not.toBeChecked();
  });

  it('does not publish an unchanged loss without an earlier effective time', async () => {
    await renderCatalog();
    await editShrimp();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(setItemLoss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText(datedLossLabel));
    expect(screen.getByLabelText('وقت السريان')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    expect(
      screen.getByText('اختار وقت سريان قبل الوقت الحالي'),
    ).toBeInTheDocument();
    expect(setItemLoss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText(datedLossLabel));
    expect(screen.queryByLabelText('وقت السريان')).not.toBeInTheDocument();
  });
});
