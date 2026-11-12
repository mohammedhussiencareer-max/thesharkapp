import { loadHistoryPage, type HistoryPage } from '@/waste/api';

/** Re-reads the newest `count` entries one keyset page at a time and keeps the cursor to the rest. */
export async function reloadHistory(count: number): Promise<HistoryPage> {
  const entries: HistoryPage['entries'] = [];
  let page = await loadHistoryPage(null);
  entries.push(...page.entries);
  while (page.next !== null && entries.length < count) {
    page = await loadHistoryPage(page.next);
    entries.push(...page.entries);
  }
  if (entries.length <= count) return { entries, next: page.next };
  const kept = entries.slice(0, count);
  const last = kept[kept.length - 1];
  return { entries: kept, next: last ? last.id : page.next };
}
