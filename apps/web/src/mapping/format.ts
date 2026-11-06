import type { SchedulePoint } from '@/items/effective';
import type {
  Coverage,
  MapStatus,
  ObservedBase,
  ScheduleVersion,
  SizeKey,
} from '@/mapping/types';

export function sizeLabel(key: SizeKey): string {
  return key[0] === 'none' ? 'من غير حجم' : key[1];
}

export function subjectTitle(base: ObservedBase): string {
  const name = base.itemName.trim();
  return name.length > 0 ? name : base.posItemId;
}

const statusRank: Record<MapStatus, number> = {
  incomplete: 0,
  exception: 1,
  ready: 2,
};

/** Unmapped subjects first. The keyset read stays ordered by stable text keys. */
export function sortBases(rows: readonly ObservedBase[]): ObservedBase[] {
  return [...rows].sort((left, right) => {
    const status = statusRank[left.mapStatus] - statusRank[right.mapStatus];
    if (status !== 0) return status;
    const name = subjectTitle(left).localeCompare(subjectTitle(right), 'ar');
    if (name !== 0) return name;
    return left.sizeKeyText.localeCompare(right.sizeKeyText);
  });
}

/** Null coverage is an empty denominator and is shown as an em dash. */
export function coverageText(coverage: Coverage): string {
  if (coverage.coverage === null || coverage.eligibleLines === 0) return '—';
  return `${coverage.coveredLines} من ${coverage.eligibleLines}`;
}

export function familyPoints(
  versions: readonly ScheduleVersion[],
  family: ScheduleVersion['family'],
): SchedulePoint[] {
  return versions
    .filter((version) => version.family === family)
    .map((version) => ({
      effectiveFrom: version.effectiveFrom,
      effectiveTo: version.effectiveTo,
    }));
}

export function coverAt<T extends SchedulePoint & { id: string }>(
  versions: readonly T[],
  atMs: number,
): T | null {
  let found: T | null = null;
  let foundFrom = Number.NEGATIVE_INFINITY;
  for (const version of versions) {
    const from = Date.parse(version.effectiveFrom);
    const to = version.effectiveTo ? Date.parse(version.effectiveTo) : null;
    if (Number.isNaN(from) || from > atMs) continue;
    if (to !== null && !(atMs < to)) continue;
    if (from >= foundFrom) {
      found = version;
      foundFrom = from;
    }
  }
  return found;
}

const quantityPattern = /^\d+(\.\d+)?$/;

export function quantityError(value: string): string | null {
  const text = value.trim();
  if (!quantityPattern.test(text) || text.length > 40)
    return 'الكمية مش مظبوطة';
  if (!text.split('').some((char) => char >= '1' && char <= '9')) {
    return 'الكمية لازم تكون أكبر من صفر';
  }
  return null;
}
