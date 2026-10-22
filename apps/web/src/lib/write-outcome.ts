/**
 * Whether an idempotent write is known to have rolled back.
 *
 * A Postgres code is not proof of rollback. PostgREST can return PGRST001 /
 * PGRST003 after COMMIT (the connection dropped while the client waited) or
 * for a request that never reached the database. The same is true of a
 * missing code, an HTTP failure, and any SQLSTATE not on the allow-list.
 * Those outcomes are unknown: the row might be stored.
 *
 * A code is a definite refusal only when our functions or Postgres raise it
 * inside the transaction, which aborts before COMMIT:
 * - 22xxx data exceptions (22023 from record_sort, 22P02 from a bad cast, …).
 * - 23xxx integrity constraints except 23505. 23505 is the request_id unique
 *   guard: this attempt rolled back, but the winner may already have stored
 *   the id, so the outcome is unknown.
 * - P0001 raise_exception, including the back-dated guard inside the function.
 * - 42501 insufficient_privilege, checked while the transaction is open.
 * - 40001 serialization_failure. Postgres aborts that transaction.
 * - 40P01 deadlock_detected. The victim transaction is aborted.
 * - 55000 object_not_in_prerequisite_state, including the append-only trigger.
 * - 0A000 feature_not_supported, raised while the statement is still running.
 *
 * 57014 query_canceled is unknown. statement_timeout and pg_cancel_backend
 * are held across the commit record and then reported, so the client can see
 * 57014 after the commit is durable. It cannot be shown that 57014 never
 * follows a commit.
 *
 * The first non-empty string `code` within five causes wins. A numeric code
 * is ignored. isUnknownOutcome is the complement of isDefiniteRefusal.
 */

const DATA_EXCEPTION = /^22[0-9A-Z]{3}$/;
const INTEGRITY_CONSTRAINT = /^23[0-9A-Z]{3}$/;

const DEFINITE_SQLSTATES: ReadonlySet<string> = new Set([
  'P0001',
  '42501',
  '40001',
  '40P01',
  '55000',
  '0A000',
]);

function serverCode(error: unknown): string {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return '';
    if (seen.has(current)) return '';
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim() !== '') return code.trim();
    current = (current as { cause?: unknown }).cause;
  }
  return '';
}

export function isDefiniteRefusal(error: unknown): boolean {
  const code = serverCode(error);
  if (code === '23505') return false;
  if (DATA_EXCEPTION.test(code) || INTEGRITY_CONSTRAINT.test(code)) return true;
  return DEFINITE_SQLSTATES.has(code);
}

export function isUnknownOutcome(error: unknown): boolean {
  return !isDefiniteRefusal(error);
}
