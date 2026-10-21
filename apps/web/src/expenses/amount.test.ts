import { describe, expect, it } from 'vitest';
import {
  digitRunIgnoredCodePoints,
  driverPay,
  hasLongDigitRun,
  longDigitRunSamples,
  parseHours,
  parseMoney,
  shortDigitRunSamples,
} from '@/expenses/amount';

describe('expense amounts', () => {
  it('accepts Arabic-Indic digits and one decimal comma', () => {
    expect(parseMoney('١٠٠٠')).toEqual({ ok: true, value: '1000.00' });
    expect(parseMoney('12.3.4')).toEqual({ ok: false, reason: 'format' });
    expect(parseMoney('1,50')).toEqual({ ok: true, value: '1.50' });
    expect(parseMoney('۵٫۵')).toEqual({ ok: true, value: '5.50' });
    expect(parseHours('٥٫٥')).toEqual({ ok: true, value: '5.50' });
  });

  it('rejects a zero, a third decimal, and an oversized amount', () => {
    expect(parseMoney('0')).toEqual({ ok: false, reason: 'zero' });
    expect(parseMoney('1.005')).toEqual({ ok: false, reason: 'scale' });
    expect(parseMoney('1000000000000')).toEqual({ ok: false, reason: 'large' });
    expect(parseHours('10000')).toEqual({ ok: false, reason: 'large' });
  });

  it('treats every decimal digit as one run, including the shared separators', () => {
    for (const sample of longDigitRunSamples) {
      expect(hasLongDigitRun(sample)).toBe(true);
    }
    for (const sample of shortDigitRunSamples) {
      expect(hasLongDigitRun(sample)).toBe(false);
    }
    for (const codePoint of digitRunIgnoredCodePoints) {
      expect(
        hasLongDigitRun(`1234${String.fromCodePoint(codePoint)}5678`),
      ).toBe(true);
    }
  });

  it('rounds driver pay half away from zero to the piaster', () => {
    expect(driverPay('5.5', '30')).toEqual({ ok: true, value: '165.00' });
    expect(driverPay('٥٫٥', '٣٠')).toEqual({ ok: true, value: '165.00' });
    expect(driverPay('1.15', '0.10')).toEqual({ ok: true, value: '0.12' });
    expect(driverPay('1.25', '0.10')).toEqual({ ok: true, value: '0.13' });
    expect(driverPay('0.01', '0.01')).toEqual({ ok: false, reason: 'zero' });
  });
});
