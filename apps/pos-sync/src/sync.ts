import { compareId } from './hash.ts';
import { assertLocalSupabaseUrl } from './local-guard.ts';
import type { PosSnapshot } from './read-pos.ts';
import { safeErrorMessage } from './safe-error.ts';
import { planIngestCalls } from './scope.ts';
import { createSupabaseDb, type PosDb } from './supabase-write.ts';
import type { SyncMode } from './types.ts';

export type PosReader = {
  read(mode: SyncMode, now: Date): Promise<PosSnapshot>;
};

export type SyncCounts = {
  read: number;
  inserted: number;
  updated: number;
  unchanged: number;
  stale: number;
  missing: number;
  shifts_upserted: number;
  shifts_skipped: number;
};

export type SyncResult = {
  mode: SyncMode;
  shiftIds: string[];
  counts: SyncCounts;
};

export type SyncLogger = (line: string) => void;

function emptyCounts(): SyncCounts {
  return {
    read: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    stale: 0,
    missing: 0,
    shifts_upserted: 0,
    shifts_skipped: 0,
  };
}

export async function runPosSync(input: {
  mode: SyncMode;
  supabaseUrl: string;
  serviceRoleKey: string;
  reader: PosReader;
  db?: PosDb;
  now?: Date;
  logger?: SyncLogger;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<SyncResult> {
  assertLocalSupabaseUrl(input.supabaseUrl);
  const db =
    input.db ??
    createSupabaseDb(input.supabaseUrl, input.serviceRoleKey, input.fetchImpl);
  const counts = emptyCounts();
  let runId: number | undefined;
  try {
    runId = await db.startRun(input.mode);
    const read = await input.reader.read(input.mode, input.now ?? new Date());
    const shifts = [...read.shifts].sort((left, right) =>
      compareId(left.id, right.id),
    );
    const orders = [...read.orders].sort((left, right) =>
      compareId(left.id, right.id),
    );
    counts.read = orders.length;
    input.logger?.(
      `pos sync read mode=${input.mode} shifts=${shifts.length} orders=${orders.length} shift_ids=${shifts.map((shift) => shift.id).join(',')} missing_shifts=${read.missingShiftIds.join(',')}`,
    );
    const calls = planIngestCalls({ shifts, orders, scope: read.scope });
    for (const call of calls) {
      const chunk = await db.ingest(
        runId,
        call.shifts,
        call.orders,
        call.scope,
      );
      counts.inserted += chunk.inserted;
      counts.updated += chunk.updated;
      counts.unchanged += chunk.unchanged;
      counts.stale += chunk.stale;
      counts.missing += chunk.missing;
      counts.shifts_upserted += chunk.shifts_upserted;
      counts.shifts_skipped += chunk.shifts_skipped;
    }
    await db.finishRun(runId, 'ok', { ...counts }, null);
    return {
      mode: input.mode,
      shiftIds: shifts.map((shift) => shift.id),
      counts: { ...counts },
    };
  } catch (error) {
    if (runId === undefined) {
      throw error;
    }
    const reported = safeErrorMessage(error);
    try {
      await db.finishRun(runId, 'failed', { ...counts }, reported);
    } catch (finishError) {
      throw new Error(`${reported}; ${safeErrorMessage(finishError)}`, {
        cause: finishError,
      });
    }
    throw new Error(reported, { cause: error });
  }
}
