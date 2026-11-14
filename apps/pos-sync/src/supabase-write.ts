import { assertLocalSupabaseUrl } from './local-guard.ts';
import { isRecord, isSafeDocumentId } from './decode.ts';
import type {
  IngestCounts,
  PosOrderIngest,
  PosShiftIngest,
  SyncMode,
  SyncScope,
} from './types.ts';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const RPC_NAMES = new Set([
  'start_pos_sync_run',
  'ingest_pos_batch',
  'finish_pos_sync_run',
  'run_accounting_work',
  'record_accounting_call_failure',
  'record_accounting_recompute_timeout',
  'accounting_next_work',
]);

const ACCOUNTING_CALL_TIMEOUT_MS = 20_000;

function localFetch(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, init);
}

export type RpcFailureKind = 'network' | 'http' | 'response';

export class SupabaseRpcError extends Error {
  readonly kind: RpcFailureKind;
  readonly status: number | null;
  readonly sqlstate: string | null;

  constructor(
    message: string,
    kind: RpcFailureKind,
    status: number | null = null,
    sqlstate: string | null = null,
  ) {
    super(message);
    this.name = 'SupabaseRpcError';
    this.kind = kind;
    this.status = status;
    this.sqlstate = sqlstate;
  }
}

// True when the call may have reached the database and its outcome is not
// known: no reply, a server error, a statement timeout, or a reply that cannot
// be read. A refusal (4xx other than a timeout) means the call did not run.
export function isUnknownOutcome(error: unknown): boolean {
  if (!(error instanceof SupabaseRpcError)) {
    return false;
  }
  if (error.sqlstate === '57014') {
    return true;
  }
  if (error.kind === 'network' || error.kind === 'response') {
    return true;
  }
  return error.status !== null && error.status >= 500;
}

export type AccountingStatus =
  | 'processed'
  | 'stale'
  | 'empty'
  | 'busy'
  | 'sync_running'
  | 'not_activated'
  | 'critical';

export type AccountingCounts = {
  processed: number;
  applied: number;
  unchanged: number;
  incomplete: number;
  none: number;
  blocked: number;
  disposition_pending: number;
  failed: number;
  remaining: number;
};

export type AccountingOrderRef = { orderId: string; workGeneration: number };

export type AccountingRun = {
  status: AccountingStatus;
  counts: AccountingCounts;
  head: AccountingOrderRef | null;
  critical: AccountingOrderRef | null;
};

export type FailureReport =
  'recorded' | 'committed' | 'duplicate' | 'no_work' | 'stale' | 'busy';

export type PosDb = {
  startRun(mode: SyncMode): Promise<number>;
  ingest(
    runId: number,
    shifts: PosShiftIngest[],
    orders: PosOrderIngest[],
    scope: SyncScope | null,
  ): Promise<IngestCounts>;
  finishRun(
    runId: number,
    status: 'ok' | 'failed',
    counts: Record<string, number>,
    error: string | null,
  ): Promise<void>;
};

export type NextWork = {
  status: 'ok' | 'empty' | 'not_activated';
  head: AccountingOrderRef | null;
};

// A worker call is bound to the order it may process; a failure report names
// that same order and generation, so it can only ever charge that order. An
// unbound call (null) is maintenance: it processes no order.
export type AccountingDb = {
  getNextWork(): Promise<NextWork>;
  runAccountingWork(
    attemptId: string,
    limit: number,
    binding: AccountingOrderRef | null,
  ): Promise<AccountingRun>;
  recordAccountingCallFailure(
    attemptId: string,
    orderId: string,
    workGeneration: number,
  ): Promise<FailureReport>;
  recordAccountingRecomputeTimeout(
    attemptId: string,
    orderId: string,
    workGeneration: number,
  ): Promise<FailureReport>;
};

export function createSupabaseDb(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: FetchLike = localFetch,
): PosDb & AccountingDb {
  assertLocalSupabaseUrl(supabaseUrl);
  if (serviceRoleKey.trim().length === 0) {
    throw new Error('Supabase service role key is required');
  }

  async function rpc(
    name: string,
    body: unknown,
    timeoutMs: number | null = null,
  ): Promise<unknown> {
    if (!RPC_NAMES.has(name)) {
      throw unexpectedResponse();
    }
    const url = rpcUrl(supabaseUrl, name);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
          'Content-Profile': 'app',
          Accept: 'application/json',
          'Accept-Profile': 'app',
        },
        body: JSON.stringify(body),
        ...(timeoutMs === null
          ? {}
          : { signal: AbortSignal.timeout(timeoutMs) }),
      });
    } catch {
      throw new SupabaseRpcError('Supabase RPC failed: network', 'network');
    }
    if (!response.ok) {
      let text: string;
      try {
        text = await response.text();
      } catch {
        text = '';
      }
      if (name === 'start_pos_sync_run' && isAnotherPosSyncRunning(text)) {
        throw new Error('another POS sync is running');
      }
      throw new SupabaseRpcError(
        `Supabase RPC failed: HTTP ${response.status}`,
        'http',
        response.status,
        errorSqlstate(text),
      );
    }
    const text = await readBody(response);
    if (text.trim().length === 0) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw unexpectedResponse();
    }
  }

  return {
    async startRun(mode) {
      return parseRunId(await rpc('start_pos_sync_run', { p_mode: mode }));
    },
    async ingest(runId, shifts, orders, scope) {
      return parseCounts(
        await rpc('ingest_pos_batch', {
          p_run_id: runId,
          p_shifts: shifts,
          p_orders: orders,
          p_scope: scope,
        }),
      );
    },
    async finishRun(runId, status, counts, error) {
      await rpc('finish_pos_sync_run', {
        p_run_id: runId,
        p_status: status,
        p_counts: counts,
        p_error: error,
      });
    },
    async getNextWork() {
      return parseNextWork(
        await rpc('accounting_next_work', {}, ACCOUNTING_CALL_TIMEOUT_MS),
      );
    },
    async runAccountingWork(attemptId, limit, binding) {
      return parseAccountingRun(
        await rpc(
          'run_accounting_work',
          {
            p_attempt_id: attemptId,
            p_limit: limit,
            p_order_id: binding?.orderId ?? null,
            p_work_generation: binding?.workGeneration ?? null,
          },
          ACCOUNTING_CALL_TIMEOUT_MS,
        ),
      );
    },
    async recordAccountingCallFailure(attemptId, orderId, workGeneration) {
      return parseFailureReport(
        await rpc(
          'record_accounting_call_failure',
          {
            p_attempt_id: attemptId,
            p_order_id: orderId,
            p_work_generation: workGeneration,
          },
          ACCOUNTING_CALL_TIMEOUT_MS,
        ),
      );
    },
    async recordAccountingRecomputeTimeout(attemptId, orderId, workGeneration) {
      return parseFailureReport(
        await rpc(
          'record_accounting_recompute_timeout',
          {
            p_attempt_id: attemptId,
            p_order_id: orderId,
            p_work_generation: workGeneration,
          },
          ACCOUNTING_CALL_TIMEOUT_MS,
        ),
      );
    },
  };
}

function unexpectedResponse(): SupabaseRpcError {
  return new SupabaseRpcError(
    'Supabase RPC failed: unexpected response',
    'response',
  );
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    throw unexpectedResponse();
  }
}

function rpcUrl(base: string, name: string): string {
  assertLocalSupabaseUrl(base);
  const url = new URL(`/rest/v1/rpc/${name}`, base);
  const baseUrl = new URL(base);
  if (
    url.origin !== baseUrl.origin ||
    url.pathname !== `/rest/v1/rpc/${name}`
  ) {
    throw new Error(`Refusing non-local Supabase URL: ${base}`);
  }
  return url.toString();
}

function isAnotherPosSyncRunning(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return false;
  }
  return (
    isRecord(parsed) &&
    parsed.code === '55P03' &&
    parsed.message === 'another POS sync is running'
  );
}

// Only the five-character SQLSTATE is kept. The message, details and hint of a
// database error are never read.
function errorSqlstate(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (
    isRecord(parsed) &&
    typeof parsed.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(parsed.code)
  ) {
    return parsed.code;
  }
  return null;
}

function parseRunId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw unexpectedResponse();
  }
  return value;
}

function parseCounts(value: unknown): IngestCounts {
  if (!isRecord(value)) {
    throw unexpectedResponse();
  }
  return {
    inserted: countField(value.inserted),
    updated: countField(value.updated),
    unchanged: countField(value.unchanged),
    stale: countField(value.stale),
    missing: countField(value.missing),
    shifts_upserted: countField(value.shifts_upserted),
    shifts_skipped: countField(value.shifts_skipped),
    transactions: countField(value.transactions),
  };
}

function countField(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw unexpectedResponse();
  }
  return value;
}

const ACCOUNTING_STATUSES = new Set<string>([
  'processed',
  'stale',
  'empty',
  'busy',
  'sync_running',
  'not_activated',
  'critical',
]);

const IDLE_STATUSES = new Set<string>([
  'busy',
  'sync_running',
  'not_activated',
]);

const FAILURE_REPORTS = new Set<string>([
  'recorded',
  'committed',
  'duplicate',
  'no_work',
  'stale',
  'busy',
]);

function parseAccountingRun(value: unknown): AccountingRun {
  if (
    !isRecord(value) ||
    typeof value.status !== 'string' ||
    !ACCOUNTING_STATUSES.has(value.status)
  ) {
    throw unexpectedResponse();
  }
  const status = value.status as AccountingStatus;
  if (IDLE_STATUSES.has(status)) {
    return {
      status,
      counts: zeroAccountingCounts(),
      head: null,
      critical: null,
    };
  }
  if (status === 'stale') {
    return {
      status,
      counts: zeroAccountingCounts(),
      head: parseOrderRef(value.head),
      critical: null,
    };
  }
  const counts: AccountingCounts = {
    processed: countField(value.processed),
    applied: countField(value.applied),
    unchanged: countField(value.unchanged),
    incomplete: countField(value.incomplete),
    none: countField(value.none),
    blocked: countField(value.blocked),
    disposition_pending: countField(value.disposition_pending),
    failed: countField(value.failed),
    remaining: countField(value.remaining),
  };
  const head = parseOrderRef(value.head);
  const critical = parseOrderRef(value.critical);
  if ((status === 'critical') !== (critical !== null)) {
    throw unexpectedResponse();
  }
  return { status, counts, head, critical };
}

const NEXT_WORK_STATUSES = new Set<string>(['ok', 'empty', 'not_activated']);

function parseNextWork(value: unknown): NextWork {
  if (
    !isRecord(value) ||
    typeof value.status !== 'string' ||
    !NEXT_WORK_STATUSES.has(value.status)
  ) {
    throw unexpectedResponse();
  }
  const head = parseOrderRef(value.head);
  if ((value.status === 'ok') !== (head !== null)) {
    throw unexpectedResponse();
  }
  return { status: value.status as NextWork['status'], head };
}

function parseOrderRef(value: unknown): AccountingOrderRef | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.order_id !== 'string' ||
    !isSafeDocumentId(value.order_id) ||
    typeof value.work_generation !== 'number' ||
    !Number.isInteger(value.work_generation) ||
    value.work_generation < 1
  ) {
    throw unexpectedResponse();
  }
  return { orderId: value.order_id, workGeneration: value.work_generation };
}

function parseFailureReport(value: unknown): FailureReport {
  if (
    !isRecord(value) ||
    typeof value.status !== 'string' ||
    !FAILURE_REPORTS.has(value.status)
  ) {
    throw unexpectedResponse();
  }
  return value.status as FailureReport;
}

export function zeroAccountingCounts(): AccountingCounts {
  return {
    processed: 0,
    applied: 0,
    unchanged: 0,
    incomplete: 0,
    none: 0,
    blocked: 0,
    disposition_pending: 0,
    failed: 0,
    remaining: 0,
  };
}
