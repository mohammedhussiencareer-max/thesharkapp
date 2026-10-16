import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listConversions, updateConversion } from '@/items/api';
import { ItemList } from '@/items/ItemList';
import type { CatalogItem, UnitConversion } from '@/items/types';

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

function Host() {
  const [openId, setOpenId] = useState<string | null>(item.id);
  return (
    <ItemList
      items={[item]}
      showInactive={false}
      openConversionsId={openId}
      editsDisabled={false}
      onEdit={() => undefined}
      onToggleConversions={(id) =>
        setOpenId((current) => (current === id ? null : id))
      }
    />
  );
}

describe('ItemList', () => {
  beforeEach(() => {
    vi.mocked(listConversions).mockReset();
    vi.mocked(updateConversion).mockReset();
    vi.mocked(updateConversion).mockResolvedValue(undefined);
  });

  it('keeps the conversions toggle locked until a factor save reloads', async () => {
    const initial: UnitConversion = {
      itemId: item.id,
      unit: 'كيس',
      factorToBase: 1,
      storedFactor: 1,
    };
    const saved: UnitConversion = {
      ...initial,
      factorToBase: 2,
      storedFactor: 2,
    };
    let resolveReload: (value: UnitConversion[]) => void = () => undefined;
    let calls = 0;
    vi.mocked(listConversions).mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve([initial]);
      if (calls === 2) {
        return new Promise((resolve) => {
          resolveReload = resolve;
        });
      }
      return Promise.resolve([saved]);
    });

    render(<Host />);
    expect(await screen.findByText('1 كيس = 1 كيلو')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('معامل كيس'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المعامل' }));

    const toggle = () => screen.getByRole('button', { name: 'التحويلات' });
    await waitFor(() => expect(toggle()).toBeDisabled());
    fireEvent.click(toggle());
    expect(screen.getByText('1 كيس = 1 كيلو')).toBeInTheDocument();

    resolveReload([saved]);
    expect(await screen.findByText('1 كيس = 2 كيلو')).toBeInTheDocument();
    await waitFor(() => expect(toggle()).toBeEnabled());

    fireEvent.click(toggle());
    expect(screen.queryByText('1 كيس = 2 كيلو')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'التحويلات' }));
    expect(await screen.findByText('1 كيس = 2 كيلو')).toBeInTheDocument();
  });
});
