/** Synthetic local owner for Playwright. Never use these defaults on a hosted project. */
export const ownerEmail = 'owner@theshark.test';

export const ownerPassword = process.env.E2E_OWNER_PASSWORD ?? 'LocalOwner1234';

/**
 * Public demo service-role JWT that `supabase status` prints for the default
 * local JWT secret. Not a secret. Never put this in the Vite app or an env file.
 */
export const localServiceRoleKey =
  process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
