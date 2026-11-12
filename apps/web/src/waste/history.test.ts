import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHistoryPage } from '@/waste/api';
import { reloadHistory } from '@/waste/history';
import { historyEntry } from '@/waste/test-fixtures';

vi.mock('@/waste/api', () => ({ loadHistoryPage: vi.fn() }));

function page(ids: number[], next: number | null) {
  return {
    entries: ids.map((id) => historyEntry({ id: String(id) })),
    next: next === null ? null : String(next),
  };
}

describe('reloadHistory', () => {
  beforeEach(() => {
    vi.mocked(loadHistoryPage).mockReset();
  });

  it('walks the keyset pages until the wanted count is on screen', async () => {
    vi.mocked(loadHistoryPage)
      .mockResolvedValueOnce(page([9, 8], 8))
      .mockResolvedValueOnce(page([7, 6], 6))
      .mockResolvedValueOnce(page([5, 4], 4));
    const result = await reloadHistory(4);
    expect(vi.mocked(loadHistoryPage).mock.calls).toEqual([[null], ['8']]);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      '9',
      '8',
      '7',
      '6',
    ]);
    expect(result.next).toBe('6');
  });

  it('reads one more page when the count falls inside it, then trims', async () => {
    vi.mocked(loadHistoryPage)
      .mockResolvedValueOnce(page([9, 8], 8))
      .mockResolvedValueOnce(page([7, 6], 6))
      .mockResolvedValueOnce(page([5, 4], 4));
    const result = await reloadHistory(5);
    expect(vi.mocked(loadHistoryPage).mock.calls).toEqual([
      [null],
      ['8'],
      ['6'],
    ]);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      '9',
      '8',
      '7',
      '6',
      '5',
    ]);
    expect(result.next).toBe('5');
  });

  it('stops at the end of the history and has no cursor left', async () => {
    vi.mocked(loadHistoryPage)
      .mockResolvedValueOnce(page([3, 2], 2))
      .mockResolvedValueOnce(page([1], null));
    const result = await reloadHistory(50);
    expect(loadHistoryPage).toHaveBeenCalledTimes(2);
    expect(result.entries.map((entry) => entry.id)).toEqual(['3', '2', '1']);
    expect(result.next).toBeNull();
  });

  it('keeps the cursor at the last kept entry when a page overshoots', async () => {
    vi.mocked(loadHistoryPage).mockResolvedValueOnce(page([9, 8, 7], 7));
    const result = await reloadHistory(2);
    expect(result.entries.map((entry) => entry.id)).toEqual(['9', '8']);
    expect(result.next).toBe('8');
  });

  it('asks for the default page size only, never one oversized request', async () => {
    vi.mocked(loadHistoryPage)
      .mockResolvedValueOnce(page([4], 4))
      .mockResolvedValueOnce(page([3], 3))
      .mockResolvedValueOnce(page([2], null));
    await reloadHistory(1001);
    for (const call of vi.mocked(loadHistoryPage).mock.calls) {
      expect(call).toHaveLength(1);
    }
  });

  it('fails as a whole when a page cannot be read', async () => {
    vi.mocked(loadHistoryPage)
      .mockResolvedValueOnce(page([9], 9))
      .mockRejectedValueOnce(new Error('offline'));
    await expect(reloadHistory(5)).rejects.toThrow('offline');
  });
});
