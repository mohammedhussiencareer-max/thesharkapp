import { describe, expect, it } from 'vitest';
import { historyVersionColumns, readMappingQuantity } from '@/mapping/api';

const text = '0.0000004999999999999999999';

describe('mapping quantities', () => {
  it('keeps a decimal that a JSON number would round', () => {
    expect(Number(text)).toBe(0.0000005);
    expect(readMappingQuantity(text)).toBe(text);
    expect(readMappingQuantity(null)).toBeNull();
    expect(() => readMappingQuantity(Number(text))).toThrow();
  });

  it('reads history quantities from a text cast', () => {
    expect(historyVersionColumns).toContain(
      'quantity_per_basis_text:quantity_per_basis::text',
    );
  });
});
