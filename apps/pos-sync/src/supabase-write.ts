import { assertLocalSupabaseUrl } from './local-guard.ts';
import { isRecord } from './decode.ts';
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
]);

function localFetch(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, init);
}

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

export function createSupabaseDb(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: FetchLike = localFetch,
): PosDb {
  assertLocalSupabaseUrl(supabaseUrl);
  if (serviceRoleKey.trim().length === 0) {
    throw new Error('Supabase service role key is required');
  }

  async function rpc(name: string, body: unknown): Promise<unknown> {
    if (!RPC_NAMES.has(name)) {
      throw new Error('Supabase RPC failed: unexpected response');
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
      });
    } catch {
      throw new Error('Supabase RPC failed: network');
    }
    if (!response.ok) {
      try {
        await response.text();
      } catch {
        // The status is enough. Never surface the body.
      }
      throw new Error(`Supabase RPC failed: HTTP ${response.status}`);
    }
    const text = await readBody(response);
    if (text.trim().length === 0) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('Supabase RPC failed: unexpected response');
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
  };
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    throw new Error('Supabase RPC failed: unexpected response');
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

function parseRunId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Supabase RPC failed: unexpected response');
  }
  return value;
}

function parseCounts(value: unknown): IngestCounts {
  if (!isRecord(value)) {
    throw new Error('Supabase RPC failed: unexpected response');
  }
  return {
    inserted: countField(value.inserted),
    updated: countField(value.updated),
    unchanged: countField(value.unchanged),
    stale: countField(value.stale),
    missing: countField(value.missing),
    shifts_upserted: countField(value.shifts_upserted),
    shifts_skipped: countField(value.shifts_skipped),
  };
}

function countField(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('Supabase RPC failed: unexpected response');
  }
  return value;
}
