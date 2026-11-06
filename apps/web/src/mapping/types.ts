export const mapStatuses = ['ready', 'incomplete', 'exception'] as const;

export type MapStatus = (typeof mapStatuses)[number];

export type SizeKey = ['none'] | ['name', string];

export type MappingFamily = 'mapping' | 'exception' | 'option_policy';

export type TargetKind = 'recipe' | 'stock' | 'unmapped' | 'no_stock';

export type OptionPolicy = 'none_expected' | 'exactly_one' | 'additive';

export type OptionScope = 'global' | 'item';

export type TargetMode = 'recipe' | 'stock' | 'unmapped' | 'no_stock' | 'gap';

export type ObservedBase = {
  posItemId: string;
  sizeKey: SizeKey;
  sizeKeyText: string;
  itemName: string;
  saleCount: number;
  lastOrderedAt: string;
  latestOrderId: string;
  latestLineId: string;
  mapStatus: MapStatus;
};

export type ObservedOption = {
  posItemId: string;
  sizeKeyText: string;
  optionValue: string;
  seenCount: number;
};

export type ScheduleVersion = {
  id: string;
  family: MappingFamily;
  effectiveFrom: string;
  effectiveTo: string | null;
  targetKind: TargetKind | null;
  recipeId: string | null;
  stockItemId: string | null;
  quantityPerBasis: string | null;
  unitCode: string | null;
  exceptionReason: string | null;
  optionPolicy: OptionPolicy | null;
};

export type SubjectSchedule = {
  subjectId: string | null;
  token: string;
  emptyToken: string;
  versions: ScheduleVersion[];
};

/** Null is a gap: nothing is in force on the saved interval. */
export type MappingTarget =
  | { kind: 'recipe'; recipeId: string }
  | { kind: 'stock'; stockItemId: string; quantity: string; unit: string }
  | { kind: 'unmapped' }
  | { kind: 'no_stock' };

export type DatedWrite = {
  requestId: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  token: string;
  reason: string | null;
};

export type BaseMappingWrite = DatedWrite & {
  posItemId: string;
  sizeKey: SizeKey;
  target: MappingTarget | null;
};

export type PolicyWrite = DatedWrite & {
  posItemId: string;
  sizeKey: SizeKey;
  policy: OptionPolicy | null;
};

export type ExceptionWrite = DatedWrite & {
  posItemId: string;
  sizeKey: SizeKey;
  exceptionReason: string | null;
};

export type OptionMappingWrite = DatedWrite & {
  scope: OptionScope;
  posItemId: string | null;
  sizeKey: SizeKey | null;
  optionValue: string;
  target: MappingTarget | null;
};

export type CoverageCauses = {
  canceled: number;
  open: number;
  missing: number;
  beforeStockStart: number;
};

export type Coverage = {
  stockStart: string | null;
  eligibleLines: number;
  coveredLines: number;
  readyLines: number;
  incompleteLines: number;
  exceptionLines: number;
  coverage: number | null;
  causes: CoverageCauses;
};

export type Suggestion = {
  recipeId: string;
  name: string;
  via: 'name' | 'binding';
};

export type HistoryRow = {
  id: string;
  family: MappingFamily;
  effectiveFrom: string;
  effectiveTo: string | null;
  targetKind: TargetKind | null;
  recipeId: string | null;
  stockItemId: string | null;
  quantityPerBasis: string | null;
  unitCode: string | null;
  exceptionReason: string | null;
  optionPolicy: OptionPolicy | null;
  superseded: boolean;
};

export type LineIssue = {
  code: string;
  expandIssue: string | null;
};

export type LineResolution = {
  status: MapStatus;
  issues: LineIssue[];
  requirements: { stockItemId: string; baseUnit: string; quantity: string }[];
};

export type MappingCatalog = {
  recipes: { id: string; name: string; kind: 'dish' | 'cooking' }[];
  items: { id: string; name: string; baseUnit: string }[];
  units: { code: string; label: string }[];
  shiftStart: string | null;
};

export type OptionBinding = {
  scope: OptionScope;
  optionValue: string;
  schedule: SubjectSchedule;
};

export type SubjectDetail = {
  schedule: SubjectSchedule;
  options: ObservedOption[];
  optionBindings: OptionBinding[];
  suggestions: Suggestion[];
  history: HistoryRow[];
  optionHistory: { subjectId: string; rows: HistoryRow[] }[];
  resolution: LineResolution;
};

export function isMapStatus(value: string): value is MapStatus {
  return (mapStatuses as readonly string[]).includes(value);
}

export function isMappingFamily(value: string): value is MappingFamily {
  return (
    value === 'mapping' || value === 'exception' || value === 'option_policy'
  );
}

export function isTargetKind(value: string): value is TargetKind {
  return (
    value === 'recipe' ||
    value === 'stock' ||
    value === 'unmapped' ||
    value === 'no_stock'
  );
}

export function isOptionPolicy(value: string): value is OptionPolicy {
  return (
    value === 'none_expected' || value === 'exactly_one' || value === 'additive'
  );
}
