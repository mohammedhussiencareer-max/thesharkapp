import type { StockChoice } from '@/purchases/types';
import type { HistoryEntry, HistoryLine, WasteResult } from '@/waste/types';

export const itemA = '11111111-1111-4111-8111-111111111111';
export const itemB = '22222222-2222-4222-8222-222222222222';

export function stockChoice(overrides: Partial<StockChoice> = {}): StockChoice {
  return {
    id: itemA,
    name: 'سمك تجريبي أ',
    kind: 'ingredient',
    baseUnit: 'kg',
    parentItemId: null,
    active: true,
    hasMovements: true,
    conversions: [{ unit: 'g', factorToBase: '0.001' }],
    ...overrides,
  };
}

export function rawLine(overrides: Record<string, unknown> = {}) {
  return {
    line_no: 1,
    item_id: itemA,
    name: 'سمك تجريبي أ',
    input_quantity: '500',
    input_unit: 'g',
    factor: '0.001',
    factor_source: 'metric',
    conversion_version_id: null,
    base_unit: 'kg',
    base_quantity: '0.5',
    value: '25',
    ...overrides,
  };
}

export function rawEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    request_id: 'a1900000-0000-4000-8000-000000000001',
    occurred_at: '2030-06-01T10:30:15+00:00',
    reason_code: 'spoilage',
    explanation: null,
    predecessor_id: null,
    successor_id: null,
    kind: 'record',
    is_void: false,
    is_current: true,
    created_at: '2030-06-01T10:31:00+00:00',
    value: '25',
    lines: [rawLine()],
    ...overrides,
  };
}

export function historyLine(overrides: Partial<HistoryLine> = {}): HistoryLine {
  return {
    lineNo: 1,
    itemId: itemA,
    name: 'سمك تجريبي أ',
    inputQuantity: '500',
    inputUnit: 'g',
    factor: '0.001',
    factorSource: 'metric',
    conversionVersionId: null,
    baseUnit: 'kg',
    baseQuantity: '0.5',
    value: '25',
    ...overrides,
  };
}

export function historyEntry(
  overrides: Partial<HistoryEntry> = {},
): HistoryEntry {
  return {
    id: '7',
    requestId: 'a1900000-0000-4000-8000-000000000001',
    occurredAt: '2030-06-01T10:30:15+00:00',
    reason: 'spoilage',
    explanation: null,
    predecessorId: null,
    successorId: null,
    kind: 'record',
    isVoid: false,
    isCurrent: true,
    createdAt: '2030-06-01T10:31:00+00:00',
    value: '25',
    lines: [historyLine()],
    ...overrides,
  };
}

export const rawDifferences = {
  stock_quantity: '-0.5',
  stock_value: '-25',
  cogs: '0',
  waste: '25',
  profit: '-25',
};

export function rawResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    document_id: 8,
    predecessor_id: null,
    kind: 'record',
    occurred_at: '2030-06-01T10:30:15+00:00',
    reason_code: 'spoilage',
    lines: [
      {
        line_no: 1,
        item_id: itemA,
        input_quantity: '500',
        input_unit: 'g',
        factor: '0.001',
        factor_source: 'metric',
        base_unit: 'kg',
        base_quantity: '0.5',
      },
    ],
    differences: rawDifferences,
    ...overrides,
  };
}

export function wasteResult(overrides: Partial<WasteResult> = {}): WasteResult {
  return {
    documentId: '8',
    predecessorId: null,
    kind: 'record',
    occurredAt: '2030-06-01T10:30:15+00:00',
    reason: 'spoilage',
    lines: [
      {
        lineNo: 1,
        itemId: itemA,
        inputQuantity: '500',
        inputUnit: 'g',
        factor: '0.001',
        factorSource: 'metric',
        baseUnit: 'kg',
        baseQuantity: '0.5',
      },
    ],
    differences: {
      stockQuantity: '-0.5',
      stockValue: '-25',
      cogs: '0',
      waste: '25',
      profit: '-25',
    },
    ...overrides,
  };
}
