import { describe, expect, it } from 'vitest';
import { assertLocalSupabaseUrl } from './local-guard.ts';
import {
  classifySyncError,
  PosSyncError,
  safeErrorMessage,
  SupabaseRpcError,
  SyncDiagnostic,
  type FieldLabel,
} from './safe-error.ts';
import { isUnknownOutcome } from './supabase-write.ts';

const MARKER = 'SyntheticMarker7f3a';

describe('safeErrorMessage', () => {
  it('redacts access tokens and JWTs and truncates', () => {
    const fakeJwt = 'eyJhbGciOiJub25lIn0.eyJzeW50aGV0aWMiOnRydWV9.synthetic';
    const error = new Error(
      `failed ya29.super-secret-token Bearer ${fakeJwt} ${'x'.repeat(400)}`,
    );
    const message = safeErrorMessage(error);
    expect(message).not.toContain('ya29.');
    expect(message).not.toContain(fakeJwt);
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
      JSON.parse(MARKER);
    } catch (error) {
      parseError = error;
    }
    expect(parseError).toBeInstanceOf(SyntaxError);
    expect(parseError).toHaveProperty(
      'message',
      expect.stringContaining(MARKER),
    );
    expect(safeErrorMessage(parseError)).toBe('sync failed');
  });

  it.each([
    'unexpected SyntheticMarker7f3a',
    'SyntheticMarker7f3a is required',
    'duplicate SyntheticMarker7f3a id',
    'unexpected orderNumber',
    'Unknown mode',
    'Firestore read failed: HTTP 404',
  ])('rejects a plain Error that looks package-owned (%s)', (message) => {
    expect(safeErrorMessage(new Error(message))).toBe('sync failed');
  });

  it.each([
    [new PosSyncError('firestoreReadRefused'), 'Firestore read refused'],
    [
      new PosSyncError('firestoreInvalidResponse'),
      'Firestore read failed: invalid response',
    ],
    [new PosSyncError('firestoreNetwork'), 'Firestore read failed: network'],
    [new PosSyncError('firestoreHttp', 404), 'Firestore read failed: HTTP 404'],
    [new PosSyncError('syncAlreadyRunning'), 'another POS sync is running'],
    [new PosSyncError('unknownMode'), 'Unknown mode'],
    [
      new PosSyncError('unexpectedField', 'orderNumber'),
      'unexpected orderNumber',
    ],
    [new PosSyncError('requiredField', 'timestamp'), 'timestamp is required'],
    [new PosSyncError('duplicateOrder'), 'duplicate order id'],
    [new PosSyncError('nonLocalSupabase'), 'Refusing non-local Supabase URL'],
  ])(
    'renders %s from its package diagnostic even if message text changes',
    (error, expected) => {
      expect(error.message).toBe(expected);
      error.message = MARKER;
      expect(safeErrorMessage(error)).toBe(expected);
    },
  );

  it('checks diagnostic labels against the closed set at runtime', () => {
    const label: string = MARKER;
    const error = new PosSyncError('requiredField', label as FieldLabel);
    expect(error.message).toBe('sync failed');
    expect(safeErrorMessage(error)).toBe('sync failed');
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
    const error = new SupabaseRpcError('http', 400, '23505');
    error.message = `Supabase RPC failed: HTTP 400 ${MARKER}`;
    expect(safeErrorMessage(error)).toBe('Supabase RPC failed: HTTP 400 23505');
    const networkError = new SupabaseRpcError('network');
    networkError.message = MARKER;
    expect(safeErrorMessage(networkError)).toBe('Supabase RPC failed: network');
    expect(
      safeErrorMessage(new SupabaseRpcError('http', 502, `${MARKER}x`)),
    ).toBe('Supabase RPC failed: HTTP 502');
  });

  it('never throws when rendering or classifying errors with hostile getters or proxies', () => {
    const forged = Object.create(SupabaseRpcError.prototype) as object;
    for (const prop of ['kind', 'status', 'sqlstate', 'message']) {
      Object.defineProperty(forged, prop, {
        get() {
          throw new Error(`boom ${prop} ${MARKER}`);
        },
        configurable: true,
      });
    }
    expect(safeErrorMessage(forged)).toBe('sync failed');
    expect(safeErrorMessage(classifySyncError(forged))).toBe('sync failed');
    expect(isUnknownOutcome(forged)).toBe(false);

    const genuine = new SupabaseRpcError('http', 400, '23505');
    for (const prop of ['kind', 'status', 'sqlstate', 'message']) {
      Object.defineProperty(genuine, prop, {
        get() {
          throw new Error(`boom ${prop} ${MARKER}`);
        },
        configurable: true,
      });
    }
    expect(safeErrorMessage(genuine)).toBe(
      'Supabase RPC failed: HTTP 400 23505',
    );
    expect(SyncDiagnostic.render(SyncDiagnostic.fromError(genuine))).toBe(
      'Supabase RPC failed: HTTP 400 23505',
    );
    expect(isUnknownOutcome(genuine)).toBe(false);

    const forgedDiagnostic = Object.create(
      SyncDiagnostic.prototype,
    ) as SyncDiagnostic;
    expect(SyncDiagnostic.is(forgedDiagnostic)).toBe(false);
    expect(SyncDiagnostic.render(forgedDiagnostic)).toBe('sync failed');
    expect(safeErrorMessage(forgedDiagnostic)).toBe('sync failed');

    const hostileProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(`proxy proto ${MARKER}`);
        },
        get() {
          throw new Error(`proxy get ${MARKER}`);
        },
      },
    );
    expect(safeErrorMessage(hostileProxy)).toBe('sync failed');
    expect(safeErrorMessage(classifySyncError(hostileProxy))).toBe(
      'sync failed',
    );
    expect(isUnknownOutcome(hostileProxy)).toBe(false);
    expect(PosSyncError.hasHttpStatus(hostileProxy, 404)).toBe(false);
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
