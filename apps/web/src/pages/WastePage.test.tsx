import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmedRefusalError } from '@/items/errors';
import {
  hasAction,
  resetHeldWrites,
  unknownSaveMessage,
} from '@/items/request-id';
import { WastePage } from '@/pages/WastePage';
import { listStockChoices } from '@/purchases/api';
import { loadHistoryPage, recordWaste } from '@/waste/api';
import {
  alreadyCorrectedMessage,
  AlreadyCorrectedError,
  MissingCostBasisError,
  notActivatedMessage,
} from '@/waste/errors';
import {
  documentSubject,
  newWasteSubject,
  reasonRequiredMessage,
} from '@/waste/format';
import {
  historyEntry,
  itemA,
  stockChoice,
  wasteResult,
} from '@/waste/test-fixtures';
import { reloadFailedMessage } from '@/waste/useWasteAction';

// Production pages are 20 rows. These tests use 2: each row mounts a card and
// an action subscription, and the paging cases re-render that list on refresh,
// save and every extra page. At 20 rows those five cases took about half a
// second each and hit the 5s timeout under load. Reload still asks for one
// more row than is showing, so a 2-row page still crosses a boundary and trims.
const pageSize = vi.hoisted(() => 2);

vi.mock('@/waste/api', () => ({
  historyPageSize: pageSize,
  loadHistoryPage: vi.fn(),
  recordWaste: vi.fn(),
}));

vi.mock('@/purchases/api', () => ({
  listStockChoices: vi.fn(),
  listUnitsAt: vi.fn((ids: readonly string[]) =>
    Promise.resolve(
      Object.fromEntries(
        ids.map((id) => [id, [{ unit: 'g', factorToBase: '0.001' }]]),
      ),
    ),
  ),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <WastePage />
    </MemoryRouter>,
  );
}

function lastWrite() {
  const call = vi.mocked(recordWaste).mock.calls.at(-1);
  if (!call) throw new Error('nothing was sent');
  return call[0];
}

async function fillNew(quantity = '2', reason = 'spoilage') {
  const form = await screen.findByRole('form', { name: 'تسجيل هالك جديد' });
  fireEvent.change(within(form).getByLabelText('السبب'), {
    target: { value: reason },
  });
  const line = within(form).getByRole('group', { name: 'سطر 1' });
  fireEvent.change(within(line).getByLabelText('الصنف'), {
    target: { value: itemA },
  });
  fireEvent.change(within(line).getByLabelText('الكمية'), {
    target: { value: quantity },
  });
  const submit = within(form).getByRole('button', { name: 'سجّل الهالك' });
  await waitFor(() => expect(submit).toBeEnabled());
  return { form, submit };
}

type Page = Awaited<ReturnType<typeof loadHistoryPage>>;

function slice(from: number, to: number, next: string | null): Page {
  const entries = [];
  for (let id = from; id >= to; id -= 1) {
    entries.push(historyEntry({ id: String(id) }));
  }
  return { entries, next };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Resolves a deferred response inside act, so its effects are flushed before the next step. */
function settle<T>(pending: { resolve: (value: T) => void }, value: T) {
  return act(() => {
    pending.resolve(value);
    return Promise.resolve();
  });
}

const moreButton = () => screen.getByRole('button', { name: 'عرض المزيد' });
const refreshButton = () => screen.getByRole('button', { name: 'تحديث' });

/** Ids 6 down to 3 on screen; the next page starts after 3. */
async function showTwoPages() {
  vi.mocked(loadHistoryPage).mockImplementation((after) => {
    if (after === null) return Promise.resolve(slice(6, 5, '5'));
    if (after === '5') return Promise.resolve(slice(4, 3, '3'));
    return Promise.reject(new Error(`unexpected cursor ${after}`));
  });
  renderPage();
  await screen.findByRole('article', { name: 'سجل رقم 6' });
  fireEvent.click(moreButton());
  await screen.findByRole('article', { name: 'سجل رقم 3' });
  expect(screen.getAllByRole('article')).toHaveLength(pageSize * 2);
}

const cursorsAsked = () =>
  vi.mocked(loadHistoryPage).mock.calls.map((call) => call[0]);

describe('WastePage', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.mocked(listStockChoices).mockReset();
    vi.mocked(loadHistoryPage).mockReset();
    vi.mocked(recordWaste).mockReset();
    vi.mocked(listStockChoices).mockResolvedValue([stockChoice()]);
    vi.mocked(loadHistoryPage).mockResolvedValue({ entries: [], next: null });
  });

  it('shows the form, the empty history and the way back home', async () => {
    renderPage();
    expect(await screen.findByText('مفيش هالك متسجل')).toBeInTheDocument();
    expect(
      screen.getByRole('form', { name: 'تسجيل هالك جديد' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'الرئيسية' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(loadHistoryPage).toHaveBeenCalledWith(null);
  });

  it('shows a load error and retries', async () => {
    vi.mocked(loadHistoryPage)
      .mockRejectedValueOnce(new Error('حصل خطأ. حاول تاني.'))
      .mockResolvedValueOnce({ entries: [historyEntry()], next: null });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('حصل خطأ');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByRole('article', { name: 'سجل رقم 7' }),
    ).toBeInTheDocument();
  });

  it('shows an entry with its saved conversion and Cairo time', async () => {
    vi.mocked(loadHistoryPage).mockResolvedValue({
      entries: [historyEntry({ explanation: 'اتكسر' })],
      next: null,
    });
    renderPage();
    const entry = await screen.findByRole('article', { name: 'سجل رقم 7' });
    expect(entry).toHaveTextContent('01/06/2030 13:30');
    expect(entry).toHaveTextContent('تالف');
    expect(entry).toHaveTextContent('الشرح: اتكسر');
    expect(entry).toHaveTextContent('= 0.5 كيلو');
    expect(entry).toHaveTextContent('تحويل قياسي');
  });

  it('pages the history by the last id', async () => {
    vi.mocked(loadHistoryPage)
      .mockResolvedValueOnce({
        entries: [historyEntry({ id: '8' })],
        next: '8',
      })
      .mockResolvedValueOnce({
        entries: [historyEntry({ id: '7' })],
        next: null,
      });
    renderPage();
    await screen.findByRole('article', { name: 'سجل رقم 8' });
    fireEvent.click(screen.getByRole('button', { name: 'عرض المزيد' }));
    await screen.findByRole('article', { name: 'سجل رقم 7' });
    expect(loadHistoryPage).toHaveBeenLastCalledWith('8');
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'عرض المزيد' })).toBeNull();
  });

  it('reloads a long history through bounded keyset pages and keeps paging after a save', async () => {
    vi.mocked(loadHistoryPage).mockImplementation((after) => {
      if (after === null) return Promise.resolve(slice(6, 5, '5'));
      if (after === '5') return Promise.resolve(slice(4, 3, '3'));
      if (after === '3') return Promise.resolve(slice(2, 1, null));
      if (after === '2') return Promise.resolve(slice(1, 1, null));
      return Promise.reject(new Error(`unexpected cursor ${after}`));
    });
    vi.mocked(recordWaste).mockResolvedValue(wasteResult());
    renderPage();
    await screen.findByRole('article', { name: 'سجل رقم 6' });
    fireEvent.click(moreButton());
    await screen.findByRole('article', { name: 'سجل رقم 3' });
    expect(screen.getAllByRole('article')).toHaveLength(pageSize * 2);

    const { submit } = await fillNew();
    fireEvent.click(submit);
    await screen.findByRole('status');

    const calls = vi.mocked(loadHistoryPage).mock.calls;
    // Two pages were on screen, so the reload reads one more row than that:
    // the first two pages again, then one trimmed row of the third page.
    expect(calls.slice(2)).toEqual([[null], ['5'], ['3']]);
    await waitFor(() =>
      expect(screen.getAllByRole('article')).toHaveLength(pageSize * 2 + 1),
    );
    fireEvent.click(moreButton());
    await screen.findByRole('article', { name: 'سجل رقم 1' });
    expect(vi.mocked(loadHistoryPage)).toHaveBeenLastCalledWith('2');
    expect(screen.getAllByRole('article')).toHaveLength(pageSize * 3);
    expect(screen.queryByRole('button', { name: 'عرض المزيد' })).toBeNull();
  });

  it('does not page from the old cursor while a refresh is pending', async () => {
    await showTwoPages();
    const refreshed = deferred<Page>();
    vi.mocked(loadHistoryPage).mockImplementation(async (after) => {
      if (after === null) return refreshed.promise;
      if (after === '5') return slice(4, 3, '3');
      if (after === '3') return slice(2, 1, null);
      throw new Error(`unexpected cursor ${after}`);
    });
    fireEvent.click(refreshButton());
    await waitFor(() => expect(moreButton()).toBeDisabled());
    fireEvent.click(moreButton());
    expect(cursorsAsked()).not.toContain('3');

    refreshed.resolve(slice(6, 5, '5'));
    await waitFor(() => expect(moreButton()).toBeEnabled());
    expect(screen.getAllByRole('article')).toHaveLength(pageSize);
    fireEvent.click(moreButton());
    await screen.findByRole('article', { name: 'سجل رقم 3' });
    expect(screen.getAllByRole('article')).toHaveLength(pageSize * 2);
    expect(screen.queryByRole('article', { name: 'سجل رقم 1' })).toBeNull();
    expect(cursorsAsked()).not.toContain('3');
    expect(moreButton()).toBeEnabled();
  });

  it('drops a paging response that arrives after the refresh replaced the list', async () => {
    await showTwoPages();
    const paging = deferred<Page>();
    const refreshed = deferred<Page>();
    vi.mocked(loadHistoryPage).mockImplementation(async (after) => {
      if (after === null) return refreshed.promise;
      if (after === '3') return paging.promise;
      if (after === '5') return slice(4, 3, '3');
      throw new Error(`unexpected cursor ${after}`);
    });
    fireEvent.click(moreButton());
    await waitFor(() => expect(moreButton()).toBeDisabled());
    fireEvent.click(refreshButton());
    await settle(refreshed, slice(6, 5, '5'));
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    expect(screen.getAllByRole('article')).toHaveLength(pageSize);

    await settle(paging, slice(2, 1, null));
    await waitFor(() => expect(moreButton()).toBeEnabled());
    expect(screen.getAllByRole('article')).toHaveLength(pageSize);
    expect(screen.queryByRole('article', { name: 'سجل رقم 1' })).toBeNull();
    fireEvent.click(moreButton());
    await screen.findByRole('article', { name: 'سجل رقم 3' });
    expect(screen.getAllByRole('article')).toHaveLength(pageSize * 2);
  });

  it('drops a paging response that arrives before the refresh replaced the list', async () => {
    await showTwoPages();
    const paging = deferred<Page>();
    const refreshed = deferred<Page>();
    vi.mocked(loadHistoryPage).mockImplementation(async (after) => {
      if (after === null) return refreshed.promise;
      if (after === '3') return paging.promise;
      if (after === '5') return slice(4, 3, '3');
      throw new Error(`unexpected cursor ${after}`);
    });
    fireEvent.click(moreButton());
    await waitFor(() => expect(moreButton()).toBeDisabled());
    fireEvent.click(refreshButton());
    await settle(paging, slice(2, 1, null));
    expect(screen.queryByRole('article', { name: 'سجل رقم 1' })).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(pageSize * 2);

    await settle(refreshed, slice(6, 5, '5'));
    await waitFor(() => expect(moreButton()).toBeEnabled());
    expect(screen.getAllByRole('article')).toHaveLength(pageSize);
    fireEvent.click(moreButton());
    await screen.findByRole('article', { name: 'سجل رقم 3' });
    expect(screen.getAllByRole('article')).toHaveLength(pageSize * 2);
    expect(screen.queryByRole('article', { name: 'سجل رقم 1' })).toBeNull();
  });

  it('does not page from the old cursor while a save reloads the history', async () => {
    await showTwoPages();
    const reloaded = deferred<Page>();
    let reloads = 0;
    vi.mocked(loadHistoryPage).mockImplementation(async (after) => {
      if (after === null) {
        reloads += 1;
        return reloaded.promise;
      }
      if (after === '5') return slice(4, 3, '3');
      if (after === '3') return slice(2, 1, null);
      throw new Error(`unexpected cursor ${after}`);
    });
    vi.mocked(recordWaste).mockResolvedValue(wasteResult());
    const { submit } = await fillNew();
    fireEvent.click(submit);
    await waitFor(() => expect(reloads).toBe(1));
    await waitFor(() => expect(moreButton()).toBeDisabled());
    fireEvent.click(moreButton());
    expect(cursorsAsked()).not.toContain('3');

    reloaded.resolve(slice(6, 5, '5'));
    await waitFor(() => expect(moreButton()).toBeEnabled());
    expect(screen.getAllByRole('article')).toHaveLength(pageSize * 2 + 1);
  });

  it('keeps Refresh usable when a save reloads the history while a refresh is pending', async () => {
    let finishChoices: (value: ReturnType<typeof stockChoice>[]) => void = () =>
      undefined;
    let finishHistory: (value: {
      entries: ReturnType<typeof historyEntry>[];
      next: string | null;
    }) => void = () => undefined;
    vi.mocked(recordWaste).mockResolvedValue(wasteResult());
    renderPage();
    const { submit } = await fillNew();
    await screen.findByText('مفيش هالك متسجل');

    vi.mocked(listStockChoices).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishChoices = resolve;
        }),
    );
    vi.mocked(loadHistoryPage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishHistory = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'تحديث' })).toBeDisabled(),
    );

    vi.mocked(loadHistoryPage).mockResolvedValue({
      entries: [historyEntry({ id: '8' })],
      next: null,
    });
    fireEvent.click(submit);
    await screen.findByRole('status');
    await screen.findByRole('article', { name: 'سجل رقم 8' });
    expect(screen.getByRole('button', { name: 'تحديث' })).toBeDisabled();

    finishChoices([stockChoice()]);
    finishHistory({ entries: [historyEntry({ id: '5' })], next: null });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'تحديث' })).toBeEnabled(),
    );
    expect(screen.getByRole('article', { name: 'سجل رقم 8' })).toBeVisible();
    expect(screen.queryByRole('article', { name: 'سجل رقم 5' })).toBeNull();
  });

  it('explains what is wrong without sending anything', async () => {
    renderPage();
    const form = await screen.findByRole('form', { name: 'تسجيل هالك جديد' });
    const submit = within(form).getByRole('button', { name: 'سجّل الهالك' });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    const alerts = await within(form).findAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toContain(
      reasonRequiredMessage,
    );
    expect(alerts.length).toBeGreaterThan(1);
    expect(recordWaste).not.toHaveBeenCalled();
  });

  it('records waste, shows the exact differences and reloads the history', async () => {
    vi.mocked(recordWaste).mockResolvedValue(wasteResult());
    renderPage();
    const { submit } = await fillNew('500');
    fireEvent.click(submit);

    const result = await screen.findByRole('status');
    expect(result).toHaveTextContent('اتسجل الهالك');
    expect(within(result).getByText('فرق الهالك')).toBeInTheDocument();
    expect(result).toHaveTextContent('25');
    expect(lastWrite().document).toMatchObject({
      kind: 'record',
      reason: 'spoilage',
      explanation: null,
      lines: [{ itemId: itemA, quantity: '500', unit: 'kg' }],
    });
    expect(loadHistoryPage).toHaveBeenCalledTimes(2);
    expect(hasAction(newWasteSubject)).toBe(false);
    const line = screen.getByRole('group', { name: 'سطر 1' });
    expect(within(line).getByLabelText('الكمية')).toHaveValue('');
  });

  it('keeps one outstanding record while a save is in flight', async () => {
    let release: (value: ReturnType<typeof wasteResult>) => void = () =>
      undefined;
    vi.mocked(recordWaste).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderPage();
    const { submit } = await fillNew();
    fireEvent.click(submit);
    await waitFor(() => expect(submit).toBeDisabled());
    fireEvent.click(submit);
    expect(recordWaste).toHaveBeenCalledTimes(1);
    release(wasteResult());
    await screen.findByRole('status');
  });

  it('holds an unknown save and retries it with the identical request', async () => {
    vi.mocked(recordWaste)
      .mockRejectedValueOnce(new Error('socket'))
      .mockResolvedValueOnce(wasteResult());
    renderPage();
    const { submit } = await fillNew();
    fireEvent.click(submit);

    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(submit).toBeDisabled();
    expect(loadHistoryPage).toHaveBeenCalledTimes(1);
    const first = lastWrite();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await screen.findByRole('status');
    expect(recordWaste).toHaveBeenCalledTimes(2);
    expect(lastWrite()).toBe(first);
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
  });

  it('never settles a saved write by a failed reload', async () => {
    vi.mocked(recordWaste).mockResolvedValue(wasteResult());
    renderPage();
    const { submit } = await fillNew();
    vi.mocked(loadHistoryPage).mockRejectedValue(new Error('offline'));
    fireEvent.click(submit);

    const result = await screen.findByRole('status');
    expect(within(result).getByText(reloadFailedMessage)).toBeInTheDocument();
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
    expect(recordWaste).toHaveBeenCalledTimes(1);
  });

  it('names the items that have no cost and starts the next attempt fresh', async () => {
    vi.mocked(recordWaste)
      .mockRejectedValueOnce(new MissingCostBasisError([itemA]))
      .mockResolvedValueOnce(wasteResult());
    renderPage();
    const { submit } = await fillNew();
    fireEvent.click(submit);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('مفيش تكلفة');
    expect(
      within(alert).getByRole('list', { name: 'أصناف من غير تكلفة' }),
    ).toHaveTextContent('سمك تجريبي أ');
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
    const refused = lastWrite();

    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await screen.findByRole('status');
    expect(lastWrite().requestId).not.toBe(refused.requestId);
  });

  it('says nothing was stored before the discount switch is on', async () => {
    vi.mocked(recordWaste).mockRejectedValue(
      new ConfirmedRefusalError(notActivatedMessage),
    );
    renderPage();
    const { submit } = await fillNew();
    fireEvent.click(submit);
    expect(await screen.findByText(notActivatedMessage)).toBeInTheDocument();
    expect(hasAction(newWasteSubject)).toBe(false);
  });

  it('corrects an entry with its own values and keeps an untouched time', async () => {
    vi.mocked(loadHistoryPage).mockResolvedValue({
      entries: [historyEntry()],
      next: null,
    });
    vi.mocked(recordWaste).mockResolvedValue(
      wasteResult({ kind: 'correction', predecessorId: '7', documentId: '9' }),
    );
    renderPage();
    const entry = await screen.findByRole('article', { name: 'سجل رقم 7' });
    fireEvent.click(within(entry).getByRole('button', { name: 'تصحيح' }));

    const form = within(entry).getByRole('form', {
      name: 'تصحيح السجل رقم 7',
    });
    const line = within(form).getByRole('group', { name: 'سطر 1' });
    expect(within(line).getByLabelText('الكمية')).toHaveValue('500');
    expect(within(line).getByLabelText('الوحدة')).toHaveValue('g');
    fireEvent.change(within(line).getByLabelText('الكمية'), {
      target: { value: '300' },
    });
    const submit = within(form).getByRole('button', { name: 'حفظ التصحيح' });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    const result = await within(entry).findByRole('status');
    expect(result).toHaveTextContent('اتصحّح الهالك');
    expect(lastWrite().document).toEqual({
      kind: 'correction',
      predecessorId: '7',
      occurredAt: '2030-06-01T10:30:15+00:00',
      reason: 'spoilage',
      explanation: null,
      lines: [{ itemId: itemA, quantity: '300', unit: 'g' }],
    });
    expect(within(entry).queryByRole('form')).toBeNull();
  });

  it('voids an entry only after a confirmation', async () => {
    vi.mocked(loadHistoryPage).mockResolvedValue({
      entries: [historyEntry()],
      next: null,
    });
    vi.mocked(recordWaste).mockResolvedValue(
      wasteResult({
        kind: 'void',
        predecessorId: '7',
        occurredAt: null,
        reason: null,
        lines: [],
      }),
    );
    renderPage();
    const entry = await screen.findByRole('article', { name: 'سجل رقم 7' });
    fireEvent.click(within(entry).getByRole('button', { name: 'إلغاء السجل' }));
    expect(recordWaste).not.toHaveBeenCalled();
    fireEvent.click(within(entry).getByRole('button', { name: 'رجوع' }));
    expect(recordWaste).not.toHaveBeenCalled();

    fireEvent.click(within(entry).getByRole('button', { name: 'إلغاء السجل' }));
    fireEvent.click(
      within(entry).getByRole('button', { name: 'تأكيد الإلغاء' }),
    );
    const result = await within(entry).findByRole('status');
    expect(result).toHaveTextContent('اتلغى سجل الهالك');
    expect(lastWrite().document).toEqual({
      kind: 'void',
      predecessorId: '7',
    });
  });

  it('refreshes and explains when the entry was already corrected elsewhere', async () => {
    vi.mocked(loadHistoryPage).mockResolvedValue({
      entries: [historyEntry()],
      next: null,
    });
    vi.mocked(recordWaste).mockRejectedValue(new AlreadyCorrectedError());
    renderPage();
    const entry = await screen.findByRole('article', { name: 'سجل رقم 7' });
    fireEvent.click(within(entry).getByRole('button', { name: 'إلغاء السجل' }));
    fireEvent.click(
      within(entry).getByRole('button', { name: 'تأكيد الإلغاء' }),
    );
    expect(await within(entry).findByRole('alert')).toHaveTextContent(
      alreadyCorrectedMessage,
    );
    expect(hasAction(documentSubject('7'))).toBe(false);
    expect(loadHistoryPage).toHaveBeenCalledTimes(2);
  });

  it('holds an unknown void and offers only the retry for that entry', async () => {
    vi.mocked(loadHistoryPage).mockResolvedValue({
      entries: [historyEntry()],
      next: null,
    });
    vi.mocked(recordWaste)
      .mockRejectedValueOnce(new Error('socket'))
      .mockResolvedValueOnce(wasteResult({ kind: 'void', lines: [] }));
    renderPage();
    const entry = await screen.findByRole('article', { name: 'سجل رقم 7' });
    fireEvent.click(within(entry).getByRole('button', { name: 'إلغاء السجل' }));
    fireEvent.click(
      within(entry).getByRole('button', { name: 'تأكيد الإلغاء' }),
    );
    expect(
      await within(entry).findByText(unknownSaveMessage),
    ).toBeInTheDocument();
    expect(
      within(entry).getByRole('button', { name: 'تأكيد الإلغاء' }),
    ).toBeDisabled();
    const first = lastWrite();

    fireEvent.click(
      within(entry).getByRole('button', { name: 'إعادة المحاولة' }),
    );
    await within(entry).findByRole('status');
    expect(lastWrite()).toBe(first);
  });

  it('offers no change on a corrected or voided entry', async () => {
    vi.mocked(loadHistoryPage).mockResolvedValue({
      entries: [
        historyEntry({ id: '9', kind: 'void', isVoid: true, isCurrent: false }),
        historyEntry({
          id: '8',
          kind: 'correction',
          predecessorId: '7',
          isCurrent: true,
        }),
        historyEntry({ id: '7', isCurrent: false, successorId: '8' }),
      ],
      next: null,
    });
    renderPage();
    const voided = await screen.findByRole('article', { name: 'سجل رقم 9' });
    const old = screen.getByRole('article', { name: 'سجل رقم 7' });
    expect(within(voided).queryByRole('button')).toBeNull();
    expect(within(old).queryByRole('button')).toBeNull();
    expect(old).toHaveTextContent('اتصحّح بالسجل رقم 8');
    expect(
      within(screen.getByRole('article', { name: 'سجل رقم 8' })).getByRole(
        'button',
        { name: 'تصحيح' },
      ),
    ).toBeInTheDocument();
  });
});
