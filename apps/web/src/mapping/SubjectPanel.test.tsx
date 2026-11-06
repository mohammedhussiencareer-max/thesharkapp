import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmedRefusalError } from '@/items/errors';
import { resetHeldWrites, unknownSaveMessage } from '@/items/request-id';
import { setBaseMapping, setOptionMapping } from '@/mapping/api';
import { savedMappingMessage, savedOptionMessage } from '@/mapping/labels';
import { SubjectPanel } from '@/mapping/SubjectPanel';
import type {
  MappingCatalog,
  ObservedBase,
  SubjectDetail,
} from '@/mapping/types';

vi.mock('@/mapping/api', () => ({
  setBaseMapping: vi.fn(),
  setOptionPolicy: vi.fn(),
  setException: vi.fn(),
  setOptionMapping: vi.fn(),
}));

const base: ObservedBase = {
  posItemId: 'صنف ناقص',
  sizeKey: ['none'],
  sizeKeyText: '["none"]',
  itemName: 'صنف ناقص',
  saleCount: 2,
  lastOrderedAt: '2030-06-01T08:00:00.000Z',
  latestOrderId: 'order-1',
  latestLineId: 'line-1',
  mapStatus: 'incomplete',
};

const catalog: MappingCatalog = {
  recipes: [{ id: 'recipe-1', name: 'طبق تجريبي', kind: 'dish' }],
  items: [
    { id: 'item-1', name: 'ملح تجريبي', baseUnit: 'kg' },
    { id: 'item-2', name: 'فلفل تجريبي', baseUnit: 'kg' },
  ],
  units: [{ code: 'kg', label: 'كيلو' }],
  shiftStart: null,
};

const detail: SubjectDetail = {
  schedule: {
    subjectId: null,
    token: 'token-1',
    emptyToken: 'token-1',
    versions: [],
  },
  options: [],
  optionBindings: [],
  suggestions: [],
  history: [],
  optionHistory: [],
  resolution: {
    status: 'incomplete',
    issues: [{ code: 'unmapped_base', expandIssue: null }],
    requirements: [],
  },
};

const optionDetail: SubjectDetail = {
  ...detail,
  options: [
    {
      posItemId: 'صنف ناقص',
      sizeKeyText: '["none"]',
      optionValue: 'مشوي',
      seenCount: 1,
    },
  ],
  optionBindings: [
    {
      scope: 'global',
      optionValue: 'مشوي',
      schedule: {
        subjectId: 'opt-1',
        token: 'opt-token',
        emptyToken: 'opt-empty',
        versions: [],
      },
    },
  ],
};

function renderPanel(subjectDetail: SubjectDetail) {
  const releases: Array<(error?: Error) => void> = [];
  const onReload = () =>
    new Promise<void>((resolve, reject) => {
      releases.push((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  const view = render(
    <SubjectPanel
      base={base}
      detail={subjectDetail}
      catalog={catalog}
      onReload={onReload}
    />,
  );
  return {
    releases,
    unmount: () => view.unmount(),
    remount: () => {
      view.unmount();
      render(
        <SubjectPanel
          base={base}
          detail={subjectDetail}
          catalog={catalog}
          onReload={onReload}
        />,
      );
    },
  };
}

describe('SubjectPanel held writes', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.mocked(setBaseMapping).mockReset();
    vi.mocked(setOptionMapping).mockReset();
  });

  it('keeps a newer held base save when an older reload is refused', async () => {
    const requestIds: string[] = [];
    vi.mocked(setBaseMapping).mockImplementation((write) => {
      requestIds.push(write.requestId);
      if (requestIds.length === 1) return Promise.resolve();
      if (requestIds.length === 2) return Promise.reject(new Error('socket'));
      return Promise.resolve();
    });
    const panel = renderPanel(detail);
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'item-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الربط' }));
    await waitFor(() => {
      expect(panel.releases).toHaveLength(1);
    });
    panel.remount();
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'item-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الربط' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    await act(async () => {
      panel.releases[0]?.(new ConfirmedRefusalError('سطر الكاشير مش موجود'));
      await Promise.resolve();
    });
    expect(screen.getByText(unknownSaveMessage)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(requestIds).toHaveLength(3);
    });
    expect(requestIds[2]).toBe(requestIds[1]);
    expect(requestIds[2]).not.toBe(requestIds[0]);
    await act(async () => {
      panel.releases[1]?.();
      await Promise.resolve();
    });
    expect(await screen.findByText(savedMappingMessage)).toBeInTheDocument();
  });

  it('keeps a newer held option save when an older reload is refused', async () => {
    const requestIds: string[] = [];
    vi.mocked(setOptionMapping).mockImplementation((write) => {
      requestIds.push(write.requestId);
      if (requestIds.length === 1) return Promise.resolve();
      if (requestIds.length === 2) return Promise.reject(new Error('socket'));
      return Promise.resolve();
    });
    const panel = renderPanel(optionDetail);
    const form = screen.getByRole('form', { name: 'ربط الاختيار العام مشوي' });
    fireEvent.click(
      within(form).getByRole('button', { name: 'احفظ ربط الاختيار' }),
    );
    await waitFor(() => {
      expect(panel.releases).toHaveLength(1);
    });
    panel.remount();
    const again = screen.getByRole('form', { name: 'ربط الاختيار العام مشوي' });
    fireEvent.click(
      within(again).getByRole('button', { name: 'احفظ ربط الاختيار' }),
    );
    expect(
      await within(again).findByText(unknownSaveMessage),
    ).toBeInTheDocument();
    await act(async () => {
      panel.releases[0]?.(new ConfirmedRefusalError('سطر الكاشير مش موجود'));
      await Promise.resolve();
    });
    const heldForm = screen.getByRole('form', {
      name: 'ربط الاختيار العام مشوي',
    });
    expect(within(heldForm).getByText(unknownSaveMessage)).toBeInTheDocument();
    fireEvent.click(
      within(heldForm).getByRole('button', { name: 'إعادة المحاولة' }),
    );
    await waitFor(() => {
      expect(requestIds).toHaveLength(3);
    });
    expect(requestIds[2]).toBe(requestIds[1]);
    expect(requestIds[2]).not.toBe(requestIds[0]);
    await act(async () => {
      panel.releases[1]?.();
      await Promise.resolve();
    });
    expect(
      await within(heldForm).findByText(savedOptionMessage),
    ).toBeInTheDocument();
  });
});
