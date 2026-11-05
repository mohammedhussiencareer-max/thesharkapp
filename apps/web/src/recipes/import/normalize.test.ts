import { describe, expect, it } from 'vitest';
import { collapseSpaces, normalizeName } from '@/recipes/import/normalize';

describe('normalizeName', () => {
  it('trims and collapses spaces, including non-breaking and zero-width ones', () => {
    expect(normalizeName('  زيت    ذرة‏ ')).toBe('زيت ذرة');
    expect(collapseSpaces('  أ   ب  ')).toBe('أ ب');
  });

  it('removes tatweel and diacritics', () => {
    expect(normalizeName('طمـــاطم')).toBe('طماطم');
    expect(normalizeName('زَيْت')).toBe('زيت');
  });

  it('folds every alef form to a bare alef', () => {
    const forms = ['أرز', 'إرز', 'آرز', 'ٱرز'];
    for (const form of forms) expect(normalizeName(form)).toBe('ارز');
  });

  it('folds alef maksura into yeh', () => {
    expect(normalizeName('مللى')).toBe('مللي');
    expect(normalizeName('الرسبى ')).toBe(normalizeName('الرسبي'));
  });

  it('keeps teh marbuta and heh distinct', () => {
    expect(normalizeName('صلصة')).not.toBe(normalizeName('صلصه'));
    expect(normalizeName('صلصة')).toBe('صلصة');
    expect(normalizeName('صلصه')).toBe('صلصه');
  });

  it('does not fold anything else', () => {
    expect(normalizeName('ؤ')).toBe('ؤ');
    expect(normalizeName('ئ')).toBe('ئ');
    expect(normalizeName('Salt 5')).toBe('Salt 5');
  });
});
