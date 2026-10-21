import { describe, expect, it } from 'vitest';
import {
  driverPay,
  hasLongDigitRun,
  parseHours,
  parseMoney,
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

  it('treats separated digits as one phone-like run', () => {
    expect(hasLongDigitRun('01000000000')).toBe(true);
    expect(hasLongDigitRun('010 0000 0000')).toBe(true);
    expect(hasLongDigitRun('010-0000-0000')).toBe(true);
    expect(hasLongDigitRun('010.0000.0000')).toBe(true);
    expect(hasLongDigitRun('٠١٠٠٠٠٠٠٠٠٠')).toBe(true);
    expect(hasLongDigitRun('٠١٠ ٠٠٠٠ ٠٠٠٠')).toBe(true);
    expect(hasLongDigitRun('۰۱۰۰۰۰۰۰۰۰۰')).toBe(true);
    expect(hasLongDigitRun('فاتورة 1234567')).toBe(false);
    expect(hasLongDigitRun('رقم 1234x5678')).toBe(false);
  });

  it('rounds driver pay half away from zero to the piaster', () => {
    expect(driverPay('5.5', '30')).toEqual({ ok: true, value: '165.00' });
    expect(driverPay('٥٫٥', '٣٠')).toEqual({ ok: true, value: '165.00' });
    expect(driverPay('1.15', '0.10')).toEqual({ ok: true, value: '0.12' });
    expect(driverPay('1.25', '0.10')).toEqual({ ok: true, value: '0.13' });
    expect(driverPay('0.01', '0.01')).toEqual({ ok: false, reason: 'zero' });
  });
});
