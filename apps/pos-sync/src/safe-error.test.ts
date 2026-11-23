import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { localServiceRoleKey } from './local-supabase.ts';
import { assertLocalSupabaseUrl } from './local-guard.ts';
import { STATIC_ERROR_MESSAGES, safeErrorMessage } from './safe-error.ts';
import { SupabaseRpcError } from './supabase-write.ts';

const MARKER = 'SYNTHETIC-MARKER-7f3a';

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

  it('never echoes arbitrary error text', () => {
    const error = new Error(`failed while reading ${MARKER}`);
    expect(safeErrorMessage(error)).toBe('sync failed');
    expect(safeErrorMessage(undefined)).toBe('sync failed');
  });

  it('drops a JSON parse error that quotes response text', () => {
    let parseError: unknown;
    try {
      JSON.parse(`{"name": "${MARKER}"`);
    } catch (error) {
      parseError = error;
    }
    expect(safeErrorMessage(parseError)).toBe('sync failed');
  });

  it('keeps the static messages this package throws', () => {
    for (const message of [
      'Firestore read refused',
      'Firestore read failed: invalid response',
      'Firestore read failed: network',
      'Firestore read failed: HTTP 404',
      'another POS sync is running',
      'Unknown mode',
      'unexpected orderNumber',
      'timestamp is required',
      'duplicate order id',
      'Refusing non-local Supabase URL',
    ]) {
      expect(safeErrorMessage(new Error(message))).toBe(message);
    }
  });

  it('refuses template messages that carry free text', () => {
    expect(safeErrorMessage(new Error(`unexpected ${MARKER} value`))).toBe(
      'sync failed',
    );
    expect(safeErrorMessage(new Error(`${MARKER} x is required`))).toBe(
      'sync failed',
    );
    expect(
      safeErrorMessage(new Error('Firestore read failed: HTTP 9999')),
    ).toBe('sync failed');
  });

  it('reports a Supabase RPC failure by kind, status and SQLSTATE only', () => {
    const error = new SupabaseRpcError(
      `Supabase RPC failed: HTTP 400 ${MARKER}`,
      'http',
      400,
      '23505',
    );
    expect(safeErrorMessage(error)).toBe('Supabase RPC failed: HTTP 400 23505');
    expect(safeErrorMessage(new SupabaseRpcError(MARKER, 'network'))).toBe(
      'Supabase RPC failed: network',
    );
    expect(
      safeErrorMessage(new SupabaseRpcError(MARKER, 'http', 502, `${MARKER}x`)),
    ).toBe('Supabase RPC failed: HTTP 502');
  });
});

describe('STATIC_ERROR_MESSAGES', () => {
  it('lists every literal message this package throws', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const thrown = new Set<string>();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const source = readFileSync(path.join(dir, name), 'utf8');
      for (const match of source.matchAll(
        /new (?:Error|SupabaseRpcError)\(\s*'([^']*)'/g,
      )) {
        thrown.add(match[1] as string);
      }
    }
    expect(thrown.size).toBeGreaterThan(40);
    const missing = [...thrown].filter((m) => !STATIC_ERROR_MESSAGES.has(m));
    expect(missing).toEqual([]);
  });
});

describe('assertLocalSupabaseUrl', () => {
  it('never echoes the refused URL', () => {
    for (const url of [
      `http://user:${MARKER}@127.0.0.1:54321/`,
      `https://${MARKER}.example.com/`,
      `not a url ${MARKER}`,
      `http://127.0.0.1:54321/?key=${MARKER}`,
    ]) {
      expect(() => assertLocalSupabaseUrl(url)).toThrow(
        /^Refusing non-local Supabase URL$/,
      );
    }
  });
});
