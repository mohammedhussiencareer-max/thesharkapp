import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addConversion, listConversions, updateConversion } from '@/items/api';
import { ConversionsPanel } from '@/items/ConversionsPanel';
import { StaleWriteError } from '@/items/errors';
import type { CatalogItem } from '@/items/types';

vi.mock('@/items/api', () => ({
  listConversions: vi.fn(),
  addConversion: vi.fn(),
  updateConversion: vi.fn(),
  deleteConversion: vi.fn(),
}));

const item: CatalogItem = {
  id: 'oil',
  name: 'زيت',
  kind: 'ingredient',
  baseUnit: 'kg',
  countFrequency: 'weekly',
  lossPct: 0,
  storedLossPct: 0,
  parentItemId: null,
  active: true,
  onHandQty: 0,
  avgCost: 0,
  onHandValue: 0,
};

describe('ConversionsPanel', () => {
  beforeEach(() => {
    vi.mocked(listConversions).mockReset();
    vi.mocked(addConversion).mockReset();
  });

  it('shows the exact stored factor instead of a rounded quantity', async () => {
    vi.mocked(listConversions).mockResolvedValue([
      {
        itemId: 'oil',
        unit: 'جرام',
        factorToBase: 0.0075,
        storedFactor: '0.007500000',
      },
      {
        itemId: 'oil',
        unit: 'مل',
        factorToBase: 0.0001,
        storedFactor: '0.0001',
      },
      {
        itemId: 'oil',
        unit: 'كيس',
        factorToBase: 25,
        storedFactor: '25.000000000',
      },
      {
        itemId: 'oil',
        unit: 'طن',
        factorToBase: 12345678.12345679,
        storedFactor: '12345678.123456789',
      },
    ]);

    render(<ConversionsPanel item={item} />);

    expect(await screen.findByText('1 جرام = 0.0075 كيلو')).toBeInTheDocument();
    expect(screen.getByText('1 مل = 0.0001 كيلو')).toBeInTheDocument();
    expect(screen.getByText('1 كيس = 25 كيلو')).toBeInTheDocument();
    expect(
      screen.getByText('1 طن = 12345678.123456789 كيلو'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/0\.008/)).not.toBeInTheDocument();
  });

  it('saves an unchanged high-precision factor as the same text', async () => {
    vi.mocked(listConversions).mockResolvedValue([
      {
        itemId: 'oil',
        unit: 'طن',
        factorToBase: 0,
        storedFactor: '12345678.123456789',
      },
    ]);
    vi.mocked(updateConversion).mockResolvedValue(undefined);

    render(<ConversionsPanel item={item} />);

    expect(
      await screen.findByText('1 طن = 12345678.123456789 كيلو'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));

    await waitFor(() => {
      expect(updateConversion).toHaveBeenCalledWith(
        'oil',
        'طن',
        '12345678.123456789',
        '12345678.123456789',
      );
    });
  });

  it('re-initializes the factor input when only the exact stored text changes', async () => {
    const before = {
      itemId: 'oil',
      unit: 'طن',
      factorToBase: 12345678.123456789,
      storedFactor: '12345678.123456789',
    };
    // Same JS number, different exact decimal: a concurrent edit landed.
    const after = { ...before, storedFactor: '12345678.12345679' };
    vi.mocked(listConversions)
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([after]);
    vi.mocked(updateConversion).mockRejectedValueOnce(new StaleWriteError());

    render(<ConversionsPanel item={item} />);
    expect(
      await screen.findByText('1 طن = 12345678.123456789 كيلو'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));

    expect(
      await screen.findByText('1 طن = 12345678.12345679 كيلو'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('معامل طن')).toHaveValue('12345678.12345679');
  });

  it('shows the stale message and reloads when adding against a changed base unit', async () => {
    vi.mocked(listConversions)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { itemId: 'oil', unit: 'كيس', factorToBase: 2, storedFactor: '2' },
      ]);
    vi.mocked(addConversion).mockRejectedValueOnce(new StaleWriteError());

    render(<ConversionsPanel item={item} />);
    expect(
      await screen.findByText('مفيش تحويلات للصنف ده'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('اسم الوحدة'), {
      target: { value: 'كيس' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'البيانات اتغيّرت من مكان تاني — اتعملها تحديث، راجعها واحفظ تاني',
    );
    expect(addConversion).toHaveBeenCalledWith('oil', 'كيس', '25', 'kg');
    expect(await screen.findByText('1 كيس = 2 كيلو')).toBeInTheDocument();
    expect(screen.queryByText('1 كيس = 25 كيلو')).not.toBeInTheDocument();
  });

  it('shows a reload error and retry when refreshing after a save fails', async () => {
    vi.mocked(listConversions)
      .mockResolvedValueOnce([
        { itemId: 'oil', unit: 'كرتونة', factorToBase: 12, storedFactor: 12 },
      ])
      .mockRejectedValueOnce(new Error('حصل خطأ. حاول تاني.'));
    vi.mocked(addConversion).mockResolvedValue(undefined);

    render(<ConversionsPanel item={item} />);

    expect(await screen.findByText('1 كرتونة = 12 كيلو')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('اسم الوحدة'), {
      target: { value: 'كيس' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'حصل خطأ. حاول تاني.',
    );
    expect(
      screen.getByRole('button', { name: 'إعادة المحاولة' }),
    ).toBeInTheDocument();
    expect(screen.getByText('1 كرتونة = 12 كيلو')).toBeInTheDocument();
  });
});
