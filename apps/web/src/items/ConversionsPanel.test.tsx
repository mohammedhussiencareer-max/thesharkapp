import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addConversion,
  addCustomUnit,
  costingImpact,
  currentShiftStart,
  deleteConversion,
  listConversions,
  listCostingSchedule,
  listUnitOptions,
  updateConversion,
} from '@/items/api';
import { ConversionsPanel } from '@/items/ConversionsPanel';
import {
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
import type { BaseUnit, CatalogItem, UnitConversion } from '@/items/types';

vi.mock('@/items/api', () => ({
  listConversions: vi.fn(),
  addConversion: vi.fn(),
  updateConversion: vi.fn(),
  deleteConversion: vi.fn(),
  currentShiftStart: vi.fn(() => Promise.resolve(null)),
  listCostingSchedule: vi.fn(() =>
    Promise.resolve({
      lossToken: 'd41d8cd98f00b204e9800998ecf8427e',
      identity: 'kg|ingredient||',
      lossVersions: [],
      conversions: [],
    }),
  ),
  costingImpact: vi.fn(() =>
    Promise.resolve({ orders: 0, shifts: 0, movements: 0 }),
  ),
  listUnitOptions: vi.fn(() =>
    Promise.resolve([
      { code: 'كيس', labelAr: 'كيس' },
      { code: 'كرتونة', labelAr: 'كرتونة' },
      { code: 'piece', labelAr: 'قطعة' },
    ]),
  ),
  addCustomUnit: vi.fn((code: string) => Promise.resolve(code)),
}));

function snapshot(rows: UnitConversion[], baseUnit: BaseUnit = 'kg') {
  return { baseUnit, rows };
}

const item: CatalogItem = {
  id: 'oil',
  name: 'زيت',
  kind: 'ingredient',
  baseUnit: 'kg',
  countFrequency: 'weekly',
  lossPct: 0,
  parentItemId: null,
  active: true,
  onHandQty: 0,
  avgCost: 0,
  onHandValue: 0,
};

const literItem: CatalogItem = { ...item, baseUnit: 'liter' };

function sentTiming(index: number): {
  requestId: string;
  effectiveFrom: string | null;
} {
  const timing = vi.mocked(addConversion).mock.calls[index]?.[4] as
    { requestId: string; effectiveFrom: string | null } | undefined;
  return timing ?? { requestId: '', effectiveFrom: null };
}

describe('ConversionsPanel', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.mocked(listConversions).mockReset();
    vi.mocked(addConversion).mockReset();
    vi.mocked(updateConversion).mockReset();
    vi.mocked(deleteConversion).mockReset();
    vi.mocked(addConversion).mockResolvedValue(undefined);
    vi.mocked(addCustomUnit).mockReset();
    vi.mocked(addCustomUnit).mockImplementation((code: string) =>
      Promise.resolve(code),
    );
    vi.mocked(currentShiftStart).mockReset();
    vi.mocked(currentShiftStart).mockResolvedValue(null);
    vi.mocked(costingImpact).mockReset();
    vi.mocked(costingImpact).mockResolvedValue({
      orders: 0,
      shifts: 0,
      movements: 0,
    });
    vi.mocked(listUnitOptions).mockReset();
    vi.mocked(listUnitOptions).mockResolvedValue([
      { code: 'كيس', labelAr: 'كيس' },
      { code: 'كرتونة', labelAr: 'كرتونة' },
      { code: 'piece', labelAr: 'قطعة' },
    ]);
    vi.mocked(listCostingSchedule).mockReset();
    vi.mocked(listCostingSchedule).mockResolvedValue({
      lossToken: 'd41d8cd98f00b204e9800998ecf8427e',
      identity: 'kg|ingredient||',
      lossVersions: [],
      conversions: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the exact stored factor instead of a rounded quantity', async () => {
    vi.mocked(listConversions).mockResolvedValue(
      snapshot([
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
      ]),
    );

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
    vi.mocked(listConversions).mockResolvedValue(
      snapshot([
        {
          itemId: 'oil',
          unit: 'طن',
          factorToBase: 0,
          storedFactor: '12345678.123456789',
        },
      ]),
    );
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
        'kg',
        expect.objectContaining({
          effectiveFrom: null,
          effectiveTo: null,
          token: 'd41d8cd98f00b204e9800998ecf8427e',
          reason: null,
        }),
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
      .mockResolvedValueOnce(snapshot([before]))
      .mockResolvedValueOnce(snapshot([after]));
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

  it('shows the liter label and reloads the item after a stale add', async () => {
    const onItemStale = vi.fn();
    vi.mocked(listConversions)
      .mockResolvedValueOnce(snapshot([]))
      .mockResolvedValueOnce(
        snapshot(
          [{ itemId: 'oil', unit: 'كيس', factorToBase: 2, storedFactor: '2' }],
          'liter',
        ),
      );
    vi.mocked(addConversion).mockRejectedValueOnce(new StaleWriteError());

    render(<ConversionsPanel item={item} onItemStale={onItemStale} />);
    expect(
      await screen.findByText('مفيش تحويلات للصنف ده'),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('option', { name: 'كيس' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كيس' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'البيانات اتغيّرت من مكان تاني — اتعملها تحديث، راجعها واحفظ تاني',
    );
    expect(addConversion).toHaveBeenCalledWith(
      'oil',
      'كيس',
      '25',
      'kg',
      expect.objectContaining({ effectiveFrom: null, reason: null }),
    );
    expect(await screen.findByText('1 كيس = 2 لتر')).toBeInTheDocument();
    expect(screen.queryByText('1 كيس = 2 كيلو')).not.toBeInTheDocument();
    expect(screen.queryByText('1 كيس = 25 كيلو')).not.toBeInTheDocument();
    expect(onItemStale).toHaveBeenCalled();
  });

  it('labels rows with the snapshot unit when the item base unit is stale', async () => {
    const onItemStale = vi.fn();
    vi.mocked(listConversions).mockResolvedValue(
      snapshot(
        [{ itemId: 'oil', unit: 'كيس', factorToBase: 2, storedFactor: '2' }],
        'liter',
      ),
    );

    render(<ConversionsPanel item={item} onItemStale={onItemStale} />);

    expect(await screen.findByText('1 كيس = 2 لتر')).toBeInTheDocument();
    expect(screen.queryByText(/كيلو/)).not.toBeInTheDocument();
    expect(onItemStale).toHaveBeenCalled();
  });

  it('blocks conversion saves while the snapshot base unit differs from the item shown', async () => {
    const onItemStale = vi.fn();
    vi.mocked(listConversions).mockResolvedValue(
      snapshot(
        [{ itemId: 'oil', unit: 'كيس', factorToBase: 2, storedFactor: '2' }],
        'liter',
      ),
    );

    render(<ConversionsPanel item={item} onItemStale={onItemStale} />);
    expect(await screen.findByText('1 كيس = 2 لتر')).toBeInTheDocument();
    expect(
      await screen.findByText(identityOutOfDateMessage),
    ).toBeInTheDocument();
    expect(onItemStale).toHaveBeenCalledWith('oil');
    expect(screen.getByRole('button', { name: 'ضيف التحويل' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'حفظ المعامل' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'احذف التحويل' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));
    fireEvent.click(screen.getByRole('button', { name: 'احذف التحويل' }));
    expect(updateConversion).not.toHaveBeenCalled();
    expect(deleteConversion).not.toHaveBeenCalled();
  });

  it('sends update and delete with the snapshot base unit', async () => {
    vi.mocked(listConversions).mockResolvedValue(
      snapshot(
        [{ itemId: 'oil', unit: 'كيس', factorToBase: 2, storedFactor: '2' }],
        'liter',
      ),
    );
    vi.mocked(listCostingSchedule).mockResolvedValue({
      lossToken: 'd41d8cd98f00b204e9800998ecf8427e',
      identity: 'liter|ingredient||',
      lossVersions: [],
      conversions: [],
    });
    vi.mocked(updateConversion).mockResolvedValue(undefined);
    vi.mocked(deleteConversion).mockResolvedValue(undefined);

    render(<ConversionsPanel item={literItem} />);
    expect(await screen.findByText('1 كيس = 2 لتر')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('معامل كيس'), {
      target: { value: '25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));
    await waitFor(() => {
      expect(updateConversion).toHaveBeenCalledWith(
        'oil',
        'كيس',
        '25',
        '2',
        'liter',
        expect.objectContaining({ effectiveFrom: null, reason: null }),
      );
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'احذف التحويل' }),
      ).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'احذف التحويل' }));
    await waitFor(() => {
      expect(deleteConversion).toHaveBeenCalledWith(
        'oil',
        'كيس',
        '2',
        'liter',
        expect.objectContaining({ effectiveFrom: null, reason: null }),
      );
    });
  });

  it('shows the stale message and reloads when an update is refused', async () => {
    const onItemStale = vi.fn();
    vi.mocked(listConversions)
      .mockResolvedValueOnce(
        snapshot([
          { itemId: 'oil', unit: 'كيس', factorToBase: 2, storedFactor: '2' },
        ]),
      )
      .mockResolvedValueOnce(
        snapshot(
          [{ itemId: 'oil', unit: 'كيس', factorToBase: 2, storedFactor: '2' }],
          'liter',
        ),
      );
    vi.mocked(updateConversion).mockRejectedValueOnce(new StaleWriteError());

    render(<ConversionsPanel item={item} onItemStale={onItemStale} />);
    expect(await screen.findByText('1 كيس = 2 كيلو')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'البيانات اتغيّرت من مكان تاني — اتعملها تحديث، راجعها واحفظ تاني',
    );
    expect(await screen.findByText('1 كيس = 2 لتر')).toBeInTheDocument();
    expect(updateConversion).toHaveBeenCalledWith(
      'oil',
      'كيس',
      '2',
      '2',
      'kg',
      expect.objectContaining({ effectiveFrom: null, reason: null }),
    );
    expect(onItemStale).toHaveBeenCalled();
  });

  it('shows a reload error and retry when refreshing after a save fails', async () => {
    vi.mocked(listConversions)
      .mockResolvedValueOnce(
        snapshot([
          { itemId: 'oil', unit: 'كرتونة', factorToBase: 12, storedFactor: 12 },
        ]),
      )
      .mockRejectedValueOnce(new Error('حصل خطأ. حاول تاني.'));
    vi.mocked(addConversion).mockResolvedValue(undefined);

    render(<ConversionsPanel item={item} />);

    expect(await screen.findByText('1 كرتونة = 12 كيلو')).toBeInTheDocument();
    expect(
      await screen.findByRole('option', { name: 'كيس' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('الوحدة'), {
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

  it.each([
    ['unit options', () => vi.mocked(listUnitOptions)],
    ['shift start', () => vi.mocked(currentShiftStart)],
  ])(
    'retries the %s load and enables the controls when it fails first',
    async (_name, failing) => {
      vi.mocked(listConversions).mockResolvedValue(
        snapshot([
          { itemId: 'oil', unit: 'كرتونة', factorToBase: 12, storedFactor: 12 },
        ]),
      );
      failing().mockRejectedValueOnce(new Error('حصل خطأ. حاول تاني.'));

      render(<ConversionsPanel item={item} />);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'حصل خطأ. حاول تاني.',
      );
      expect(screen.getByText('1 كرتونة = 12 كيلو')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'ضيف التحويل' }),
      ).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });
      expect(
        await screen.findByRole('option', { name: 'كيس' }),
      ).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('الوحدة'), {
        target: { value: 'كيس' },
      });
      fireEvent.change(screen.getByLabelText('المعامل'), {
        target: { value: '2' },
      });
      expect(screen.getByRole('button', { name: 'ضيف التحويل' })).toBeEnabled();
      expect(failing()).toHaveBeenCalledTimes(2);
    },
  );

  it('blocks every conversion save while the item identity is unsaved', async () => {
    vi.mocked(listConversions).mockResolvedValue(
      snapshot([
        { itemId: 'oil', unit: 'كرتونة', factorToBase: 12, storedFactor: '12' },
      ]),
    );

    render(<ConversionsPanel item={item} identityDirty />);

    expect(await screen.findByText('1 كرتونة = 12 كيلو')).toBeInTheDocument();
    expect(
      await screen.findByRole('option', { name: 'كيس' }),
    ).toBeInTheDocument();
    expect(screen.getByText(saveDetailsFirstMessage)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كيس' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('معامل كرتونة'), {
      target: { value: '13' },
    });
    expect(screen.getByRole('button', { name: 'ضيف التحويل' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'حفظ المعامل' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'احذف التحويل' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));
    fireEvent.click(screen.getByRole('button', { name: 'احذف التحويل' }));
    expect(addConversion).not.toHaveBeenCalled();
    expect(updateConversion).not.toHaveBeenCalled();
    expect(deleteConversion).not.toHaveBeenCalled();
  });

  it('blocks every conversion save while the schedule identity differs from the item shown', async () => {
    const onItemStale = vi.fn();
    const row = {
      itemId: 'oil',
      unit: 'كرتونة',
      factorToBase: 12,
      storedFactor: '12',
    };
    let resolveRefresh: (value: ReturnType<typeof snapshot>) => void = () =>
      undefined;
    vi.mocked(listConversions)
      .mockResolvedValueOnce(snapshot([row], 'kg'))
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    vi.mocked(listCostingSchedule).mockResolvedValue({
      lossToken: 'd41d8cd98f00b204e9800998ecf8427e',
      identity: 'liter|ingredient||',
      lossVersions: [],
      conversions: [],
    });

    const view = render(
      <ConversionsPanel item={item} onItemStale={onItemStale} />,
    );
    expect(await screen.findByText('1 كرتونة = 12 كيلو')).toBeInTheDocument();
    expect(
      await screen.findByRole('option', { name: 'كيس' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(identityOutOfDateMessage),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(onItemStale).toHaveBeenCalledWith('oil');
    });

    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كيس' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('معامل كرتونة'), {
      target: { value: '13' },
    });
    expect(screen.getByRole('button', { name: 'ضيف التحويل' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'حفظ المعامل' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'احذف التحويل' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));
    fireEvent.click(screen.getByRole('button', { name: 'احذف التحويل' }));
    expect(addConversion).not.toHaveBeenCalled();
    expect(updateConversion).not.toHaveBeenCalled();
    expect(deleteConversion).not.toHaveBeenCalled();

    const staleCalls = onItemStale.mock.calls.length;
    view.rerender(
      <ConversionsPanel item={literItem} onItemStale={onItemStale} />,
    );
    await waitFor(() => {
      expect(listConversions).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText('1 كرتونة = 12 كيلو')).toBeInTheDocument();
    expect(screen.getByText(identityOutOfDateMessage)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ضيف التحويل' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'حفظ المعامل' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'احذف التحويل' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));
    fireEvent.click(screen.getByRole('button', { name: 'احذف التحويل' }));
    expect(addConversion).not.toHaveBeenCalled();
    expect(updateConversion).not.toHaveBeenCalled();
    expect(deleteConversion).not.toHaveBeenCalled();

    resolveRefresh(snapshot([row], 'liter'));
    expect(await screen.findByText('1 كرتونة = 12 لتر')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByText(identityOutOfDateMessage),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ المعامل' })).toBeEnabled();
    });
    expect(screen.getByRole('button', { name: 'احذف التحويل' })).toBeEnabled();
    expect(onItemStale).toHaveBeenCalledTimes(staleCalls);
  });

  it('replays a held conversion unchanged while the cached snapshot lags the item', async () => {
    vi.mocked(listConversions)
      .mockResolvedValueOnce(snapshot([], 'kg'))
      .mockImplementation(() => new Promise(() => undefined));
    vi.mocked(addConversion)
      .mockRejectedValueOnce(new Error('تعذر الاتصال'))
      .mockResolvedValue(undefined);
    const view = render(<ConversionsPanel item={item} />);
    expect(
      await screen.findByRole('option', { name: 'كرتونة' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(addConversion).toHaveBeenCalledTimes(1);

    view.rerender(<ConversionsPanel item={literItem} />);
    expect(
      await screen.findByText(identityOutOfDateMessage),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(listConversions).toHaveBeenCalledTimes(2);
    });
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(addConversion).mock.calls[1]).toEqual(
      vi.mocked(addConversion).mock.calls[0],
    );
    expect(vi.mocked(addConversion).mock.calls[1]?.[3]).toBe('kg');
  });

  it('approves the unchanged factor for an earlier interval with a reason and a reviewed impact', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));
    vi.mocked(listConversions).mockResolvedValue(
      snapshot([
        {
          itemId: 'oil',
          unit: 'كيس',
          factorToBase: 2,
          storedFactor: '2',
          effectiveFrom: '2026-07-01T00:00:00.000Z',
        },
      ]),
    );
    vi.mocked(listCostingSchedule).mockResolvedValue({
      lossToken: 'd41d8cd98f00b204e9800998ecf8427e',
      identity: 'kg|ingredient||',
      lossVersions: [],
      conversions: [
        {
          unitCode: 'كيس',
          token: 'tok',
          versions: [
            {
              id: 'v1',
              effectiveFrom: '2026-07-01T00:00:00.000Z',
              effectiveTo: null,
              valueText: '2',
            },
          ],
        },
      ],
    });
    vi.mocked(costingImpact).mockResolvedValue({
      orders: 3,
      shifts: 1,
      movements: 0,
    });
    vi.mocked(updateConversion).mockResolvedValue(undefined);
    render(<ConversionsPanel item={item} />);
    expect(await screen.findByText(/1 كيس = 2 كيلو/)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'تحويل كيس' });
    await waitFor(() => {
      expect(
        within(form).getByRole('button', { name: 'حفظ المعامل' }),
      ).toBeEnabled();
    });

    fireEvent.change(within(form).getByLabelText('وقت السريان'), {
      target: { value: 'custom' },
    });
    fireEvent.change(within(form).getByLabelText('الوقت'), {
      target: { value: '2026-06-20T10:00' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'حفظ المعامل' }));
    expect(
      within(form).getByText('اكتب سبب التغيير بأثر رجعي'),
    ).toBeInTheDocument();
    expect(updateConversion).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText('سبب التغيير'), {
      target: { value: 'تصحيح' },
    });
    expect(
      await within(form).findByText('ممكن يأثر على 3 طلب في 1 وردية (تقدير)'),
    ).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'حفظ المعامل' }));
    await waitFor(() => {
      expect(updateConversion).toHaveBeenCalledTimes(1);
    });
    expect(updateConversion).toHaveBeenCalledWith(
      'oil',
      'كيس',
      '2',
      '2',
      'kg',
      expect.objectContaining({
        effectiveFrom: '2026-06-20T07:00:00.000Z',
        effectiveTo: '2026-07-01T00:00:00.000Z',
        reason: 'تصحيح',
        token: 'tok',
      }),
    );
    expect(costingImpact).toHaveBeenCalledWith(
      '2026-06-20T07:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
      'oil',
    );
  });

  it('re-initializes the factor input when only the base unit changes', async () => {
    const bag = {
      itemId: 'oil',
      unit: 'كيس',
      factorToBase: 2,
      storedFactor: '2',
    };
    // Deleted, base unit changed, re-added with the same factor elsewhere.
    vi.mocked(listConversions)
      .mockResolvedValueOnce(snapshot([bag], 'kg'))
      .mockResolvedValueOnce(snapshot([bag], 'liter'));
    vi.mocked(updateConversion).mockRejectedValueOnce(new StaleWriteError());

    render(<ConversionsPanel item={item} />);
    expect(await screen.findByText('1 كيس = 2 كيلو')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('معامل كيس'), {
      target: { value: '25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));

    expect(await screen.findByText('1 كيس = 2 لتر')).toBeInTheDocument();
    expect(screen.getByLabelText('معامل كيس')).toHaveValue('2');
  });

  it('ignores a snapshot that lands after the panel unmounts', async () => {
    let resolveLoad: (value: ReturnType<typeof snapshot>) => void = () =>
      undefined;
    vi.mocked(listConversions).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const onItemStale = vi.fn();

    const view = render(
      <ConversionsPanel item={item} onItemStale={onItemStale} />,
    );
    view.unmount();
    resolveLoad(snapshot([], 'liter'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onItemStale).not.toHaveBeenCalled();
  });

  it('ignores a retry that lands after the panel unmounts', async () => {
    vi.mocked(listConversions).mockRejectedValueOnce(
      new Error('حصل خطأ. حاول تاني.'),
    );
    let resolveRetry: (value: ReturnType<typeof snapshot>) => void = () =>
      undefined;
    vi.mocked(listConversions).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRetry = resolve;
      }),
    );
    const onItemStale = vi.fn();

    const view = render(
      <ConversionsPanel item={item} onItemStale={onItemStale} />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'إعادة المحاولة' }),
    );
    view.unmount();
    resolveRetry(snapshot([], 'liter'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onItemStale).not.toHaveBeenCalled();
  });

  it('reports the stale item by its own id', async () => {
    vi.mocked(listConversions).mockResolvedValueOnce(snapshot([], 'liter'));
    const onItemStale = vi.fn();

    render(<ConversionsPanel item={item} onItemStale={onItemStale} />);

    await waitFor(() => {
      expect(onItemStale).toHaveBeenCalledWith('oil');
    });
  });

  it('uses a new request id for each unit when the factor is the same', async () => {
    vi.mocked(listConversions).mockResolvedValue(snapshot([]));
    render(<ConversionsPanel item={item} />);
    expect(
      await screen.findByRole('option', { name: 'كرتونة' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'piece' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(2);
    });

    const first = sentTiming(0).requestId;
    const second = sentTiming(1).requestId;
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(second).not.toBe(first);
    expect(vi.mocked(addConversion).mock.calls[0]?.[1]).toBe('كرتونة');
    expect(vi.mocked(addConversion).mock.calls[1]?.[1]).toBe('piece');
    expect(vi.mocked(addConversion).mock.calls[0]?.[2]).toBe('4');
    expect(vi.mocked(addConversion).mock.calls[1]?.[2]).toBe('4');
  });

  it('reuses a request id only for an unknown retry of the same conversion', async () => {
    vi.mocked(listConversions).mockResolvedValue(snapshot([]));
    vi.mocked(addConversion)
      .mockRejectedValueOnce(new Error('تعذر الاتصال'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        Object.assign(new Error('مرفوض'), { code: '22023' }),
      )
      .mockResolvedValueOnce(undefined);
    render(<ConversionsPanel item={item} />);
    expect(
      await screen.findByRole('option', { name: 'كرتونة' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '8' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(2);
    });
    expect(sentTiming(1).requestId).toBe(sentTiming(0).requestId);

    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '8' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('مرفوض');
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(4);
    });
    expect(sentTiming(3).requestId).not.toBe(sentTiming(2).requestId);
    expect(sentTiming(2).requestId).not.toBe(sentTiming(0).requestId);
  });

  function addFreshUnit() {
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: '__new__' },
    });
    fireEvent.change(screen.getByLabelText('كود الوحدة'), {
      target: { value: 'دلو' },
    });
    fireEvent.change(screen.getByLabelText('اسم الوحدة'), {
      target: { value: 'دلو كبير' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
  }

  it('keeps a created unit when the conversion is interrupted and the retry succeeds', async () => {
    vi.mocked(listConversions).mockResolvedValue(snapshot([]));
    let listed = 0;
    vi.mocked(listUnitOptions).mockImplementation(() => {
      listed += 1;
      const options = [
        { code: 'كيس', labelAr: 'كيس' },
        { code: 'كرتونة', labelAr: 'كرتونة' },
        { code: 'piece', labelAr: 'قطعة' },
      ];
      if (listed > 1) options.push({ code: 'دلو-1', labelAr: 'دلو كبير' });
      return Promise.resolve(options);
    });
    vi.mocked(addCustomUnit).mockResolvedValue('دلو-1');
    vi.mocked(addConversion).mockRejectedValueOnce(new Error('تعذر الاتصال'));
    render(<ConversionsPanel item={item} />);
    expect(
      await screen.findByRole('option', { name: 'كيس' }),
    ).toBeInTheDocument();

    addFreshUnit();
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذر الاتصال');
    expect(
      await screen.findByRole('option', { name: 'دلو كبير' }),
    ).toBeInTheDocument();
    expect(addCustomUnit).toHaveBeenCalledTimes(1);
    expect(addCustomUnit).toHaveBeenCalledWith(
      'دلو',
      'دلو كبير',
      expect.any(String),
    );
    expect(vi.mocked(addConversion).mock.calls[0]?.[1]).toBe('دلو-1');

    vi.mocked(addConversion).mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(2);
    });
    expect(addCustomUnit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addConversion).mock.calls[1]?.[1]).toBe('دلو-1');
    expect(sentTiming(1).requestId).toBe(sentTiming(0).requestId);
  });

  it('keeps a created unit when the conversion is refused and the retry succeeds', async () => {
    vi.mocked(listConversions).mockResolvedValue(snapshot([]));
    vi.mocked(addCustomUnit).mockResolvedValue('دلو-1');
    vi.mocked(addConversion).mockRejectedValueOnce(
      Object.assign(new Error('مرفوض'), { code: 'P0001' }),
    );
    render(<ConversionsPanel item={item} />);
    expect(
      await screen.findByRole('option', { name: 'كيس' }),
    ).toBeInTheDocument();

    addFreshUnit();
    expect(await screen.findByRole('alert')).toHaveTextContent('مرفوض');
    expect(addCustomUnit).toHaveBeenCalledTimes(1);

    vi.mocked(addConversion).mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(2);
    });
    expect(addCustomUnit).toHaveBeenCalledTimes(1);
    expect(sentTiming(1).requestId).not.toBe(sentTiming(0).requestId);
    expect(vi.mocked(addConversion).mock.calls[1]?.[1]).toBe('دلو-1');
  });

  it('asks for a reason when a future instant has become backdated before submit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));
    vi.mocked(listConversions).mockResolvedValue(snapshot([]));
    vi.mocked(costingImpact).mockResolvedValue({
      orders: 3,
      shifts: 1,
      movements: 0,
    });
    vi.mocked(addConversion).mockRejectedValueOnce(new Error('تعذر الاتصال'));
    render(<ConversionsPanel item={item} />);
    expect(
      await screen.findByRole('button', { name: 'ضيف التحويل' }),
    ).toBeEnabled();

    fireEvent.change(screen.getByLabelText('وقت السريان'), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByLabelText('الوقت'), {
      target: { value: '2026-07-15T12:02' },
    });
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '4' },
    });
    expect(screen.queryByLabelText('سبب التغيير')).not.toBeInTheDocument();

    vi.setSystemTime(new Date('2026-07-15T09:05:00.000Z'));
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    expect(screen.getByLabelText('سبب التغيير')).toBeInTheDocument();
    expect(screen.getByText('اكتب سبب التغيير بأثر رجعي')).toBeInTheDocument();
    expect(addConversion).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('سبب التغيير'), {
      target: { value: 'تصحيح' },
    });
    expect(
      await screen.findByText('ممكن يأثر على 3 طلب في 1 وردية (تقدير)'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(1);
    });
    expect(sentTiming(0).effectiveFrom).toBe('2026-07-15T09:02:00.000Z');
    expect(addConversion).toHaveBeenCalledWith(
      'oil',
      'كرتونة',
      '4',
      'kg',
      expect.objectContaining({
        effectiveFrom: '2026-07-15T09:02:00.000Z',
        reason: 'تصحيح',
      }),
    );

    expect(
      await screen.findByRole('button', { name: 'إعادة المحاولة' }),
    ).toBeInTheDocument();
    vi.setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(2);
    });
    expect(sentTiming(1).requestId).toBe(sentTiming(0).requestId);
    expect(sentTiming(1).effectiveFrom).toBe('2026-07-15T09:02:00.000Z');
  });

  it('blocks a backdated conversion while the impact estimate is pending or rejected', async () => {
    vi.mocked(currentShiftStart).mockResolvedValue('2020-01-01T00:00:00.000Z');
    vi.mocked(listConversions).mockResolvedValue(snapshot([]));
    let rejectImpact: (error: unknown) => void = () => undefined;
    vi.mocked(costingImpact).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectImpact = reject;
        }),
    );
    render(<ConversionsPanel item={item} />);
    expect(await screen.findByText(impactLoadingMessage)).toBeInTheDocument();
    expect(screen.queryByText(/0 طلب/)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'ضيف التحويل' })).toBeEnabled();
    });

    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    expect(screen.getByText('اكتب سبب التغيير بأثر رجعي')).toBeInTheDocument();
    expect(addConversion).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('سبب التغيير'), {
      target: { value: 'تصحيح' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    expect(screen.getByText(impactPendingMessage)).toBeInTheDocument();
    expect(addConversion).not.toHaveBeenCalled();

    rejectImpact(new Error('nope'));
    expect(await screen.findByText(impactErrorMessage)).toBeInTheDocument();
    expect(screen.queryByText(/0 طلب/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    expect(addConversion).not.toHaveBeenCalled();

    vi.mocked(costingImpact).mockResolvedValue({
      orders: 4,
      shifts: 2,
      movements: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByText('ممكن يأثر على 4 طلب في 2 وردية (تقدير)'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(1);
    });
  });

  it('replays an unknown conversion after a later permission refusal', async () => {
    vi.mocked(listConversions).mockResolvedValue(snapshot([]));
    vi.mocked(addConversion)
      .mockRejectedValueOnce(new Error('تعذر الاتصال'))
      .mockRejectedValueOnce(
        Object.assign(new Error('مش مسموح'), { code: '42501' }),
      )
      .mockResolvedValueOnce(undefined);
    render(<ConversionsPanel item={item} />);
    expect(
      await screen.findByRole('option', { name: 'كرتونة' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '6' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('مش مسموح');

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(3);
    });
    const first = sentTiming(0);
    const refused = sentTiming(1);
    const replayed = sentTiming(2);
    expect(refused.requestId).toBe(first.requestId);
    expect(replayed.requestId).toBe(first.requestId);
    expect(replayed.effectiveFrom).toBe(first.effectiveFrom);
    expect(vi.mocked(addConversion).mock.calls[2]?.[4]).toEqual(
      vi.mocked(addConversion).mock.calls[0]?.[4],
    );
  });

  it('requires a reason for an explicit start inside the current minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T09:00:45.000Z'));
    vi.mocked(listConversions).mockResolvedValue(snapshot([]));
    vi.mocked(costingImpact).mockResolvedValue({
      orders: 1,
      shifts: 1,
      movements: 0,
    });
    render(<ConversionsPanel item={item} />);
    expect(
      await screen.findByRole('button', { name: 'ضيف التحويل' }),
    ).toBeEnabled();

    fireEvent.change(screen.getByLabelText('وقت السريان'), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByLabelText('الوقت'), {
      target: { value: '2026-07-15T12:00' },
    });
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '4' },
    });
    expect(screen.getByLabelText('سبب التغيير')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    expect(screen.getByText('اكتب سبب التغيير بأثر رجعي')).toBeInTheDocument();
    expect(addConversion).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('سبب التغيير'), {
      target: { value: 'تصحيح' },
    });
    expect(
      await screen.findByText('ممكن يأثر على 1 طلب في 1 وردية (تقدير)'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(1);
    });
    expect(sentTiming(0).effectiveFrom).toBe('2026-07-15T09:00:00.000Z');
    expect(addConversion).toHaveBeenCalledWith(
      'oil',
      'كرتونة',
      '4',
      'kg',
      expect.objectContaining({
        effectiveFrom: '2026-07-15T09:00:00.000Z',
        reason: 'تصحيح',
      }),
    );
  });

  it('retires an unknown conversion when configuration changed proves it was not stored', async () => {
    let token = 'token-1';
    vi.mocked(listConversions).mockResolvedValue(
      snapshot([
        {
          itemId: 'oil',
          unit: 'piece',
          label: 'قطعة',
          factorToBase: 1,
          storedFactor: '1',
        },
      ]),
    );
    vi.mocked(listCostingSchedule).mockImplementation(() =>
      Promise.resolve({
        lossToken: 'd41d8cd98f00b204e9800998ecf8427e',
        identity: 'kg|ingredient||',
        lossVersions: [],
        conversions: [{ unitCode: 'كرتونة', token, versions: [] }],
      }),
    );
    vi.mocked(addConversion)
      .mockRejectedValueOnce(new Error('تعذر الاتصال'))
      .mockImplementationOnce(() => {
        token = 'token-2';
        return Promise.reject(new CostingChangedError());
      });
    render(<ConversionsPanel item={item} />);
    expect(await screen.findByText('1 قطعة = 1 كيلو')).toBeInTheDocument();
    expect(
      await screen.findByRole('option', { name: 'كرتونة' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('المعامل')).toBeDisabled();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ المعامل' })).toBeEnabled();
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '9' },
    });
    expect(screen.getByLabelText('المعامل')).toHaveValue('4');
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    expect(addConversion).toHaveBeenCalledTimes(1);
    expect(sentTiming(0).requestId).not.toBe('');
    expect(vi.mocked(addConversion).mock.calls[0]?.[4]).toEqual(
      expect.objectContaining({ token: 'token-1' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'البيانات اتغيرت — حدّث الصفحة وجرّب تاني',
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'ضيف التحويل' })).toBeEnabled();
    });
    expect(addConversion).toHaveBeenCalledTimes(2);
    expect(sentTiming(1).requestId).toBe(sentTiming(0).requestId);
    expect(vi.mocked(addConversion).mock.calls[1]?.[4]).toEqual(
      expect.objectContaining({ token: 'token-1' }),
    );

    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(3);
    });
    expect(sentTiming(2).requestId).not.toBe(sentTiming(0).requestId);
    expect(vi.mocked(addConversion).mock.calls[2]?.[2]).toBe('5');
    expect(vi.mocked(addConversion).mock.calls[2]?.[4]).toEqual(
      expect.objectContaining({ token: 'token-2' }),
    );
  });

  it('applies a later return to an earlier factor with a fresh request id', async () => {
    vi.mocked(listConversions).mockResolvedValue(
      snapshot([
        {
          itemId: 'oil',
          unit: 'كرتونة',
          factorToBase: 4,
          storedFactor: '4',
        },
      ]),
    );
    vi.mocked(updateConversion)
      .mockRejectedValueOnce(new Error('تعذر الاتصال'))
      .mockResolvedValue(undefined);
    render(<ConversionsPanel item={item} />);
    expect(await screen.findByText('1 كرتونة = 4 كيلو')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('معامل كرتونة')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('معامل كرتونة'), {
      target: { value: '5' },
    });
    expect(screen.getByLabelText('معامل كرتونة')).toHaveValue('4');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));
    expect(updateConversion).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(updateConversion).toHaveBeenCalledTimes(2);
    });
    const ids = () =>
      vi.mocked(updateConversion).mock.calls.map((call) => {
        const timing = call[5] as { requestId: string };
        return timing.requestId;
      });
    expect(ids()[1]).toBe(ids()[0]);
    expect(vi.mocked(updateConversion).mock.calls[1]?.[2]).toBe('4');
    await waitFor(() => {
      expect(screen.getByLabelText('معامل كرتونة')).toBeEnabled();
    });

    fireEvent.change(screen.getByLabelText('معامل كرتونة'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));
    await waitFor(() => {
      expect(updateConversion).toHaveBeenCalledTimes(3);
    });
    fireEvent.change(screen.getByLabelText('معامل كرتونة'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));
    await waitFor(() => {
      expect(updateConversion).toHaveBeenCalledTimes(4);
    });
    expect(ids()[2]).not.toBe(ids()[0]);
    expect(ids()[3]).not.toBe(ids()[2]);
    expect(ids()[3]).not.toBe(ids()[0]);
    expect(
      vi.mocked(updateConversion).mock.calls.map((call) => call[2]),
    ).toEqual(['4', '4', '5', '4']);
  });

  it('replays a deletion from the add form instead of sending the factor delete', async () => {
    vi.mocked(listConversions).mockResolvedValue(
      snapshot([
        { itemId: 'oil', unit: 'كيس', factorToBase: 2, storedFactor: '2' },
      ]),
    );
    vi.mocked(deleteConversion).mockRejectedValueOnce(
      new Error('تعذر الاتصال'),
    );
    render(<ConversionsPanel item={item} />);
    expect(await screen.findByText('1 كيس = 2 كيلو')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'احذف التحويل' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('معامل كيس')).toBeDisabled();
    expect(deleteConversion).toHaveBeenCalledTimes(1);
    const heldId = (
      vi.mocked(deleteConversion).mock.calls[0]?.[4] as { requestId: string }
    ).requestId;

    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '99' },
    });
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كيس' },
    });
    const addForm = screen.getByRole('form', { name: 'إضافة تحويل' });
    expect(within(addForm).getByLabelText('المعامل')).toBeDisabled();
    expect(within(addForm).getByLabelText('المعامل')).toHaveValue('99');
    expect(
      screen.getAllByRole('button', { name: 'إعادة المحاولة' }),
    ).toHaveLength(2);

    vi.mocked(deleteConversion).mockResolvedValueOnce(undefined);
    fireEvent.click(
      within(addForm).getByRole('button', { name: 'إعادة المحاولة' }),
    );
    await waitFor(() => {
      expect(deleteConversion).toHaveBeenCalledTimes(2);
    });
    expect(addConversion).not.toHaveBeenCalled();
    expect(updateConversion).not.toHaveBeenCalled();
    expect(vi.mocked(deleteConversion).mock.calls[1]).toEqual([
      'oil',
      'كيس',
      '2',
      'kg',
      expect.objectContaining({
        requestId: heldId,
        effectiveFrom: null,
        reason: null,
      }),
    ]);
  });

  it('replays the original custom unit after the panel is closed and opened', async () => {
    vi.mocked(listConversions).mockResolvedValue(snapshot([]));
    vi.mocked(addCustomUnit).mockRejectedValueOnce(new Error('تعذر الاتصال'));
    const view = render(<ConversionsPanel item={item} />);
    expect(
      await screen.findByRole('option', { name: 'كيس' }),
    ).toBeInTheDocument();

    addFreshUnit();
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(addCustomUnit).toHaveBeenCalledTimes(1);
    expect(addConversion).not.toHaveBeenCalled();
    const creationId = vi.mocked(addCustomUnit).mock.calls[0]?.[2];
    expect(addCustomUnit).toHaveBeenCalledWith('دلو', 'دلو كبير', creationId);
    view.unmount();

    render(<ConversionsPanel item={item} />);
    expect(
      await screen.findByRole('option', { name: 'كيس' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: '__new__' },
    });
    expect(screen.queryByText(unknownSaveMessage)).not.toBeInTheDocument();
    expect(screen.getByLabelText('اسم الوحدة')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('كود الوحدة'), {
      target: { value: 'دلو' },
    });
    expect(screen.getByLabelText('اسم الوحدة')).toBeDisabled();
    expect(screen.getByLabelText('اسم الوحدة')).toHaveValue('');
    expect(screen.getByText(unknownSaveMessage)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(addCustomUnit).toHaveBeenCalledTimes(2);
    });
    expect(addCustomUnit).toHaveBeenNthCalledWith(
      2,
      'دلو',
      'دلو كبير',
      creationId,
    );
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(1);
    });
    expect(addConversion).toHaveBeenCalledWith(
      'oil',
      'دلو',
      '3',
      'kg',
      expect.objectContaining({ effectiveFrom: null, reason: null }),
    );
  });
});
