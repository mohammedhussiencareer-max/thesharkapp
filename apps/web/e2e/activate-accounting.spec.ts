import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/database.types';
import { localServiceRoleKey } from './.test-owner';
import { test } from './fixtures';
import { assertLocalSupabaseUrl } from './local-guard';
import { seedOrderDecisions } from './seed-order-decisions';

/**
 * Records activation and drains the decision fixture after the dormant spec.
 * The seeded order ids are written for the ledger project, because that
 * worker does not inherit this process's environment.
 */
test('records activation and drains the decision fixture', async ({
  supabaseUrl,
}) => {
  test.setTimeout(120_000);
  assertLocalSupabaseUrl(supabaseUrl);
  const client = createClient<Database>(supabaseUrl, localServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  await seedOrderDecisions(client, supabaseUrl);
});
