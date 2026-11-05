import { describe, expect, it } from 'vitest';
import { versionAt } from '@/recipes/schedule';
import { validateRecipeName } from '@/recipes/validation';
import type { RecipeVersion } from '@/recipes/types';

function version(id: string, from: string, to: string | null): RecipeVersion {
  return {
    id,
    effectiveFrom: from,
    effectiveTo: to,
    batchQty: null,
    batchUnit: null,
    lines: [],
  };
}

const versions = [
  version('a', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
  version('b', '2026-03-01T00:00:00.000Z', null),
];

describe('versionAt', () => {
  it('finds the version covering an instant', () => {
    expect(
      versionAt(versions, Date.parse('2026-01-15T00:00:00.000Z'))?.id,
    ).toBe('a');
    expect(
      versionAt(versions, Date.parse('2026-09-01T00:00:00.000Z'))?.id,
    ).toBe('b');
  });

  it('treats the end as exclusive and the start as inclusive', () => {
    expect(
      versionAt(versions, Date.parse('2026-02-01T00:00:00.000Z')),
    ).toBeNull();
    expect(
      versionAt(versions, Date.parse('2026-03-01T00:00:00.000Z'))?.id,
    ).toBe('b');
  });

  it('returns null in a gap and before the first version', () => {
    expect(
      versionAt(versions, Date.parse('2026-02-15T00:00:00.000Z')),
    ).toBeNull();
    expect(
      versionAt(versions, Date.parse('2025-12-31T00:00:00.000Z')),
    ).toBeNull();
    expect(versionAt([], 0)).toBeNull();
  });
});

describe('validateRecipeName', () => {
  it('accepts 1 to 120 characters after trimming', () => {
    expect(validateRecipeName(' صلصة ')).toBeNull();
    expect(validateRecipeName('ص'.repeat(120))).toBeNull();
  });

  it('rejects an empty or too long name', () => {
    expect(validateRecipeName('   ')).not.toBeNull();
    expect(validateRecipeName('ص'.repeat(121))).not.toBeNull();
  });
});
