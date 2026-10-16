import { describe, expect, it } from 'vitest';
import { createPosFirestore } from './firestore-read.ts';
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
});
