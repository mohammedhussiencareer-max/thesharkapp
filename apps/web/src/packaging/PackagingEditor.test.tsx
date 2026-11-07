import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetHeldWrites } from '@/items/request-id';
import { sourceChangedMessage } from '@/mapping/labels';
import { setOrderTypePackaging } from '@/packaging/api';
import { PackagingEditor } from '@/packaging/PackagingEditor';
import type { PackagingVersion } from '@/packaging/types';

vi.mock('@/packaging/api', () => ({
  setOrderTypePackaging: vi.fn(),
  setBasePackaging: vi.fn(),
}));

vi.mock('@/items/api', () => ({
  costingImpact: vi.fn(() =>
    Promise.resolve({ orders: 0, shifts: 0, movements: null }),
  ),
  currentShiftStart: vi.fn(() => Promise.resolve(null)),
}));

const now = Date.now();
const shiftStart = new Date(now - 3 * 60 * 60 * 1000).toISOString();
const boundary = new Date(now - 60 * 60 * 1000).toISOString();

const noneVersion: PackagingVersion = {
  id: 'ver-none',
  effectiveFrom: '2000-01-01T00:00:00.000Z',
  effectiveTo: boundary,
  decision: 'none',
  lines: [],
};

const linesVersion: PackagingVersion = {
  id: 'ver-lines',
  effectiveFrom: boundary,
  effectiveTo: null,
  decision: 'lines',
  lines: [
    {
      lineNo: 1,
      stockItemId: 'box-1',
      quantity: '4',
      unitCode: 'piece',
      capacityKg: null,
    },
  ],
};

function renderEditor() {
  return render(
    <PackagingEditor
      subjectKey="packaging-order-type:test"
      kind="order_type"
      orderType="hall"
      schedule={{
        subjectId: 'sub-pack',
        token: 'pack-token',
        emptyToken: 'pack-empty',
        versions: [noneVersion, linesVersion],
      }}
      history={[]}
      items={[{ id: 'box-1', name: 'علبة', baseUnit: 'piece' }]}
      units={[{ code: 'piece', label: 'قطعة' }]}
      shiftStart={shiftStart}
      allowCapacity={false}
      onReload={vi.fn(() => Promise.resolve())}
    />,
  );
}

describe('PackagingEditor dated fields', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.mocked(setOrderTypePackaging).mockReset();
  });

  it('shows the lines policy when an untouched form moves from the shift to now', () => {
    renderEditor();
    const form = screen.getByRole('form', { name: 'تغليف نوع الطلب' });
    expect(form).toHaveTextContent('مفيش تغليف');
    fireEvent.change(screen.getByLabelText('وقت السريان'), {
      target: { value: 'now' },
    });
    expect(screen.getByLabelText('القرار')).toHaveValue('lines');
    expect(screen.getByLabelText('كمية التغليف')).toHaveValue('4');
    expect(screen.getByLabelText('صنف التغليف')).toHaveValue('box-1');
  });

  it('keeps a touched draft when the time crosses a version, then reseeds on save', async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText('القرار'), {
      target: { value: 'lines' },
    });
    fireEvent.change(screen.getByLabelText('كمية التغليف'), {
      target: { value: '9' },
    });
    fireEvent.change(screen.getByLabelText('وقت السريان'), {
      target: { value: 'now' },
    });
    expect(screen.getByLabelText('كمية التغليف')).toHaveValue('9');
    fireEvent.click(screen.getByRole('button', { name: 'احفظ التغليف' }));
    expect(await screen.findByText(sourceChangedMessage)).toBeInTheDocument();
    expect(vi.mocked(setOrderTypePackaging)).not.toHaveBeenCalled();
    expect(screen.getByLabelText('كمية التغليف')).toHaveValue('4');
    expect(screen.getByLabelText('صنف التغليف')).toHaveValue('box-1');
  });
});
