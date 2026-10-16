import { pathToFileURL } from 'node:url';
import { loadAccessToken } from './access-token.ts';
import { parseMode } from './args.ts';
import { createPosFirestore } from './firestore-read.ts';
import { assertLocalSupabaseUrl } from './local-guard.ts';
import { LOCAL_SUPABASE_URL, localServiceRoleKey } from './local-supabase.ts';
import { createPosReader } from './read-pos.ts';
import { safeErrorMessage } from './safe-error.ts';
import { runPosSync, type SyncResult } from './sync.ts';
import type { SyncMode } from './types.ts';

export type CliDeps = {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  loadToken: () => Promise<string>;
  runSync: (input: {
    mode: SyncMode;
    supabaseUrl: string;
    serviceRoleKey: string;
    token: string;
    log: (line: string) => void;
  }) => Promise<SyncResult>;
  log: (line: string) => void;
  error: (line: string) => void;
};

export async function main(deps: CliDeps): Promise<number> {
  try {
    const mode = parseMode(deps.argv);
    const supabaseUrl = deps.env.POS_SUPABASE_URL?.trim() || LOCAL_SUPABASE_URL;
    const serviceRoleKey =
      deps.env.POS_SUPABASE_SERVICE_ROLE_KEY?.trim() || localServiceRoleKey;
    assertLocalSupabaseUrl(supabaseUrl);
    const token = await deps.loadToken();
    const result = await deps.runSync({
      mode,
      supabaseUrl,
      serviceRoleKey,
      token,
      log: deps.log,
    });
    deps.log(formatOk(result));
    return 0;
  } catch (error) {
    deps.error(`pos sync failed: ${safeErrorMessage(error)}`);
    return 1;
  }
}

function formatOk(result: SyncResult): string {
  const counts = result.counts;
  return `pos sync ok mode=${result.mode} shift_ids=${result.shiftIds.join(',')} read=${counts.read} inserted=${counts.inserted} updated=${counts.updated} unchanged=${counts.unchanged} stale=${counts.stale} missing=${counts.missing} shifts=${counts.shifts_upserted}`;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  process.exitCode = await main({
    argv: process.argv.slice(2),
    env: process.env,
    loadToken: () => loadAccessToken(),
    log: (line) => {
      console.log(line);
    },
    error: (line) => {
      console.error(line);
    },
    runSync: async (input) =>
      runPosSync({
        mode: input.mode,
        supabaseUrl: input.supabaseUrl,
        serviceRoleKey: input.serviceRoleKey,
        reader: createPosReader(createPosFirestore(input.token)),
        logger: input.log,
      }),
  });
}
