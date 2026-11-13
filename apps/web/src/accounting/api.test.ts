import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountingRunOf,
  countDerivationOf,
  loadOpeningReview,
  loadProcessingSummary,
  loadShiftStatuses,
  nextWorkOf,
  orderCostOf,
  retryParkedOrder,
  retryResultOf,
  runDeductions,
  shiftStatusOf,
  summaryOf,
} from '@/accounting/api';
import { ownerReadMessage } from '@/accounting/errors';
import { genericCatalogError } from '@/items/errors';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  supabase: { schema: () => ({ rpc: mocks.rpc }) },
}));

const itemA = 'a7800000-0000-4000-8000-0000000000a1';
const itemB = 'a7800000-0000-4000-8000-0000000000a2';
const countId = 'a7800000-0000-4000-8000-000000000030';

const zeroDifference = {
  net_sales_difference: '0.00',
  cogs_difference: '0.00',
  waste_difference: '0.00',
  count_difference: '0.00',
  profit_difference: '0.00',
};

function ok(data: unknown) {
  return { data, error: null };
}

function emptyRun(status: string) {
  return {
    status,
    processed: 0,
    applied: 0,
    unchanged: 0,
    incomplete: 0,
    none: 0,
    blocked: 0,
    disposition_pending: 0,
    failed: 0,
    remaining: 0,
    head: null,
    critical: null,
  };
}

describe('accounting mappers', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
  });

  it('rejects a reason outside the allow-list', () => {
    expect(() =>
      summaryOf({
        activated: false,
        pending_count: '0',
        blocked_count: '0',
        failed_count: '1',
        processed_event_count: '0',
        open_event_count: '0',
        open_span_count: '0',
        coverage: null,
        parked: [
          {
            order_id: 'order-1',
            attempts: '5',
            work_generation: '1',
            failed_at: '2026-02-01T00:00:00.000Z',
            sqlstate: '57014',
            reason: 'RAWLEAK',
          },
        ],
        parked_count: '1',
        parked_truncated: false,
      }),
    ).toThrow(genericCatalogError);
  });

  it('keeps an allow-listed reason and drops nothing into a number', () => {
    const summary = summaryOf({
      activated: false,
      pending_count: '2',
      blocked_count: '1',
      failed_count: '2',
      processed_event_count: '1',
      open_event_count: '3',
      open_span_count: '0',
      coverage: null,
      parked: [
        {
          order_id: 'o-fail',
          attempts: '5',
          work_generation: '1',
          failed_at: '2026-02-01T00:00:00.000Z',
          sqlstate: '57014',
          reason: 'escaped',
        },
      ],
      parked_count: '1',
      parked_truncated: false,
    });
    expect(summary.pendingCount).toBe('2');
    expect(summary.parked[0]?.reason).toBe('escaped');
    expect(summary.parked[0]?.sqlstate).toBe('57014');
  });

  it('ignores junk on an unknown order and rejects a numeric quantity', () => {
    const missing = orderCostOf({
      found: false,
      order_id: 'o-missing',
      order_number: '9001',
      applications: [{ secret: 'SECRETPATH' }],
    });
    expect(missing).toEqual({
      found: false,
      orderId: 'o-missing',
      orderNumber: null,
      input: null,
      state: null,
      applications: [],
    });
    expect(JSON.stringify(missing)).not.toContain('SECRETPATH');
    expect(() =>
      orderCostOf({
        found: true,
        order_id: 'o-cost',
        order_number: null,
        input: null,
        state: null,
        applications: [
          {
            id: '1',
            receipt_kind: 'posting',
            disposition: 'sale',
            cost_input_id: '1',
            input_revision: '1',
            snapshot_id: '1',
            snapshot_version: '3',
            predecessor_id: null,
            retired_application_id: null,
            movement_owner_id: null,
            occurred_at: null,
            shift_id: null,
            algorithm_version: '1',
            signature: 'abc',
            created_at: '2026-02-01T00:00:00.000Z',
            lines: [
              {
                item_id: itemA,
                name: 'سمك',
                base_unit: 'kg',
                quantity: 4.5,
              },
            ],
            posted: [],
            provenance: {
              mapping_versions: [],
              recipe_versions: [],
              packaging_versions: [],
              loss_versions: [],
              conversion_versions: [],
              algorithm_version: '1',
            },
            reversals: [],
            adjustments: [],
          },
        ],
      }),
    ).toThrow(genericCatalogError);
  });

  it('keeps decimal text and drops provenance paths', () => {
    const detail = orderCostOf({
      found: true,
      order_id: 'o-cost',
      order_number: '9001',
      input: null,
      state: {
        disposition: 'sale',
        latest_application_id: '9',
        owner_application_id: '9',
        causes: ['missing_cost_basis'],
      },
      applications: [
        {
          id: '9',
          receipt_kind: 'posting',
          disposition: 'sale',
          cost_input_id: '4',
          input_revision: '2',
          snapshot_id: '3',
          snapshot_version: '3',
          predecessor_id: null,
          retired_application_id: null,
          movement_owner_id: '9',
          occurred_at: '2026-02-01T00:00:00.000Z',
          shift_id: 'shift-read',
          algorithm_version: '1',
          signature: 'abc',
          created_at: '2026-02-01T00:00:00.000Z',
          lines: [
            {
              item_id: itemA,
              name: 'سمك',
              base_unit: 'kg',
              quantity: '4.5',
            },
          ],
          posted: [],
          provenance: {
            mapping_versions: [],
            recipe_versions: [],
            packaging_versions: [],
            loss_versions: [
              { item_id: itemA, version_id: itemB, loss_pct: '0.1' },
            ],
            conversion_versions: [],
            algorithm_version: '1',
            paths: 'SECRETPATH',
          },
          reversals: [
            {
              movement_id: '3',
              item_id: itemA,
              name: 'سمك',
              movement_type: 'sale_reversal',
              quantity: '2.5',
              total_cost: '27.75',
              reverses_movement_id: '1',
            },
          ],
          adjustments: [
            {
              movement_id: '2',
              item_id: itemA,
              name: 'سمك',
              quantity: '0',
              total_cost: '-1.5',
              adjusts_movement_id: '1',
            },
          ],
        },
      ],
    });
    expect(detail.applications[0]?.lines[0]?.quantity).toBe('4.5');
    expect(detail.applications[0]?.reversals[0]?.totalCost).toBe('27.75');
    expect(detail.applications[0]?.adjustments[0]?.totalCost).toBe('-1.5');
    expect(detail.applications[0]?.provenance.lossVersions[0]?.lossPct).toBe(
      '0.1',
    );
    expect(JSON.stringify(detail)).not.toContain('SECRETPATH');
    expect(JSON.stringify(detail)).not.toContain('CAUSEDETAIL');
  });

  it('zeros an unknown count and drops causes that are not codes', () => {
    const missing = countDerivationOf({
      found: false,
      count_id: countId,
      note: null,
      has_surplus: false,
      waiting_for_sync: true,
      waiting_for_processing: false,
      lines: [{ secret: 'LEAK' }],
    });
    expect(missing.found).toBe(false);
    expect(missing.lines).toEqual([]);
    expect(missing.countedAt).toBeNull();
    expect(JSON.stringify(missing)).not.toContain('LEAK');
    const status = shiftStatusOf({
      shift_id: 'shift-1',
      opened_at: '2026-01-01T00:00:00.000Z',
      status_label: 'ناقص',
      revised: true,
      causes: ['open_orders', 'Not A Code', 'pending_applications'],
      revisions: [
        {
          cause_kind: 'waste_document',
          source_at: '2026-09-07T10:00:00.000Z',
          is_latest: false,
          cause_id: 'SECRETID',
        },
        {
          cause_kind: 'order_total',
          source_at: null,
          is_latest: true,
        },
        { cause_kind: 'NOT A KIND', source_at: null, is_latest: false },
        { leak: true },
      ],
      latest_difference: zeroDifference,
      cumulative_difference: { ...zeroDifference, profit_difference: '0.00' },
    });
    expect(status.causes).toEqual(['open_orders', 'pending_applications']);
    expect(status.revisions).toEqual([
      {
        causeKind: 'waste_document',
        sourceAt: '2026-09-07T10:00:00.000Z',
        isLatest: false,
      },
      { causeKind: 'order_total', sourceAt: null, isLatest: true },
    ]);
    expect(status.revised).toBe(true);
    expect(JSON.stringify(status)).not.toContain('SECRETID');
    expect(JSON.stringify(status)).not.toContain('leak');
    expect(() =>
      shiftStatusOf({
        shift_id: 'shift-1',
        opened_at: '2026-01-01T00:00:00.000Z',
        status_label: 'ناقص',
        revised: false,
        causes: [],
        revisions: {},
        latest_difference: zeroDifference,
        cumulative_difference: zeroDifference,
      }),
    ).toThrow(genericCatalogError);
  });

  it('treats idle worker replies as no progress and requires a critical head', () => {
    expect(
      accountingRunOf({
        ...emptyRun('not_activated'),
        processed: 4,
        failed: 2,
      }),
    ).toMatchObject({
      status: 'not_activated',
      counts: { processed: 0, failed: 0 },
      head: null,
      critical: null,
    });
    expect(
      accountingRunOf({
        ...emptyRun('stale'),
        processed: 9,
        head: { order_id: 'order-1', work_generation: 2 },
      }),
    ).toMatchObject({
      status: 'stale',
      counts: { processed: 0 },
      head: { orderId: 'order-1', workGeneration: 2 },
    });
    expect(() => accountingRunOf(emptyRun('critical'))).toThrow(
      genericCatalogError,
    );
    expect(() => nextWorkOf({ status: 'ok', head: null })).toThrow(
      genericCatalogError,
    );
    expect(nextWorkOf({ status: 'empty', head: null }).status).toBe('empty');
    expect(retryResultOf({ status: 'retried' })).toBe('retried');
    expect(() => retryResultOf({ status: 'nope' })).toThrow(
      genericCatalogError,
    );
  });

  it('calls the worker with the prechosen attempt id and limit 1', async () => {
    const seen: Record<string, unknown>[] = [];
    mocks.rpc.mockImplementation(
      (name: string, args?: Record<string, unknown>) => {
        if (name === 'accounting_next_work') {
          return Promise.resolve(
            ok({
              status: 'ok',
              head: { order_id: 'order-1', work_generation: 3 },
            }),
          );
        }
        if (name === 'run_accounting_work') {
          seen.push(args ?? {});
          return Promise.resolve(ok(emptyRun('empty')));
        }
        return Promise.reject(new Error(name));
      },
    );
    const outcome = await runDeductions();
    expect(outcome.stop).toBe('empty');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.p_limit).toBe(1);
    expect(seen[0]?.p_order_id).toBe('order-1');
    expect(seen[0]?.p_work_generation).toBe(3);
    expect(seen[0]?.p_attempt_id).toEqual(expect.any(String));
    expect(String(seen[0]?.p_attempt_id).length).toBeGreaterThan(0);
  });

  it('still calls an unbound worker when next work has no head', async () => {
    mocks.rpc.mockImplementation(
      (name: string, args?: Record<string, unknown>) => {
        if (name === 'accounting_next_work') {
          return Promise.resolve(ok({ status: 'empty', head: null }));
        }
        if (name === 'run_accounting_work') {
          expect(args?.p_limit).toBe(1);
          expect(typeof args?.p_attempt_id).toBe('string');
          expect(String(args?.p_attempt_id).length).toBeGreaterThan(0);
          expect(args?.p_order_id).toBeUndefined();
          expect(args?.p_work_generation).toBeUndefined();
          return Promise.resolve(ok(emptyRun('empty')));
        }
        return Promise.reject(new Error(name));
      },
    );
    const outcome = await runDeductions();
    expect(outcome.calls).toBe(1);
  });

  it('hides a read failure message', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: '42501',
        message: 'permission denied for function accounting_processing_summary',
      },
    });
    await expect(loadProcessingSummary()).rejects.toThrow(ownerReadMessage);
  });

  it('pages the opening roster and sorts it by Arabic name', async () => {
    const page = (name: string, id: string, next: string | null) =>
      ok({
        activated: false,
        stock_started_at: null,
        opening_manifest_hash: null,
        can_activate: false,
        checklist: [{ code: 'empty_roster', ready: true, count: '2' }],
        roster: [
          {
            item_id: id,
            name,
            base_unit: 'kg',
            active: true,
            missing: true,
            opening_line_count: '0',
            observation: null,
          },
        ],
        next_item_id: next,
      });
    mocks.rpc
      .mockResolvedValueOnce(page('ي', itemB, itemA))
      .mockResolvedValueOnce(page('أ', itemA, null));
    const review = await loadOpeningReview();
    expect(review.roster.map((item) => item.name)).toEqual(['أ', 'ي']);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'opening_activation_review', {
      p_limit: 100,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'opening_activation_review', {
      p_after_id: itemA,
      p_limit: 100,
    });
  });

  it('passes both shift cursors or neither', async () => {
    const row = (id: string) => ({
      shift_id: id,
      opened_at: `opened-${id}`,
      status_label: 'ناقص',
      revised: false,
      causes: [],
      latest_difference: zeroDifference,
      cumulative_difference: zeroDifference,
    });
    const first = Array.from({ length: 100 }, (_, index) =>
      row(`s${index.toString()}`),
    );
    mocks.rpc
      .mockResolvedValueOnce(ok(first))
      .mockResolvedValueOnce(ok([row('tail')]));
    const loaded = await loadShiftStatuses(['s0', 'tail']);
    expect(loaded.capped).toBe(false);
    expect(loaded.byId.has('tail')).toBe(true);
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      1,
      'list_shift_accounting_status',
      { p_limit: 100 },
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      'list_shift_accounting_status',
      {
        p_after_opened_at: 'opened-s99',
        p_after_id: 's99',
        p_limit: 100,
      },
    );
  });

  it('retries a parked order through the worker RPC', async () => {
    mocks.rpc.mockResolvedValue(ok({ status: 'not_failed' }));
    await expect(retryParkedOrder('order-1')).resolves.toBe('not_failed');
    expect(mocks.rpc).toHaveBeenCalledWith('retry_accounting_work', {
      p_order_id: 'order-1',
    });
  });
});
