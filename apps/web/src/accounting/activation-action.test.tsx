import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateInventory, loadOpeningReview } from '@/accounting/api';
import { OpeningManifestChangedError, writeError } from '@/accounting/errors';
import type { OpeningReview } from '@/accounting/types';
import { resetHeldWrites, unknownAction } from '@/items/request-id';
import { ActivationPage } from '@/pages/ActivationPage';
import { reloadFailedMessage } from '@/waste/useWasteAction';

vi.mock('@/accounting/api', () => ({
  loadOpeningReview: vi.fn(),
  activateInventory: vi.fn(),
}));

const item = 'a7900000-0000-4000-8000-000000000001';
const hashA = 'a'.repeat(32);
const hashB = 'b'.repeat(32);

function opening(hash: string): OpeningReview {
  return {
    activated: false,
    stockStartedAt: null,
    openingManifestHash: hash,
    canActivate: false,
    checklist: [
      { code: 'not_activated', ready: false, count: '0' },
      { code: 'missing_observations', ready: false, count: '1' },
      { code: 'unreceipted_outflows', ready: true, count: '0' },
      { code: 'empty_roster', ready: true, count: '1' },
    ],
    roster: [
      {
        itemId: item,
        name: 'سمك',
        baseUnit: 'kg',
        active: true,
        missing: true,
        openingLineCount: '0',
        observation: null,
      },
    ],
    nextItemId: null,
  };
}

function renderPage() {
  render(
    <MemoryRouter>
      <ActivationPage />
    </MemoryRouter>,
  );
}

async function checkAndActivate() {
  expect(
    await screen.findByRole('button', { name: 'تفعيل الخصم' }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'صفر صريح' }));
  const button = await screen.findByRole('button', { name: 'تفعيل الخصم' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe('activation action', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.mocked(loadOpeningReview).mockReset();
    vi.mocked(activateInventory).mockReset();
  });

  it('sends the checked zeros with a new request id', async () => {
    vi.mocked(loadOpeningReview)
      .mockResolvedValueOnce(opening(hashA))
      .mockResolvedValue({
        ...opening(hashA),
        activated: true,
        stockStartedAt: '2026-03-01T08:00:00.000Z',
        roster: [],
      });
    vi.mocked(activateInventory).mockResolvedValue({
      activated: true,
      stockStartedAt: '2026-03-01T08:00:00.000Z',
      openingManifestHash: hashA,
    });
    renderPage();
    await checkAndActivate();
    await waitFor(() => expect(activateInventory).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(activateInventory).mock.calls[0]?.[0];
    expect(typeof sent?.requestId).toBe('string');
    expect(sent?.manifestHash).toBe(hashA);
    expect(sent?.explicitZeroItemIds).toEqual([item]);
  });

  it('keeps the request id and clears checks when the manifest changes', async () => {
    vi.mocked(loadOpeningReview)
      .mockResolvedValueOnce(opening(hashA))
      .mockResolvedValue(opening(hashB));
    vi.mocked(activateInventory).mockRejectedValueOnce(
      new OpeningManifestChangedError(),
    );
    renderPage();
    await checkAndActivate();
    expect(
      await screen.findByText('قائمة الافتتاح اتغيرت — راجعها وفعّل تاني'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'صفر صريح' }),
    ).not.toBeChecked();
    expect(unknownAction('activation')).toBeNull();
    const first = vi.mocked(activateInventory).mock.calls[0]?.[0];
    fireEvent.click(screen.getByRole('checkbox', { name: 'صفر صريح' }));
    vi.mocked(activateInventory).mockResolvedValue({
      activated: true,
      stockStartedAt: '2026-03-01T08:00:00.000Z',
      openingManifestHash: hashB,
    });
    const again = await screen.findByRole('button', { name: 'تفعيل الخصم' });
    await waitFor(() => expect(again).toBeEnabled());
    fireEvent.click(again);
    await waitFor(() => expect(activateInventory).toHaveBeenCalledTimes(2));
    expect(activateInventory).toHaveBeenLastCalledWith({
      requestId: first?.requestId,
      manifestHash: hashB,
      explicitZeroItemIds: [item],
    });
  });

  it('keeps the old payload when a generic 40001 is unknown', async () => {
    vi.mocked(loadOpeningReview).mockResolvedValue(opening(hashA));
    vi.mocked(activateInventory).mockRejectedValueOnce(
      writeError({ code: '40001', message: 'could not serialize' }),
    );
    renderPage();
    await checkAndActivate();
    expect(await screen.findByText('المكالمة ما اكتملتش')).toBeInTheDocument();
    const first = vi.mocked(activateInventory).mock.calls[0]?.[0];
    expect(unknownAction('activation')).toEqual(first);
    vi.mocked(activateInventory).mockResolvedValue({
      activated: true,
      stockStartedAt: null,
      openingManifestHash: hashA,
    });
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => expect(activateInventory).toHaveBeenCalledTimes(2));
    expect(activateInventory).toHaveBeenLastCalledWith(first);
  });

  it('does not offer another write when the confirmed activation cannot reload', async () => {
    vi.mocked(loadOpeningReview)
      .mockResolvedValueOnce(opening(hashA))
      .mockRejectedValueOnce(new Error('down'));
    vi.mocked(activateInventory).mockResolvedValue({
      activated: true,
      stockStartedAt: '2026-03-01T08:00:00.000Z',
      openingManifestHash: hashA,
    });
    renderPage();
    await checkAndActivate();
    expect(await screen.findByText(reloadFailedMessage)).toBeInTheDocument();
    expect(screen.getByText(/التفعيل اتسجل/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تفعيل الخصم' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'إعادة المحاولة' })).toBeNull();
    expect(unknownAction('activation')).toBeNull();
    expect(activateInventory).toHaveBeenCalledTimes(1);
  });

  it('reloads after a failed manifest refresh without resending the old token', async () => {
    vi.mocked(loadOpeningReview)
      .mockResolvedValueOnce(opening(hashA))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(opening(hashB));
    vi.mocked(activateInventory).mockRejectedValueOnce(
      new OpeningManifestChangedError(),
    );
    renderPage();
    await checkAndActivate();
    expect(await screen.findByText(reloadFailedMessage)).toBeInTheDocument();
    expect(unknownAction('activation')).toBeNull();
    const first = vi.mocked(activateInventory).mock.calls[0]?.[0];
    fireEvent.click(
      screen.getByRole('button', { name: 'إعادة تحميل المراجعة' }),
    );
    expect(
      await screen.findByText('قائمة الافتتاح اتغيرت — راجعها وفعّل تاني'),
    ).toBeInTheDocument();
    expect(activateInventory).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('checkbox', { name: 'صفر صريح' }));
    vi.mocked(activateInventory).mockResolvedValue({
      activated: true,
      stockStartedAt: '2026-03-01T08:00:00.000Z',
      openingManifestHash: hashB,
    });
    const again = await screen.findByRole('button', { name: 'تفعيل الخصم' });
    await waitFor(() => expect(again).toBeEnabled());
    fireEvent.click(again);
    await waitFor(() => expect(activateInventory).toHaveBeenCalledTimes(2));
    expect(vi.mocked(activateInventory).mock.calls[1]?.[0]).toEqual({
      requestId: first?.requestId,
      manifestHash: hashB,
      explicitZeroItemIds: [item],
    });
  });

  it('retries the sent zeros after a lost response and a remount', async () => {
    vi.mocked(loadOpeningReview)
      .mockResolvedValueOnce(opening(hashA))
      .mockResolvedValue(opening(hashB));
    vi.mocked(activateInventory).mockRejectedValueOnce(
      new OpeningManifestChangedError(),
    );
    const firstView = render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>,
    );
    await checkAndActivate();
    expect(
      await screen.findByText('قائمة الافتتاح اتغيرت — راجعها وفعّل تاني'),
    ).toBeInTheDocument();
    const requestId =
      vi.mocked(activateInventory).mock.calls[0]?.[0]?.requestId;
    fireEvent.click(screen.getByRole('checkbox', { name: 'صفر صريح' }));
    vi.mocked(activateInventory).mockRejectedValueOnce(
      writeError({
        code: '57014',
        message: 'canceling statement due to statement timeout',
      }),
    );
    const again = await screen.findByRole('button', { name: 'تفعيل الخصم' });
    await waitFor(() => expect(again).toBeEnabled());
    fireEvent.click(again);
    expect(await screen.findByText('المكالمة ما اكتملتش')).toBeInTheDocument();
    const sent = vi.mocked(activateInventory).mock.calls[1]?.[0];
    expect(sent).toEqual({
      requestId,
      manifestHash: hashB,
      explicitZeroItemIds: [item],
    });
    expect(unknownAction('activation')).toEqual(sent);
    firstView.unmount();
    vi.mocked(activateInventory).mockResolvedValue({
      activated: true,
      stockStartedAt: '2026-03-01T08:00:00.000Z',
      openingManifestHash: hashB,
    });
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'إعادة المحاولة' }),
    );
    await waitFor(() => expect(activateInventory).toHaveBeenCalledTimes(3));
    expect(activateInventory).toHaveBeenLastCalledWith(sent);
  });

  it('reloads after remount when a retry confirms the manifest changed', async () => {
    vi.mocked(loadOpeningReview)
      .mockResolvedValueOnce(opening(hashA))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(opening(hashA))
      .mockResolvedValue(opening(hashB));
    vi.mocked(activateInventory)
      .mockRejectedValueOnce(
        writeError({
          code: '57014',
          message: 'canceling statement due to statement timeout',
        }),
      )
      .mockRejectedValueOnce(new OpeningManifestChangedError());
    const firstView = render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>,
    );
    await checkAndActivate();
    expect(await screen.findByText('المكالمة ما اكتملتش')).toBeInTheDocument();
    const sent = vi.mocked(activateInventory).mock.calls[0]?.[0];
    expect(unknownAction('activation')).toEqual(sent);
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText(reloadFailedMessage)).toBeInTheDocument();
    expect(unknownAction('activation')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'إعادة تحميل المراجعة' }),
    ).toBeInTheDocument();
    expect(activateInventory).toHaveBeenCalledTimes(2);
    firstView.unmount();
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'إعادة تحميل المراجعة' }),
    );
    expect(
      await screen.findByText('قائمة الافتتاح اتغيرت — راجعها وفعّل تاني'),
    ).toBeInTheDocument();
    expect(activateInventory).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'إعادة المحاولة' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'صفر صريح' }));
    vi.mocked(activateInventory).mockResolvedValue({
      activated: true,
      stockStartedAt: '2026-03-01T08:00:00.000Z',
      openingManifestHash: hashB,
    });
    const again = await screen.findByRole('button', { name: 'تفعيل الخصم' });
    await waitFor(() => expect(again).toBeEnabled());
    fireEvent.click(again);
    await waitFor(() => expect(activateInventory).toHaveBeenCalledTimes(3));
    expect(activateInventory).toHaveBeenLastCalledWith({
      requestId: sent?.requestId,
      manifestHash: hashB,
      explicitZeroItemIds: [item],
    });
  });
});
