import { describe, expect, it } from 'vitest';
import { localServiceRoleKey } from './local-supabase.ts';
import { safeErrorMessage } from './safe-error.ts';

describe('safeErrorMessage', () => {
  it('redacts access tokens and JWTs and truncates', () => {
    const error = new Error(
      `failed ya29.super-secret-token Bearer ${localServiceRoleKey} ${'x'.repeat(400)}`,
    );
    const message = safeErrorMessage(error);
    expect(message).not.toContain('ya29.');
    expect(message).not.toContain(localServiceRoleKey);
    expect(message.length).toBeLessThanOrEqual(300);
    expect(safeErrorMessage('nope')).toBe('sync failed');
  });
});
