/** Synthetic local owner. The default matches supabase/seed.sql and must never be used on a hosted project. */
export const ownerEmail = 'owner@theshark.test';

export const ownerPassword = process.env.E2E_OWNER_PASSWORD ?? 'LocalOwner1234';
