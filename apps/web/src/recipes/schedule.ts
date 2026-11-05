import type { RecipeVersion } from '@/recipes/types';

export function versionAt(
  versions: readonly RecipeVersion[],
  atMs: number,
): RecipeVersion | null {
  let found: RecipeVersion | null = null;
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
