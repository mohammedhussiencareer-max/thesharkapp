import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmedRefusalError, genericCatalogError } from '@/items/errors';
import {
  documentJson,
  entryOf,
  historyColumns,
  historyPageSize,
  loadHistoryPage,
  maxHistoryPageSize,
  recordWaste,
  resultOf,
} from '@/waste/api';
import {
  AlreadyCorrectedError,
  alreadyCorrectedServerMessage,
  MissingCostBasisError,
  notActivatedMessage,
  notActivatedServerMessage,
} from '@/waste/errors';
import {
  itemA,
  itemB,
  rawEntry,
  rawResult,
  wasteResult,
} from '@/waste/test-fixtures';
import type { WasteWrite } from '@/waste/types';

const mocks = vi.hoisted(() => ({ schema: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  supabase: { schema: mocks.schema },
}));

function query(result: { data: unknown; error: unknown }) {
  const captured: {
    table?: string;
    select?: string;
    filters: { op: string; column: string; value: unknown }[];
    orders: { column: string; ascending?: boolean }[];
    limits: number[];
  } = { filters: [], orders: [], limits: [] };
  const chain: Record<string, unknown> = {};
  chain.select = (columns: string) => {
    captured.select = columns;
    return chain;
  };
  chain.order = (column: string, options?: { ascending?: boolean }) => {
    captured.orders.push({ column, ascending: options?.ascending });
    return chain;
  };
  chain.lt = (column: string, value: unknown) => {
    captured.filters.push({ op: 'lt', column, value });
    return chain;
  };
  chain.limit = (count: number) => {
    captured.limits.push(count);
    return chain;
  };
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  const from = vi.fn((table: string) => {
    captured.table = table;
    return chain;
  });
  mocks.schema.mockReturnValue({ from });
  return captured;
}

const record: WasteWrite = {
  requestId: 'a1900000-0000-4000-8000-000000000002',
  document: {
    kind: 'record',
    occurredAt: '2030-06-01T10:30:00+00:00',
    reason: 'other',
    explanation: 'اتكسر',
    lines: [{ itemId: itemA, quantity: '0.5', unit: 'kg' }],
  },
};

function rpcFailing(error: Record<string, unknown>) {
  const rpc = vi.fn().mockResolvedValue({ data: null, error });
  mocks.schema.mockReturnValue({ rpc });
  return rpc;
}

describe('waste api', () => {
  beforeEach(() => {
    mocks.schema.mockReset();
  });

  describe('entryOf', () => {
    it('keeps ids as decimal text and money as the exact text sent', () => {
      const entry = entryOf(
        rawEntry({ id: 12, predecessor_id: 5, value: '25.50' }),
      );
      expect(entry.id).toBe('12');
      expect(entry.predecessorId).toBe('5');
      expect(entry.successorId).toBeNull();
      expect(entry.value).toBe('25.50');
      expect(entry.lines[0]).toMatchObject({
        inputQuantity: '500',
        inputUnit: 'g',
        factor: '0.001',
        factorSource: 'metric',
        baseQuantity: '0.5',
        value: '25',
      });
    });

    it('accepts a void with no lines', () => {
      const entry = entryOf(
        rawEntry({ kind: 'void', is_void: true, is_current: false, lines: [] }),
      );
      expect(entry.isVoid).toBe(true);
      expect(entry.lines).toEqual([]);
    });

    it('accepts the system-only reason when it is stored', () => {
      expect(
        entryOf(rawEntry({ reason_code: 'cancel_after_preparation' })).reason,
      ).toBe('cancel_after_preparation');
    });

    it('refuses a JSON number for money or quantities', () => {
      expect(() => entryOf(rawEntry({ value: 25 }))).toThrow(
        genericCatalogError,
      );
      expect(() =>
        entryOf(
          rawEntry({ lines: [{ ...rawEntry().lines[0], base_quantity: 0.5 }] }),
        ),
      ).toThrow(genericCatalogError);
    });

    it('refuses values outside the known sets and unsafe ids', () => {
      expect(() => entryOf(rawEntry({ reason_code: 'theft' }))).toThrow(
        genericCatalogError,
      );
      expect(() => entryOf(rawEntry({ kind: 'delete' }))).toThrow(
        genericCatalogError,
      );
      expect(() => entryOf(rawEntry({ is_current: 'yes' }))).toThrow(
        genericCatalogError,
      );
      expect(() => entryOf(rawEntry({ id: 2 ** 53 }))).toThrow(
        genericCatalogError,
      );
      expect(() => entryOf(rawEntry({ id: 0 }))).toThrow(genericCatalogError);
      expect(() => entryOf(null)).toThrow(genericCatalogError);
    });
  });

  describe('loadHistoryPage', () => {
    it('pages newest first by the last id seen', async () => {
      const captured = query({ data: [rawEntry({ id: 7 })], error: null });
      const page = await loadHistoryPage('9');
      expect(captured.table).toBe('waste_history');
      expect(captured.select).toBe(historyColumns);
      expect(captured.filters).toEqual([{ op: 'lt', column: 'id', value: 9 }]);
      expect(captured.orders).toEqual([{ column: 'id', ascending: false }]);
      expect(captured.limits).toEqual([historyPageSize]);
      expect(page.next).toBeNull();
      expect(page.entries.map((entry) => entry.id)).toEqual(['7']);
    });

    it('starts without a filter and returns the last id of a full page', async () => {
      const captured = query({
        data: [rawEntry({ id: 8 }), rawEntry({ id: 7 })],
        error: null,
      });
      const page = await loadHistoryPage(null, 2);
      expect(captured.filters).toEqual([]);
      expect(captured.limits).toEqual([2]);
      expect(page.next).toBe('7');
    });

    it('never asks for more than the page cap, so a full page is not the API row cap', async () => {
      const captured = query({ data: [], error: null });
      await loadHistoryPage(null, 5000);
      await loadHistoryPage(null, 0);
      expect(captured.limits).toEqual([maxHistoryPageSize, 1]);
      expect(maxHistoryPageSize).toBeLessThan(1000);
    });

    it('fails with the generic message and no raw server text', async () => {
      query({ data: null, error: { code: 'XX000', message: 'raw detail' } });
      await expect(loadHistoryPage(null)).rejects.toThrow(genericCatalogError);
    });
  });

  describe('resultOf', () => {
    it('reads the saved conversion and the differences as text', () => {
      expect(resultOf(rawResult())).toEqual(wasteResult());
    });

    it('reads a void: no time, no reason, no lines', () => {
      const result = resultOf(
        rawResult({
          kind: 'void',
          predecessor_id: 8,
          occurred_at: null,
          reason_code: null,
          lines: [],
        }),
      );
      expect(result).toMatchObject({
        kind: 'void',
        predecessorId: '8',
        occurredAt: null,
        reason: null,
        lines: [],
      });
    });

    it('refuses a status other than ok and numbers for money', () => {
      expect(() => resultOf(rawResult({ status: 'not_activated' }))).toThrow(
        genericCatalogError,
      );
      expect(() =>
        resultOf(
          rawResult({ differences: { ...rawResult().differences, waste: 25 } }),
        ),
      ).toThrow(genericCatalogError);
    });
  });

  describe('documentJson', () => {
    it('sends a record without a predecessor', () => {
      expect(documentJson(record.document)).toEqual({
        occurred_at: '2030-06-01T10:30:00+00:00',
        reason_code: 'other',
        explanation: 'اتكسر',
        lines: [{ item_id: itemA, quantity: '0.5', unit: 'kg' }],
      });
    });

    it('sends a correction with the predecessor as decimal text', () => {
      expect(
        documentJson({
          kind: 'correction',
          predecessorId: '7',
          occurredAt: '2030-06-01T10:30:00+00:00',
          reason: 'spoilage',
          explanation: null,
          lines: [{ itemId: itemB, quantity: '1', unit: 'kg' }],
        }),
      ).toEqual({
        predecessor_id: '7',
        occurred_at: '2030-06-01T10:30:00+00:00',
        reason_code: 'spoilage',
        explanation: null,
        lines: [{ item_id: itemB, quantity: '1', unit: 'kg' }],
      });
    });

    it('sends a void as a predecessor and no lines only', () => {
      expect(documentJson({ kind: 'void', predecessorId: '7' })).toEqual({
        predecessor_id: '7',
        lines: [],
      });
    });
  });

  describe('recordWaste', () => {
    it('sends the request id and the document', async () => {
      const rpc = vi.fn().mockResolvedValue({ data: rawResult(), error: null });
      mocks.schema.mockReturnValue({ rpc });
      const result = await recordWaste(record);
      expect(mocks.schema).toHaveBeenCalledWith('app');
      expect(rpc).toHaveBeenCalledWith('record_waste', {
        p_request_id: record.requestId,
        p_document: documentJson(record.document),
      });
      expect(result.documentId).toBe('8');
    });

    it('turns the already-corrected refusal into a known stale write', async () => {
      rpcFailing({ code: '40001', message: alreadyCorrectedServerMessage });
      await expect(recordWaste(record)).rejects.toBeInstanceOf(
        AlreadyCorrectedError,
      );
    });

    it('names the items that have no cost', async () => {
      rpcFailing({
        code: 'P0001',
        message: 'cost basis missing',
        details: 'missing_cost_basis',
        hint: `${itemA},${itemB}`,
      });
      const failure = await recordWaste(record).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(MissingCostBasisError);
      expect((failure as MissingCostBasisError).itemIds).toEqual([
        itemA,
        itemB,
      ]);
    });

    it('treats the pre-activation refusal as definite', async () => {
      rpcFailing({ code: '55000', message: notActivatedServerMessage });
      const failure = await recordWaste(record).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ConfirmedRefusalError);
      expect((failure as Error).message).toBe(notActivatedMessage);
    });

    it('treats a domain refusal as a payload refusal with Arabic text', async () => {
      rpcFailing({
        code: '22023',
        message: 'an explanation is required for the reason other',
      });
      const failure = await recordWaste(record).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ConfirmedRefusalError);
      expect((failure as Error).message).toContain('شرح');
    });

    it('leaves a running sync unknown: a plain error with no code', async () => {
      rpcFailing({
        code: '55P03',
        message: 'could not obtain lock',
        hint: 'a POS sync is running',
      });
      const failure = await recordWaste(record).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ConfirmedRefusalError);
      expect((failure as { code?: string }).code).toBeUndefined();
      expect((failure as Error).message).toContain('مزامنة');
    });

    it('keeps the code of a definite non-payload refusal', async () => {
      rpcFailing({ code: '42501', message: 'owner only' });
      const failure = await recordWaste(record).catch(
        (error: unknown) => error,
      );
      expect((failure as { code?: string }).code).toBe('42501');
    });
  });
});
