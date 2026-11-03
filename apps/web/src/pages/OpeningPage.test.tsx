import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversionChangedError,
  conversionChangedMessage,
} from '@/purchases/errors';
import {
  listStockChoices,
  listUnitsAt,
  recordOpeningStock,
} from '@/purchases/api';
import { OpeningPage } from '@/pages/OpeningPage';
import type { StockChoice, UnitOption } from '@/purchases/types';

vi.mock('@/purchases/api', () => ({
  listStockChoices: vi.fn(),
  recordOpeningStock: vi.fn(),
  listUnitsAt: vi.fn(() => Promise.resolve({})),
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
    vi.mocked(listUnitsAt).mockReset();
    vi.mocked(listUnitsAt).mockResolvedValue({});
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
      {
        itemId: 'oil',
        quantity: '4',
        unit: 'kg',
        unitCost: '12.5',
        expectedBaseUnit: 'kg',
        expectedFactor: '1',
      },
    ]);
    expect(payload?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
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

  it('reloads choices when the conversion changed and keeps the entered row', async () => {
    const literOil = choice({
      id: 'oil',
      name: 'زيت',
      kind: 'ingredient',
      conversions: [{ unit: 'لتر', factorToBase: '0.92' }],
    });
    vi.mocked(listStockChoices).mockResolvedValue([literOil]);
    const lookedUpAt: string[] = [];
    let releaseUnits: (rows: Record<string, UnitOption[]>) => void = () =>
      undefined;
    vi.mocked(listUnitsAt).mockImplementation((_ids, at) => {
      lookedUpAt.push(at);
      if (lookedUpAt.length === 1) {
        return Promise.resolve({
          oil: [{ unit: 'لتر', factorToBase: '0.92', label: 'لتر' }],
        });
      }
      return new Promise((resolve) => {
        releaseUnits = resolve;
      });
    });
    vi.mocked(recordOpeningStock).mockRejectedValueOnce(
      new ConversionChangedError(),
    );
    render(
      <MemoryRouter>
        <OpeningPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('كمية زيت')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    const stamp = screen.getByLabelText<HTMLInputElement>('وقت الرصيد').value;
    fireEvent.change(screen.getByLabelText('كمية زيت'), {
      target: { value: '4' },
    });
    fireEvent.change(screen.getByLabelText('وحدة زيت'), {
      target: { value: 'لتر' },
    });
    fireEvent.change(screen.getByLabelText('تكلفة زيت'), {
      target: { value: '12.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      conversionChangedMessage,
    );
    expect(screen.getByLabelText('وقت الرصيد')).toHaveValue(stamp);
    expect(screen.getByLabelText('كمية زيت')).toHaveValue('4');
    expect(screen.getByLabelText('وحدة زيت')).toHaveValue('لتر');
    expect(screen.getByLabelText('تكلفة زيت')).toHaveValue('12.5');
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    expect(lookedUpAt.length).toBeGreaterThanOrEqual(2);
    expect(lookedUpAt[1]).toBe(lookedUpAt[0]);

    await act(async () => {
      releaseUnits({
        oil: [{ unit: 'لتر', factorToBase: '1.25', label: 'لتر' }],
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    expect(screen.getByLabelText('وقت الرصيد')).toHaveValue(stamp);
    const first = vi.mocked(recordOpeningStock).mock.calls[0]?.[0];
    expect(first?.lines[0]?.expectedFactor).toBe('0.92');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordOpeningStock).toHaveBeenCalledTimes(2);
    });
    const second = vi.mocked(recordOpeningStock).mock.calls[1]?.[0];
    expect(second?.lines[0]?.expectedFactor).toBe('1.25');
    expect(second?.lines[0]?.unit).toBe('لتر');
    expect(second?.occurredAt).toBe(first?.occurredAt);
    expect(second?.requestId).toBe(first?.requestId);
  });
});
