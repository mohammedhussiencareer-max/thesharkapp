import { describe, expect, it } from 'vitest';
import { createPosFirestore } from './firestore-read.ts';
import type { PosFirestore } from './pos-firestore.ts';
import { createPosReader, type PosSnapshot } from './read-pos.ts';
import { runPosSync } from './sync.ts';
import type { PosDb } from './supabase-write.ts';
import type {
  IngestCounts,
  PosOrderIngest,
  PosShiftIngest,
  SyncScope,
} from './types.ts';

const shift: PosShiftIngest = {
  id: 'shift-test-1',
  opened_at: '2026-10-15T09:00:00.000000Z',
  closed_at: null,
  is_active: true,
  pos_update_time: '2026-10-15T18:00:00.000000Z',
  drawer_cash_net: null,
  drawer_credit: null,
  transactions: [],
};

function order(id: string): PosOrderIngest {
  return {
    id,
    order_number: 1,
    shift_id: 'shift-test-1',
    status: 'complete',
    order_type: null,
    payment_type: null,
    ordered_at: '2026-10-15T12:00:00.000000Z',
    subtotal: '1.00',
    discount: '0.00',
    tax: '0.00',
    service_tax: '0.00',
    delivery_fee: '0.00',
    total: '1.00',
    financial_revision: null,
    last_financial_operation_key: null,
    pos_update_time: '2026-10-15T12:00:00.000000Z',
    content_hash: 'ab'.repeat(32),
    lines: [],
  };
}

function zeroCounts(): IngestCounts {
  return {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    stale: 0,
    missing: 0,
    shifts_upserted: 0,
    shifts_skipped: 0,
    transactions: 0,
  };
}

function snapshot(orders: PosOrderIngest[], scope: SyncScope): PosSnapshot {
  return { shifts: [shift], orders, scope, missingShiftIds: [] };
}

describe('runPosSync', () => {
  it('refuses a hosted database before starting a run', async () => {
    let started = false;
    const db: PosDb = {
      async startRun() {
        started = true;
        return 1;
      },
      async ingest() {
        return zeroCounts();
      },
      async finishRun() {
        return undefined;
      },
    };
    await expect(
      runPosSync({
        mode: 'recent',
        supabaseUrl: 'https://abc.supabase.co',
        serviceRoleKey: 'local-test-key',
        reader: {
          async read() {
            return snapshot([], { shift_ids: [] });
          },
        },
        db,
      }),
    ).rejects.toThrow(/Refusing non-local/);
    expect(started).toBe(false);
  });

  it('sends the scope only on the last chunk', async () => {
    const orders = Array.from({ length: 201 }, (_, index) =>
      order(`order-${String(index).padStart(3, '0')}`),
    );
    const ingestCalls: Array<{
      shifts: number;
      orders: number;
      scope: SyncScope | null;
    }> = [];
    let finished: { status: string; counts: unknown } | undefined;
    const db: PosDb = {
      async startRun() {
        return 9;
      },
      async ingest(_runId, shifts, batch, scope) {
        ingestCalls.push({
          shifts: shifts.length,
          orders: batch.length,
          scope,
        });
        return { ...zeroCounts(), inserted: batch.length };
      },
      async finishRun(_runId, status, counts) {
        finished = { status, counts };
      },
    };
    const logs: string[] = [];
    const result = await runPosSync({
      mode: 'recent',
      supabaseUrl: 'http://127.0.0.1:55421',
      serviceRoleKey: 'local-test-key',
      reader: {
        async read() {
          return snapshot(orders, { shift_ids: ['shift-test-1'] });
        },
      },
      db,
      logger: (line) => logs.push(line),
    });
    expect(ingestCalls).toEqual([
      { shifts: 1, orders: 200, scope: null },
      { shifts: 0, orders: 1, scope: { shift_ids: ['shift-test-1'] } },
    ]);
    expect(finished?.status).toBe('ok');
    expect(result.counts).toMatchObject({
      read: 201,
      inserted: 201,
      missing: 0,
    });
    expect(logs.join('\n')).toContain('shift_ids=shift-test-1');
    expect(logs.join('\n')).not.toContain('content_hash');
  });

  it('fails the run without a scope when the read throws', async () => {
    const ingestCalls: unknown[] = [];
    let finished: { status: string; error: string | null } | undefined;
    const db: PosDb = {
      async startRun() {
        return 3;
      },
      async ingest() {
        ingestCalls.push(true);
        return zeroCounts();
      },
      async finishRun(_runId, status, _counts, error) {
        finished = { status, error };
      },
    };
    await expect(
      runPosSync({
        mode: 'full',
        supabaseUrl: 'http://127.0.0.1:55421',
        serviceRoleKey: 'local-test-key',
        reader: {
          async read() {
            throw new Error('boom ya29.SECRET-TOKEN');
          },
        },
        db,
      }),
    ).rejects.toThrow(/^boom \[redacted\]$/);
    expect(ingestCalls).toEqual([]);
    expect(finished).toEqual({ status: 'failed', error: 'boom [redacted]' });
  });

  it.each([
    { label: '[{}]', payload: [{}] },
    { label: '[{"readTime":7}]', payload: [{ readTime: 7 }] },
    { label: '[]', payload: [] },
    {
      label: 'an unknown key',
      payload: [{ readTime: '2026-10-16T00:00:00Z', extra: 1 }],
    },
    {
      label: 'skippedResults 1',
      payload: [{ readTime: '2026-10-16T00:00:00Z', skippedResults: 1 }],
    },
  ])(
    'fails the run and does not send a scope for $label',
    async ({ payload }) => {
      const ingestCalls: unknown[] = [];
      let finished: { status: string; error: string | null } | undefined;
      const db: PosDb = {
        async startRun() {
          return 42;
        },
        async ingest() {
          ingestCalls.push(true);
          return zeroCounts();
        },
        async finishRun(_runId, status, _counts, error) {
          finished = { status, error };
        },
      };
      const firestore = createPosFirestore('test-token', async (_url, init) => {
        if (init.method === 'POST') {
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            documents: [
              {
                name: 'projects/thesharkrestaurant/databases/(default)/documents/custody_shifts/shift-test-1',
                updateTime: '2026-10-15T18:00:00Z',
                fields: {
                  id: { stringValue: 'shift-test-1' },
                  opening_time: { timestampValue: '2026-10-15T09:00:00Z' },
                  isActive: { booleanValue: true },
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      });
      await expect(
        runPosSync({
          mode: 'recent',
          supabaseUrl: 'http://127.0.0.1:55421',
          serviceRoleKey: 'local-test-key',
          reader: createPosReader(firestore),
          db,
        }),
      ).rejects.toThrow(/^Firestore read failed: invalid response$/);
      expect(ingestCalls).toEqual([]);
      expect(finished).toEqual({
        status: 'failed',
        error: 'Firestore read failed: invalid response',
      });
    },
  );

  it('fails a full run without a scope when a list page has an unknown key', async () => {
    const ingestCalls: unknown[] = [];
    let finished: { status: string; error: string | null } | undefined;
    const db: PosDb = {
      async startRun() {
        return 43;
      },
      async ingest(_runId, _shifts, _batch, scope) {
        ingestCalls.push(scope);
        return zeroCounts();
      },
      async finishRun(_runId, status, _counts, error) {
        finished = { status, error };
      },
    };
    const firestore = createPosFirestore('test-token', async () => {
      return new Response(JSON.stringify({ message: 'failed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    await expect(
      runPosSync({
        mode: 'full',
        supabaseUrl: 'http://127.0.0.1:55421',
        serviceRoleKey: 'local-test-key',
        reader: createPosReader(firestore),
        db,
      }),
    ).rejects.toThrow(/^Firestore read failed: invalid response$/);
    expect(ingestCalls).toEqual([]);
    expect(finished).toEqual({
      status: 'failed',
      error: 'Firestore read failed: invalid response',
    });
  });

  it('fails the run and does not send a scope when a list document is null', async () => {
    const ingestCalls: unknown[] = [];
    let finished: { status: string; error: string | null } | undefined;
    const db: PosDb = {
      async startRun() {
        return 41;
      },
      async ingest() {
        ingestCalls.push(true);
        return zeroCounts();
      },
      async finishRun(_runId, status, _counts, error) {
        finished = { status, error };
      },
    };
    const firestore = createPosFirestore('test-token', async () => {
      return new Response(JSON.stringify({ documents: [null] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    await expect(
      runPosSync({
        mode: 'recent',
        supabaseUrl: 'http://127.0.0.1:55421',
        serviceRoleKey: 'local-test-key',
        reader: createPosReader(firestore),
        db,
      }),
    ).rejects.toThrow(/^Firestore read failed: invalid response$/);
    expect(ingestCalls).toEqual([]);
    expect(finished).toEqual({
      status: 'failed',
      error: 'Firestore read failed: invalid response',
    });
  });

  it('does not finish a run that never started', async () => {
    let finished = false;
    const db: PosDb = {
      async startRun() {
        throw new Error('start failed');
      },
      async ingest() {
        return zeroCounts();
      },
      async finishRun() {
        finished = true;
      },
    };
    await expect(
      runPosSync({
        mode: 'recent',
        supabaseUrl: 'http://127.0.0.1:55421',
        serviceRoleKey: 'local-test-key',
        reader: {
          async read() {
            return snapshot([], { all: true });
          },
        },
        db,
      }),
    ).rejects.toThrow(/start failed/);
    expect(finished).toBe(false);
  });

  it('puts shift transactions on the ingest payload and only logs counts', async () => {
    const sentinel = 'pii-tx-description 01000000000';
    const ingestShifts: PosShiftIngest[] = [];
    const logs: string[] = [];
    const db: PosDb = {
      async startRun() {
        return 7;
      },
      async ingest(_runId, shifts) {
        ingestShifts.push(...shifts);
        return { ...zeroCounts(), transactions: 1, shifts_upserted: 1 };
      },
      async finishRun() {
        return undefined;
      },
    };
    const doc = 'projects/thesharkrestaurant/databases/(default)/documents';
    const firestore = createPosFirestore('test-token', async (url, init) => {
      if (init.method === 'POST') {
        return new Response(
          JSON.stringify([{ readTime: '2026-10-16T00:00:00Z' }]),
          { status: 200 },
        );
      }
      if (url.includes('/transactions')) {
        return new Response(
          JSON.stringify({
            documents: [
              {
                name: `${doc}/custody_shifts/shift-test-1/transactions/tx-test-1`,
                fields: {
                  type: { integerValue: '3' },
                  amount: { integerValue: '15' },
                  orderId: { stringValue: 'order-test-1' },
                  timestamp: { timestampValue: '2026-10-15T15:00:00Z' },
                  description: { stringValue: sentinel },
                  operationKey: { stringValue: 'op-should-drop' },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          documents: [
            {
              name: `${doc}/custody_shifts/shift-test-1`,
              updateTime: '2026-10-15T18:00:00Z',
              fields: {
                id: { stringValue: 'shift-test-1' },
                opening_time: { timestampValue: '2026-10-15T09:00:00Z' },
                isActive: { booleanValue: false },
                cash_payments_net: { doubleValue: 10.5 },
                credit_payments: { integerValue: '4' },
                difference: { doubleValue: -1 },
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    await runPosSync({
      mode: 'recent',
      supabaseUrl: 'http://127.0.0.1:55421',
      serviceRoleKey: 'local-test-key',
      reader: createPosReader(firestore),
      db,
      logger: (line) => logs.push(line),
    });
    expect(ingestShifts).toHaveLength(1);
    expect(ingestShifts[0]?.transactions).toEqual([
      {
        tx_id: 'tx-test-1',
        order_id: 'order-test-1',
        tx_type: 3,
        amount: '15.00',
        occurred_at: '2026-10-15T15:00:00.000000Z',
      },
    ]);
    expect(ingestShifts[0]?.drawer_cash_net).toBe('10.50');
    expect(ingestShifts[0]?.drawer_credit).toBe('4.00');
    const packed = `${JSON.stringify(ingestShifts)}\n${logs.join('\n')}`;
    expect(packed).not.toContain(sentinel);
    expect(packed).not.toContain('op-should-drop');
    expect(packed).not.toContain('difference');
    expect(logs.join('\n')).toContain('transactions=1');
    expect(logs.join('\n')).toContain('shifts=1');
  });

  it('sends no scope when a transaction page is invalid', async () => {
    const ingestCalls: unknown[] = [];
    let finished: { status: string; error: string | null } | undefined;
    const db: PosDb = {
      async startRun() {
        return 8;
      },
      async ingest(_runId, _shifts, _orders, scope) {
        ingestCalls.push(scope);
        return zeroCounts();
      },
      async finishRun(_runId, status, _counts, error) {
        finished = { status, error };
      },
    };
    const firestore = createPosFirestore('test-token', async (url, init) => {
      if (url.includes('/transactions')) {
        return new Response(JSON.stringify({ message: 'pii-tx-description' }), {
          status: 200,
        });
      }
      if (init.method === 'POST') {
        return new Response(
          JSON.stringify([{ readTime: '2026-10-16T00:00:00Z' }]),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          documents: [
            {
              name: 'projects/thesharkrestaurant/databases/(default)/documents/custody_shifts/shift-test-1',
              updateTime: '2026-10-15T18:00:00Z',
              fields: {
                opening_time: { timestampValue: '2026-10-15T09:00:00Z' },
                isActive: { booleanValue: true },
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    await expect(
      runPosSync({
        mode: 'recent',
        supabaseUrl: 'http://127.0.0.1:55421',
        serviceRoleKey: 'local-test-key',
        reader: createPosReader(firestore),
        db,
      }),
    ).rejects.toThrow(/^Firestore read failed: invalid response$/);
    expect(ingestCalls).toEqual([]);
    expect(finished).toEqual({
      status: 'failed',
      error: 'Firestore read failed: invalid response',
    });
  });

  it('sends no scope when a window35 backfill read fails', async () => {
    const ingestCalls: unknown[] = [];
    let finished: { status: string; error: string | null } | undefined;
    const db: PosDb = {
      async startRun() {
        return 11;
      },
      async ingest(_runId, _shifts, _orders, scope) {
        ingestCalls.push(scope);
        return zeroCounts();
      },
      async finishRun(_runId, status, _counts, error) {
        finished = { status, error };
      },
    };
    const doc = 'projects/thesharkrestaurant/databases/(default)/documents';
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        throw new Error('list should not be called');
      },
      async getShift() {
        return {
          name: `${doc}/custody_shifts/shift-early`,
          updateTime: '2026-10-15T18:00:00Z',
          fields: {
            opening_time: { timestampValue: '2026-09-10T08:01:00Z' },
            isActive: { booleanValue: false },
          },
        };
      },
      async queryOrders(body) {
        const text = JSON.stringify(body);
        if (text.includes('"IN"')) {
          throw new Error('Firestore read failed: invalid response');
        }
        if ((text.match(/timestampValue/g) ?? []).length < 2) return [];
        return [
          {
            name: `${doc}/orders/order-inside`,
            updateTime: '2026-10-15T13:00:00Z',
            fields: {
              status: { stringValue: 'complete' },
              shiftId: { stringValue: 'shift-early' },
              timestamp: { timestampValue: '2026-10-15T12:00:00Z' },
              subtotalAmount: { integerValue: '1' },
              discountAmount: { integerValue: '0' },
              taxTotalAmount: { integerValue: '0' },
              serviceTaxAmount: { integerValue: '0' },
              totalAmount: { integerValue: '1' },
            },
          },
        ];
      },
    };
    await expect(
      runPosSync({
        mode: 'window35',
        supabaseUrl: 'http://127.0.0.1:55421',
        serviceRoleKey: 'local-test-key',
        reader: createPosReader(firestore),
        db,
        now: new Date('2026-10-16T00:00:00.000Z'),
      }),
    ).rejects.toThrow(/^Firestore read failed: invalid response$/);
    expect(ingestCalls).toEqual([]);
    expect(finished).toEqual({
      status: 'failed',
      error: 'Firestore read failed: invalid response',
    });
  });
});
