import { describe, expect, it } from 'vitest';
import { localServiceRoleKey } from './local-supabase.ts';
import {
  createSupabaseDb,
  isUnknownOutcome,
  SupabaseRpcError,
} from './supabase-write.ts';
import type { IngestCounts } from './types.ts';

const counts: IngestCounts = {
  inserted: 1,
  updated: 0,
  unchanged: 2,
  stale: 0,
  missing: 0,
  shifts_upserted: 1,
  shifts_skipped: 0,
  transactions: 0,
};

describe('createSupabaseDb', () => {
  it('refuses a hosted URL before fetching', () => {
    expect(() =>
      createSupabaseDb(
        'https://abc.supabase.co',
        localServiceRoleKey,
        async () => {
          throw new Error('fetch should not be called');
        },
      ),
    ).toThrow(/Refusing non-local Supabase URL/);
  });

  it('calls the app RPC profile and hides error bodies', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const db = createSupabaseDb(
      'http://127.0.0.1:55421',
      localServiceRoleKey,
      async (url, init) => {
        calls.push({ url, init });
        const path = new URL(url).pathname;
        if (path.endsWith('/start_pos_sync_run')) {
          return new Response('4', { status: 200 });
        }
        if (path.endsWith('/ingest_pos_batch')) {
          return new Response(JSON.stringify(counts), { status: 200 });
        }
        return new Response(null, { status: 204 });
      },
    );
    await expect(db.startRun('recent')).resolves.toBe(4);
    await expect(db.ingest(4, [], [], null)).resolves.toEqual(counts);
    await expect(
      db.finishRun(4, 'ok', { read: 0 }, null),
    ).resolves.toBeUndefined();
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/rest/v1/rpc/start_pos_sync_run',
      '/rest/v1/rpc/ingest_pos_batch',
      '/rest/v1/rpc/finish_pos_sync_run',
    ]);
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(call.init.redirect).toBe('error');
      expect(headers.get('Content-Profile')).toBe('app');
      expect(headers.get('Accept-Profile')).toBe('app');
      expect(headers.get('apikey')).toBe(localServiceRoleKey);
      expect(headers.get('Authorization')).toBe(
        `Bearer ${localServiceRoleKey}`,
      );
    }
    const ingest = calls[1]?.init.body;
    expect(typeof ingest).toBe('string');
    expect(ingest).toContain('"p_scope":null');

    const failing = createSupabaseDb(
      'http://127.0.0.1:55421',
      localServiceRoleKey,
      async () => {
        return new Response('pii-customer-name ya29.SECRET', { status: 500 });
      },
    );
    await expect(failing.startRun('recent')).rejects.toThrow(
      /^Supabase RPC failed: HTTP 500$/,
    );
  });

  it('reports another POS sync is running when start is refused', async () => {
    const db = createSupabaseDb(
      'http://127.0.0.1:55421',
      localServiceRoleKey,
      async () => {
        return new Response(
          JSON.stringify({
            code: '55P03',
            details: 'pii-customer-name ya29.SECRET',
            hint: null,
            message: 'another POS sync is running',
          }),
          { status: 400 },
        );
      },
    );
    await expect(db.startRun('recent')).rejects.toThrow(
      /^another POS sync is running$/,
    );
  });

  it('keeps other database errors to the HTTP status', async () => {
    const secret = 'pii-customer-name ya29.SECRET-DB';
    const startCases: Array<{ status: number; body: string }> = [
      { status: 500, body: secret },
      {
        status: 400,
        body: JSON.stringify({ code: '55P03', message: secret }),
      },
      {
        status: 400,
        body: JSON.stringify({
          code: 'P0001',
          message: 'another POS sync is running',
          details: secret,
        }),
      },
      {
        status: 400,
        body: JSON.stringify({
          code: '55P03',
          message: 'Another POS sync is running',
        }),
      },
    ];
    for (const item of startCases) {
      const db = createSupabaseDb(
        'http://127.0.0.1:55421',
        localServiceRoleKey,
        async () => new Response(item.body, { status: item.status }),
      );
      await expect(db.startRun('recent')).rejects.toThrow(
        new RegExp(`^Supabase RPC failed: HTTP ${item.status}$`),
      );
    }

    const ingest = createSupabaseDb(
      'http://127.0.0.1:55421',
      localServiceRoleKey,
      async () => {
        return new Response(
          JSON.stringify({
            code: '55P03',
            message: 'another POS sync is running',
            details: secret,
          }),
          { status: 409 },
        );
      },
    );
    await expect(ingest.ingest(4, [], [], null)).rejects.toThrow(
      /^Supabase RPC failed: HTTP 409$/,
    );
  });
});

const ATTEMPT = 'b4c00000-0000-4000-8000-000000000501';

const processedBody = {
  status: 'processed',
  processed: 3,
  applied: 2,
  unchanged: 1,
  incomplete: 0,
  none: 0,
  blocked: 0,
  disposition_pending: 0,
  failed: 0,
  remaining: 4,
  head: { order_id: 'order-test-9', work_generation: 2 },
  critical: null,
};

function accountingDb(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const db = createSupabaseDb(
    'http://127.0.0.1:55421',
    localServiceRoleKey,
    async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  );
  return { db, calls };
}

function sentBody(call: { init: RequestInit } | undefined): unknown {
  const body = call?.init.body;
  if (typeof body !== 'string') {
    throw new Error('request body is not a string');
  }
  return JSON.parse(body) as unknown;
}

describe('accounting RPCs', () => {
  it('calls the app profile with the caller attempt id and a timeout', async () => {
    const { db, calls } = accountingDb((url) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/run_accounting_work')) {
        return new Response(JSON.stringify(processedBody), { status: 200 });
      }
      if (path.endsWith('/accounting_next_work')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            head: { order_id: 'order-test-9', work_generation: 2 },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: 'recorded' }), {
        status: 200,
      });
    });
    await expect(db.getNextWork()).resolves.toEqual({
      status: 'ok',
      head: { orderId: 'order-test-9', workGeneration: 2 },
    });
    await expect(
      db.runAccountingWork(ATTEMPT, 1, {
        orderId: 'order-test-9',
        workGeneration: 2,
      }),
    ).resolves.toEqual({
      status: 'processed',
      counts: {
        processed: 3,
        applied: 2,
        unchanged: 1,
        incomplete: 0,
        none: 0,
        blocked: 0,
        disposition_pending: 0,
        failed: 0,
        remaining: 4,
      },
      head: { orderId: 'order-test-9', workGeneration: 2 },
      critical: null,
    });
    await expect(db.runAccountingWork(ATTEMPT, 1, null)).resolves.toMatchObject(
      { status: 'processed' },
    );
    await expect(
      db.recordAccountingCallFailure(ATTEMPT, 'order-test-9', 2),
    ).resolves.toBe('recorded');
    await expect(
      db.recordAccountingRecomputeTimeout(ATTEMPT, 'order-test-9', 2),
    ).resolves.toBe('recorded');
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/rest/v1/rpc/accounting_next_work',
      '/rest/v1/rpc/run_accounting_work',
      '/rest/v1/rpc/run_accounting_work',
      '/rest/v1/rpc/record_accounting_call_failure',
      '/rest/v1/rpc/record_accounting_recompute_timeout',
    ]);
    expect(sentBody(calls[0])).toEqual({});
    expect(sentBody(calls[1])).toEqual({
      p_attempt_id: ATTEMPT,
      p_limit: 1,
      p_order_id: 'order-test-9',
      p_work_generation: 2,
    });
    expect(sentBody(calls[2])).toEqual({
      p_attempt_id: ATTEMPT,
      p_limit: 1,
      p_order_id: null,
      p_work_generation: null,
    });
    expect(sentBody(calls[3])).toEqual({
      p_attempt_id: ATTEMPT,
      p_order_id: 'order-test-9',
      p_work_generation: 2,
    });
    expect(sentBody(calls[4])).toEqual({
      p_attempt_id: ATTEMPT,
      p_order_id: 'order-test-9',
      p_work_generation: 2,
    });
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(call.init.redirect).toBe('error');
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(headers.get('Content-Profile')).toBe('app');
      expect(headers.get('Accept-Profile')).toBe('app');
      expect(headers.get('apikey')).toBe(localServiceRoleKey);
    }
  });

  it('accepts the idle statuses without counts', async () => {
    for (const status of ['empty', 'busy', 'sync_running', 'not_activated']) {
      const { db } = accountingDb(
        () =>
          new Response(
            JSON.stringify(
              status === 'empty'
                ? {
                    ...processedBody,
                    status,
                    processed: 0,
                    remaining: 0,
                    head: null,
                  }
                : { status },
            ),
            { status: 200 },
          ),
      );
      const run = await db.runAccountingWork(ATTEMPT, 1, null);
      expect(run.status).toBe(status);
      expect(run.critical).toBeNull();
    }
  });

  it('returns the real head with zero counts for a stale bound call', async () => {
    const { db } = accountingDb(
      () =>
        new Response(
          JSON.stringify({
            status: 'stale',
            head: { order_id: 'order-test-4', work_generation: 5 },
          }),
          { status: 200 },
        ),
    );
    const run = await db.runAccountingWork(ATTEMPT, 1, {
      orderId: 'order-test-9',
      workGeneration: 2,
    });
    expect(run.status).toBe('stale');
    expect(run.head).toEqual({ orderId: 'order-test-4', workGeneration: 5 });
    expect(run.counts.processed).toBe(0);
    expect(run.counts.remaining).toBe(0);
    expect(run.critical).toBeNull();
  });

  it('parses the next-work peek and rejects malformed ones', async () => {
    const valid: Array<[unknown, unknown]> = [
      [
        {
          status: 'ok',
          head: { order_id: 'order-test-9', work_generation: 2 },
        },
        {
          status: 'ok',
          head: { orderId: 'order-test-9', workGeneration: 2 },
        },
      ],
      [
        { status: 'empty', head: null },
        { status: 'empty', head: null },
      ],
      [{ status: 'not_activated' }, { status: 'not_activated', head: null }],
    ];
    for (const [body, expected] of valid) {
      const { db } = accountingDb(
        () => new Response(JSON.stringify(body), { status: 200 }),
      );
      await expect(db.getNextWork()).resolves.toEqual(expected);
    }
    const malformed: unknown[] = [
      null,
      [],
      'ok',
      { status: 'weird', head: null },
      { status: 'ok' },
      { status: 'ok', head: null },
      {
        status: 'empty',
        head: { order_id: 'order-test-9', work_generation: 2 },
      },
      { status: 'ok', head: { order_id: 'bad id!', work_generation: 2 } },
      { status: 'ok', head: { order_id: 'order-test-9', work_generation: 0 } },
    ];
    for (const body of malformed) {
      const { db } = accountingDb(
        () => new Response(JSON.stringify(body), { status: 200 }),
      );
      await expect(db.getNextWork()).rejects.toThrow(
        /^Supabase RPC failed: unexpected response$/,
      );
    }
  });

  it('accepts every order id that ingest accepts and rejects unsafe ones', async () => {
    const valid = ['order.v2', 'o'.repeat(129), 'o'.repeat(1500), 'a-b_c.d~e'];
    const invalid = [
      '',
      'o'.repeat(1501),
      'a/b',
      'a b',
      '..',
      'a..b',
      'a%2Fb',
      'a:b',
      'a?b',
      'a#b',
      'a\\b',
      'a\nb',
    ];
    const bodies = (id: string): Array<[unknown, 'next' | 'run']> => [
      [{ status: 'ok', head: { order_id: id, work_generation: 1 } }, 'next'],
      [{ ...processedBody, head: { order_id: id, work_generation: 1 } }, 'run'],
      [{ status: 'stale', head: { order_id: id, work_generation: 1 } }, 'run'],
      [
        {
          ...processedBody,
          status: 'critical',
          critical: { order_id: id, work_generation: 1 },
        },
        'run',
      ],
    ];
    const call = (
      db: ReturnType<typeof accountingDb>['db'],
      kind: 'next' | 'run',
    ) =>
      kind === 'next'
        ? db.getNextWork()
        : db.runAccountingWork(ATTEMPT, 1, null);
    for (const id of valid) {
      for (const [body, kind] of bodies(id)) {
        const { db } = accountingDb(
          () => new Response(JSON.stringify(body), { status: 200 }),
        );
        await expect(call(db, kind)).resolves.toBeDefined();
      }
    }
    for (const id of invalid) {
      for (const [body, kind] of bodies(id)) {
        const { db } = accountingDb(
          () => new Response(JSON.stringify(body), { status: 200 }),
        );
        await expect(call(db, kind)).rejects.toThrow(
          /^Supabase RPC failed: unexpected response$/,
        );
      }
    }
  });

  it('hides error bodies of the next-work peek', async () => {
    const secret = 'pii-customer-name ya29.SECRET-DB';
    const { db } = accountingDb(() => new Response(secret, { status: 500 }));
    const error = await db.getNextWork().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SupabaseRpcError);
    expect((error as Error).message).toBe('Supabase RPC failed: HTTP 500');
  });

  it('returns the critical order only with the critical status', async () => {
    const critical = { order_id: 'order-test-7', work_generation: 3 };
    const { db } = accountingDb(
      () =>
        new Response(
          JSON.stringify({ ...processedBody, status: 'critical', critical }),
          { status: 200 },
        ),
    );
    const run = await db.runAccountingWork(ATTEMPT, 1, null);
    expect(run.status).toBe('critical');
    expect(run.critical).toEqual({
      orderId: 'order-test-7',
      workGeneration: 3,
    });

    const mismatched = [
      { ...processedBody, status: 'critical' },
      { ...processedBody, critical },
    ];
    for (const body of mismatched) {
      const { db: other } = accountingDb(
        () => new Response(JSON.stringify(body), { status: 200 }),
      );
      await expect(other.runAccountingWork(ATTEMPT, 1, null)).rejects.toThrow(
        /^Supabase RPC failed: unexpected response$/,
      );
    }
  });

  it('rejects malformed worker and recorder responses', async () => {
    const workerBodies: unknown[] = [
      null,
      [],
      'processed',
      { status: 'weird' },
      { ...processedBody, processed: -1 },
      { ...processedBody, applied: 1.5 },
      { ...processedBody, remaining: '4' },
      { ...processedBody, failed: undefined },
      { ...processedBody, head: { order_id: 'bad id!', work_generation: 1 } },
      { ...processedBody, head: { order_id: 'order-1', work_generation: 0 } },
    ];
    for (const body of workerBodies) {
      const { db } = accountingDb(
        () => new Response(JSON.stringify(body), { status: 200 }),
      );
      await expect(db.runAccountingWork(ATTEMPT, 1, null)).rejects.toThrow(
        /^Supabase RPC failed: unexpected response$/,
      );
    }
    for (const body of [null, {}, { status: 'ok' }, 'recorded']) {
      const { db } = accountingDb(
        () => new Response(JSON.stringify(body), { status: 200 }),
      );
      await expect(
        db.recordAccountingCallFailure(ATTEMPT, 'order-test-9', 1),
      ).rejects.toThrow(/^Supabase RPC failed: unexpected response$/);
    }
    const { db: notJson } = accountingDb(
      () => new Response('<html>', { status: 200 }),
    );
    await expect(notJson.runAccountingWork(ATTEMPT, 1, null)).rejects.toThrow(
      /^Supabase RPC failed: unexpected response$/,
    );
  });

  it('hides error bodies and classifies unknown outcomes', async () => {
    const secret = 'pii-customer-name ya29.SECRET-DB';
    const cases: Array<{ status: number; body: string; unknown: boolean }> = [
      { status: 500, body: secret, unknown: true },
      { status: 502, body: '', unknown: true },
      {
        status: 500,
        body: JSON.stringify({ code: '57014', message: secret }),
        unknown: true,
      },
      {
        status: 400,
        body: JSON.stringify({ code: '57014', message: secret }),
        unknown: true,
      },
      {
        status: 400,
        body: JSON.stringify({ code: '22023', message: secret }),
        unknown: false,
      },
      { status: 401, body: secret, unknown: false },
      { status: 404, body: secret, unknown: false },
    ];
    for (const item of cases) {
      const { db } = accountingDb(
        () => new Response(item.body, { status: item.status }),
      );
      const error = await db.runAccountingWork(ATTEMPT, 1, null).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SupabaseRpcError);
      expect((error as Error).message).toBe(
        `Supabase RPC failed: HTTP ${item.status}`,
      );
      expect(isUnknownOutcome(error)).toBe(item.unknown);
    }
  });

  it('treats a lost reply, a timeout and an unreadable body as unknown', async () => {
    const lost = createSupabaseDb(
      'http://127.0.0.1:55421',
      localServiceRoleKey,
      async () => {
        throw new TypeError('socket hang up ya29.SECRET');
      },
    );
    const lostError = await lost.runAccountingWork(ATTEMPT, 1, null).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((lostError as Error).message).toBe('Supabase RPC failed: network');
    expect(isUnknownOutcome(lostError)).toBe(true);

    const timeout = createSupabaseDb(
      'http://127.0.0.1:55421',
      localServiceRoleKey,
      async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    );
    const timeoutError = await timeout
      .recordAccountingCallFailure(ATTEMPT, 'order-test-9', 1)
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect((timeoutError as Error).message).toBe(
      'Supabase RPC failed: network',
    );
    expect(isUnknownOutcome(timeoutError)).toBe(true);
    expect(isUnknownOutcome(new Error('plain'))).toBe(false);

    const unreadable = createSupabaseDb(
      'http://127.0.0.1:55421',
      localServiceRoleKey,
      async () =>
        ({
          ok: true,
          status: 200,
          async text() {
            throw new Error('reset');
          },
        }) as unknown as Response,
    );
    const unreadableError = await unreadable
      .runAccountingWork(ATTEMPT, 1, null)
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect((unreadableError as Error).message).toBe(
      'Supabase RPC failed: unexpected response',
    );
    expect(isUnknownOutcome(unreadableError)).toBe(true);
  });

  it('keeps the RPC allowlist closed to retry and other functions', async () => {
    const { db, calls } = accountingDb(
      () => new Response('{}', { status: 200 }),
    );
    expect(Object.keys(db).sort()).toEqual([
      'finishRun',
      'getNextWork',
      'ingest',
      'recordAccountingCallFailure',
      'recordAccountingRecomputeTimeout',
      'runAccountingWork',
      'startRun',
    ]);
    expect(calls).toEqual([]);
  });
});
