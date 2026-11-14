export const failureReasons = [
  'error',
  'recompute_limit',
  'critical',
  'escaped',
] as const;

export type FailureReason = (typeof failureReasons)[number];

export const costDispositions = [
  'sale',
  'prepared_waste',
  'none',
  'incomplete',
] as const;

export type CostDisposition = (typeof costDispositions)[number];

export const receiptKinds = ['posting', 'evaluation'] as const;

export type ReceiptKind = (typeof receiptKinds)[number];

export const scopeKinds = ['shift_ids', 'from', 'all'] as const;

export type ScopeKind = (typeof scopeKinds)[number];

export const checklistCodes = [
  'not_activated',
  'missing_observations',
  'unreceipted_outflows',
  'empty_roster',
] as const;

export type ChecklistCode = (typeof checklistCodes)[number];

export type SyncCoverage = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  ordersScopeApplied: boolean;
  scopeKind: ScopeKind | null;
  scopeFrom: string | null;
  transactionsCovered: boolean;
  presentedShiftCount: string;
  legacyDirect: boolean;
};

export type ParkedOrder = {
  orderId: string;
  attempts: string;
  workGeneration: string;
  failedAt: string;
  sqlstate: string | null;
  reason: FailureReason | null;
};

export type ProcessingSummary = {
  activated: boolean;
  pendingCount: string;
  blockedCount: string;
  failedCount: string;
  processedEventCount: string;
  openEventCount: string;
  openSpanCount: string;
  coverage: SyncCoverage | null;
  parked: ParkedOrder[];
  parkedCount: string;
  parkedTruncated: boolean;
};

export type CostLine = {
  itemId: string;
  name: string | null;
  baseUnit: string | null;
  quantity: string | null;
};

export type PostedMovement = {
  movementId: string;
  itemId: string;
  name: string | null;
  movementType: string;
  quantity: string;
  totalCost: string;
  occurredAt: string;
};

export type ReversalRow = {
  movementId: string;
  itemId: string;
  name: string | null;
  movementType: string;
  quantity: string;
  totalCost: string;
  reversesMovementId: string | null;
};

export type AdjustmentRow = {
  movementId: string;
  itemId: string;
  name: string | null;
  quantity: string;
  totalCost: string;
  adjustsMovementId: string | null;
};

export type LossVersion = {
  itemId: string;
  versionId: string;
  lossPct: string;
};

export type ConversionVersion = {
  itemId: string;
  unitCode: string;
  versionId: string;
  factorToBase: string;
};

export type Provenance = {
  mappingVersions: string[];
  recipeVersions: string[];
  packagingVersions: string[];
  lossVersions: LossVersion[];
  conversionVersions: ConversionVersion[];
  algorithmVersion: string;
};

export type CostApplication = {
  id: string;
  receiptKind: ReceiptKind;
  disposition: CostDisposition;
  costInputId: string;
  inputRevision: string;
  snapshotId: string;
  snapshotVersion: string;
  predecessorId: string | null;
  retiredApplicationId: string | null;
  movementOwnerId: string | null;
  occurredAt: string | null;
  shiftId: string | null;
  algorithmVersion: string;
  signature: string;
  createdAt: string;
  lines: CostLine[];
  posted: PostedMovement[];
  provenance: Provenance;
  reversals: ReversalRow[];
  adjustments: AdjustmentRow[];
};

export type CostInput = {
  inputId: string;
  inputRevision: string;
  snapshotId: string;
  snapshotVersion: string;
  missingFromPos: boolean;
  digest: string;
};

export type CostState = {
  disposition: CostDisposition | null;
  latestApplicationId: string | null;
  ownerApplicationId: string | null;
  causes: string[];
};

export type OrderCostDetail = {
  found: boolean;
  orderId: string;
  orderNumber: string | null;
  input: CostInput | null;
  state: CostState | null;
  applications: CostApplication[];
};

export type ChecklistItem = {
  code: ChecklistCode;
  ready: boolean;
  count: string;
};

export type OpeningObservation = {
  openingId: string | null;
  lineNo: string | null;
  quantity: string;
  unit: string;
  unitCost: string;
  occurredAt: string;
  explicitZero: boolean;
};

export type ActivationWrite = {
  requestId: string;
  manifestHash: string;
  explicitZeroItemIds: string[];
};

export type ActivationResult = {
  activated: true;
  stockStartedAt: string | null;
  openingManifestHash: string | null;
};

export type RosterItem = {
  itemId: string;
  name: string;
  baseUnit: string;
  active: boolean;
  missing: boolean;
  openingLineCount: string;
  observation: OpeningObservation | null;
};

export type OpeningReview = {
  activated: boolean;
  stockStartedAt: string | null;
  openingManifestHash: string | null;
  canActivate: boolean;
  checklist: ChecklistItem[];
  roster: RosterItem[];
  nextItemId: string | null;
};

export type CountDerivationRow = {
  id: string;
  expectedQty: string;
  requiredQty: string;
  requiredValue: string;
  causeBatchId: string;
  predecessorId: string | null;
  createdAt: string;
};

export type CountPosting = {
  movementId: string;
  role: 'original' | 'compensation' | 'adjustment';
  movementType: string;
  quantity: string;
  totalCost: string;
  occurredAt: string;
  createdAt: string;
};

export type CountDerivationLine = {
  lineNo: string;
  itemId: string;
  name: string;
  baseUnit: string;
  countedQty: string;
  originalExpectedQty: string;
  originalDeltaQty: string;
  originalDeltaValue: string;
  latestExpectedQty: string;
  latestRequiredQty: string;
  latestRequiredValue: string;
  compensatorQty: string;
  compensatorValue: string;
  originalSurplus: boolean;
  derivedSurplus: boolean;
  derivations: CountDerivationRow[];
  postings: CountPosting[];
};

export type CountDerivation = {
  found: boolean;
  countId: string;
  countedAt: string | null;
  frequency: string | null;
  note: string | null;
  hasSurplus: boolean;
  waitingForSync: boolean;
  waitingForProcessing: boolean;
  lines: CountDerivationLine[];
};

export type DifferenceVector = {
  netSalesDifference: string;
  cogsDifference: string;
  wasteDifference: string;
  countDifference: string;
  profitDifference: string;
};

/** One revision row on a shift. Kinds match `accounting_revision_differences`. */
export type ShiftRevision = {
  causeKind: string;
  sourceAt: string | null;
  isLatest: boolean;
};

export type ShiftAccountingStatus = {
  shiftId: string;
  openedAt: string;
  statusLabel: string;
  revised: boolean;
  causes: string[];
  revisions: ShiftRevision[];
  latestDifference: DifferenceVector;
  cumulativeDifference: DifferenceVector;
};

export function isFailureReason(value: unknown): value is FailureReason {
  return (
    typeof value === 'string' &&
    (failureReasons as readonly string[]).includes(value)
  );
}

export function isCostDisposition(value: unknown): value is CostDisposition {
  return (
    typeof value === 'string' &&
    (costDispositions as readonly string[]).includes(value)
  );
}

export function isReceiptKind(value: unknown): value is ReceiptKind {
  return (
    typeof value === 'string' &&
    (receiptKinds as readonly string[]).includes(value)
  );
}

export function isScopeKind(value: unknown): value is ScopeKind {
  return (
    typeof value === 'string' &&
    (scopeKinds as readonly string[]).includes(value)
  );
}

export function isChecklistCode(value: unknown): value is ChecklistCode {
  return (
    typeof value === 'string' &&
    (checklistCodes as readonly string[]).includes(value)
  );
}
