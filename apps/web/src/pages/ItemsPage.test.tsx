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
  updateItem,
} from '@/items/api';
import type { CatalogItem, UnitConversion } from '@/items/types';
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
  return {
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
    vi.mocked(listConversions).mockResolvedValue([]);
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
    expect(screen.getByLabelText('الجرد')).toHaveValue('weekly');
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
        countFrequency: 'weekly',
        lossPct: 0.125,
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
          lossPct: 0,
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
      );
    });
  });

  it('adds a conversion and rejects the item base unit', async () => {
    await renderCatalog();
    const rows: UnitConversion[] = [];
    vi.mocked(listConversions).mockImplementation(() =>
      Promise.resolve([...rows]),
    );
    vi.mocked(addConversion).mockImplementation((itemId, unit, factor) => {
      rows.push({ itemId, unit, factorToBase: factor });
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
    expect(addConversion).toHaveBeenCalledWith('box', 'كرتونة', 12);
  });
});
