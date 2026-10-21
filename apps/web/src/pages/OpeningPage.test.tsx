import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listStockChoices, recordOpeningStock } from '@/purchases/api';
import { OpeningPage } from '@/pages/OpeningPage';
import type { StockChoice } from '@/purchases/types';

vi.mock('@/purchases/api', () => ({
  listStockChoices: vi.fn(),
  recordOpeningStock: vi.fn(),
}));

function choice(
  overrides: Partial<StockChoice> & Pick<StockChoice, 'id' | 'name' | 'kind'>,
): StockChoice {
  return {
    baseUnit: 'kg',
    parentItemId: null,
    active: true,
    hasMovements: false,
    conversions: [],
    ...overrides,
  };
}

const oil = choice({ id: 'oil', name: 'زيت', kind: 'ingredient' });

describe('OpeningPage', () => {
  beforeEach(() => {
    vi.mocked(listStockChoices).mockReset();
    vi.mocked(recordOpeningStock).mockReset();
    vi.mocked(recordOpeningStock).mockResolvedValue(undefined);
  });

  it('says every item already has an opening balance', async () => {
    vi.mocked(listStockChoices).mockResolvedValue([
      { ...oil, hasMovements: true },
    ]);
    render(
      <MemoryRouter>
        <OpeningPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText('كل الأصناف ليها رصيد افتتاحي'),
    ).toBeInTheDocument();
  });

  it('keeps the page locked until the reload after a save finishes', async () => {
    vi.mocked(listStockChoices).mockResolvedValue([oil]);
    let releaseSave: () => void = () => undefined;
    vi.mocked(recordOpeningStock).mockReturnValue(
      new Promise((resolve) => {
        releaseSave = () => resolve();
      }),
    );
    render(
      <MemoryRouter>
        <OpeningPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('كمية زيت')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('كمية زيت'), {
      target: { value: '4' },
    });
    fireEvent.change(screen.getByLabelText('تكلفة زيت'), {
      target: { value: '12.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    await waitFor(() => {
      expect(recordOpeningStock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    const payload = vi.mocked(recordOpeningStock).mock.calls[0]?.[0];
    expect(payload?.lines).toEqual([
      { itemId: 'oil', quantity: '4', unit: 'kg', unitCost: '12.5' },
    ]);
    expect(typeof payload?.lines[0]?.quantity).toBe('string');

    let releaseReload: (rows: StockChoice[]) => void = () => undefined;
    vi.mocked(listStockChoices).mockReturnValue(
      new Promise((resolve) => {
        releaseReload = resolve;
      }),
    );
    releaseSave();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'اتسجل الرصيد الافتتاحي',
    );
    await waitFor(() => {
      expect(listStockChoices).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByLabelText('كمية زيت')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();

    releaseReload([{ ...oil, hasMovements: true }]);
    expect(
      await screen.findByText('كل الأصناف ليها رصيد افتتاحي'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('كمية زيت')).not.toBeInTheDocument();
  });
});
