import { describe, expect, it } from 'vitest';
import {
  isDefiniteRefusal,
  isUnknownOutcome,
  isPayloadRefusal,
} from '@/lib/write-outcome';

const definiteSqlStates = [
  '22023',
  '22007',
  '22P02',
  '23502',
  '23503',
  '23514',
  '23P01',
  'P0001',
  '42501',
  '40001',
  '40P01',
  '55000',
  '0A000',
] as const;

const unknownSqlStates = [
  '23505',
  '57014',
  'PGRST001',
  'PGRST003',
  '08006',
  'XX000',
] as const;

function expectOutcome(error: unknown, definite: boolean, label: string) {
  expect(isDefiniteRefusal(error), label).toBe(definite);
  expect(isUnknownOutcome(error), label).toBe(!definite);
}

describe('write outcome', () => {
  it('releases a replay only on a refusal the payload itself causes', () => {
    for (const code of ['22023', '22P02', '23514', 'P0001', '0A000']) {
      expect(isPayloadRefusal({ code })).toBe(true);
    }
    for (const code of ['42501', '40001', '40P01', '55000', '23505', '57014']) {
      expect(isPayloadRefusal({ code })).toBe(false);
    }
    expect(isPayloadRefusal({ code: 'PGRST003' })).toBe(false);
    expect(isPayloadRefusal(new Error('Failed to fetch'))).toBe(false);
  });

  it('treats allow-listed in-transaction SQLSTATEs as definite refusals', () => {
    for (const code of definiteSqlStates) {
      expectOutcome(
        { code, message: 'refused inside the transaction' },
        true,
        code,
      );
    }
    expectOutcome(
      new Error('back-dated', {
        cause: {
          code: 'P0001',
          message: 'back-dated movement not supported yet',
        },
      }),
      true,
      'P0001 cause',
    );
    expectOutcome(
      { code: '  22023  ', message: 'padded' },
      true,
      'padded 22023',
    );
    expectOutcome(
      { code: '', cause: { code: '23503', message: 'foreign key' } },
      true,
      'empty code then 23503',
    );
  });

  it('treats every other code as unknown, including a cancel after commit', () => {
    for (const code of unknownSqlStates) {
      expectOutcome({ code, message: 'not proof of rollback' }, false, code);
    }
    expectOutcome(
      new Error('duplicate', {
        cause: { code: '23505', message: 'duplicate key' },
      }),
      false,
      '23505 cause',
    );
    expectOutcome(
      new Error('wrapped', {
        cause: { code: 'PGRST003', message: 'timed out' },
      }),
      false,
      'PGRST003 cause',
    );
  });

  it('treats an empty code as unknown', () => {
    expectOutcome({ code: '', message: 'empty' }, false, 'empty code');
    expectOutcome({ code: '   ', message: 'blank' }, false, 'blank code');
    expectOutcome({ message: 'no code' }, false, 'missing code');
  });

  it('treats an Error without a code as unknown', () => {
    expectOutcome(new Error('timeout'), false, 'Error');
    expectOutcome(new TypeError('Failed to fetch'), false, 'TypeError');
    expectOutcome('network down', false, 'string');
    expectOutcome(null, false, 'null');
    expectOutcome({ code: 22023 }, false, 'numeric code');
  });

  it('treats an unknown SQLSTATE as unknown', () => {
    expectOutcome(
      { code: '08006', message: 'connection failure' },
      false,
      '08006',
    );
    expectOutcome({ code: '57P01', message: 'admin shutdown' }, false, '57P01');
    expectOutcome({ code: 'XX000', message: 'internal error' }, false, 'XX000');
  });

  it('does not loop on a cyclic cause', () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expectOutcome(error, false, 'cycle');
  });
});
