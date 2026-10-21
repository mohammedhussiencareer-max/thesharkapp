import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/database.types';
import { assertLocalSupabaseUrl, developmentSupabaseUrl } from './local-guard';
import { seedSales } from './seed-sales';
import { localServiceRoleKey, ownerEmail, ownerPassword } from './.test-owner';

const localApiUrl = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:55421';

function isExistingUser(error: {
  code?: string;
  message: string;
  status?: number;
}): boolean {
  if (error.code === 'email_exists') return true;
  return (
    error.status === 422 && error.message.toLowerCase().includes('already')
  );
}

export default async function globalSetup(): Promise<void> {
  assertLocalSupabaseUrl(developmentSupabaseUrl());
  assertLocalSupabaseUrl(localApiUrl);

  const client = createClient<Database>(localApiUrl, localServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const created = await client.auth.admin.createUser({
    email: ownerEmail,
    password: ownerPassword,
    email_confirm: true,
  });

  let userId = created.data.user?.id;
  if (created.error || !userId) {
    if (created.error && !isExistingUser(created.error)) throw created.error;
    userId = await findOwnerId(client);
    if (!userId) throw created.error ?? new Error('owner user was not created');
  }

  const saved = await client
    .schema('app')
    .from('owner')
    .upsert({ id: true, user_id: userId }, { onConflict: 'id' });
  if (saved.error) throw saved.error;
  await seedSales(client, localApiUrl);
}

async function findOwnerId(
  client: ReturnType<typeof createClient<Database>>,
): Promise<string | undefined> {
  for (let page = 1; page <= 10; page += 1) {
    const listed = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (listed.error) throw listed.error;
    const existing = listed.data.users.find(
      (user) => user.email?.toLowerCase() === ownerEmail,
    );
    if (existing) return existing.id;
    if (listed.data.users.length < 200) return undefined;
  }
  return undefined;
}
