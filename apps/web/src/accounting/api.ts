import {
  callFailedMessage,
  mapActivationError,
  readError,
  writeError,
} from '@/accounting/errors';
import {
  runAccountingWork,
  RUN_BUDGET_MS,
  type AccountingCounts,
  type AccountingDb,
  type AccountingOrderRef,
  type AccountingRun,
  type AccountingStatus,
  type AttemptReport,
  type FailureReport,
  type NextWork,
  type RunOutcome,
  zeroAccountingCounts,
} from '@/accounting/run';
import {
  isChecklistCode,
  isCostDisposition,
  isFailureReason,
  isReceiptKind,
  isScopeKind,
  type ChecklistItem,
  type ConversionVersion,
  type CostApplication,
  type CostInput,
  type CostLine,
  type CostState,
  type CountDerivation,
  type CountDerivationLine,
  type CountDerivationRow,
  type CountPosting,
  type DifferenceVector,
  type LossVersion,
  type ActivationResult,
  type ActivationWrite,
  type OpeningObservation,
  type OpeningReview,
  type OrderCostDetail,
  type ParkedOrder,
  type PostedMovement,
  type ProcessingSummary,
  type Provenance,
  type ReversalRow,
  type AdjustmentRow,
  type RosterItem,
  type ShiftAccountingStatus,
  type ShiftRevision,
  type SyncCoverage,
} from '@/accounting/types';
import { genericCatalogError } from '@/items/errors';
import { exactDecimal } from '@/lib/decimal';
import { supabase } from '@/lib/supabase';

const openingPageSize = 100;
const openingMaxPages = 50;
const shiftPageSize = 100;
const shiftMaxPages = 50;

const accountingStatuses = new Set<string>([
  'processed',
  'stale',
  'empty',
  'busy',
  'sync_running',
  'not_activated',
  'critical',
]);

const idleStatuses = new Set<string>(['busy', 'sync_running', 'not_activated']);

const failureReports = new Set<string>([
  'recorded',
  'committed',
  'duplicate',
  'no_work',
  'stale',
  'busy',
]);

const nextStatuses = new Set<string>(['ok', 'empty', 'not_activated']);

const postingRoles = new Set(['original', 'compensation', 'adjustment']);

function appDb() {
  if (!supabase) throw new Error(genericCatalogError);
  return supabase.schema('app');
}

function bad(): never {
  throw new Error(genericCatalogError);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad();
  return value as Record<string, unknown>;
}

function list(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) bad();
  return (value as unknown[]).map(record);
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) bad();
  return value;
}

function looseText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') bad();
  return value.length === 0 ? null : value;
}

function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') bad();
  return value;
}

function digits(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) bad();
  return value;
}

function decimal(value: unknown): string {
  return exactDecimal(value, genericCatalogError);
}

function decimalOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return decimal(value);
}

function sqlstate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[0-9A-Z]{5}$/.test(value)) bad();
  return value;
}

function uuidText(value: unknown): string {
  const id = text(value);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    bad();
  }
  return id;
}

function countField(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    bad();
  }
  return value;
}

function orderRef(value: unknown): AccountingOrderRef | null {
  if (value === null || value === undefined) return null;
  const row = record(value);
  const generation = row.work_generation;
  if (
    typeof row.order_id !== 'string' ||
    row.order_id.length === 0 ||
    row.order_id.length > 1500 ||
    typeof generation !== 'number' ||
    !Number.isInteger(generation) ||
    generation < 1
  ) {
    bad();
  }
  return { orderId: row.order_id, workGeneration: generation };
}

async function readRpc(
  name:
    | 'accounting_processing_summary'
    | 'order_cost_detail'
    | 'opening_activation_review'
    | 'stock_count_derivation_detail'
    | 'list_shift_accounting_status',
  args?: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await appDb().rpc(name, args as never);
  if (error) throw readError(error);
  return data;
}

export function summaryOf(value: unknown): ProcessingSummary {
  const row = record(value);
  const coverage = row.coverage;
  return {
    activated: flag(row.activated),
    pendingCount: digits(row.pending_count),
    blockedCount: digits(row.blocked_count),
    failedCount: digits(row.failed_count),
    processedEventCount: digits(row.processed_event_count),
    openEventCount: digits(row.open_event_count),
    openSpanCount: digits(row.open_span_count),
    coverage: coverage === null ? null : coverageOf(coverage),
    parked: list(row.parked).map(parkedOf),
    parkedCount: digits(row.parked_count),
    parkedTruncated: flag(row.parked_truncated),
  };
}

function coverageOf(value: unknown): SyncCoverage {
  const row = record(value);
  const kind = row.scope_kind;
  if (kind !== null && !isScopeKind(kind)) bad();
  return {
    runId: digits(row.run_id),
    startedAt: text(row.started_at),
    finishedAt: text(row.finished_at),
    ordersScopeApplied: flag(row.orders_scope_applied),
    scopeKind: kind,
    scopeFrom: looseText(row.scope_from),
    transactionsCovered: flag(row.transactions_covered),
    presentedShiftCount: digits(row.presented_shift_count),
    legacyDirect: flag(row.legacy_direct),
  };
}

function parkedOf(row: Record<string, unknown>): ParkedOrder {
  const reason = row.reason;
  if (reason !== null && !isFailureReason(reason)) bad();
  return {
    orderId: text(row.order_id),
    attempts: digits(row.attempts),
    workGeneration: digits(row.work_generation),
    failedAt: text(row.failed_at),
    sqlstate: sqlstate(row.sqlstate),
    reason,
  };
}

function lineOf(row: Record<string, unknown>): CostLine {
  const unit = looseText(row.base_unit);
  if (unit !== null && unit !== 'kg' && unit !== 'piece' && unit !== 'liter') {
    bad();
  }
  return {
    itemId: uuidText(row.item_id),
    name: looseText(row.name),
    baseUnit: unit,
    quantity: decimalOrNull(row.quantity),
  };
}

function postedOf(row: Record<string, unknown>): PostedMovement {
  return {
    movementId: digits(row.movement_id),
    itemId: uuidText(row.item_id),
    name: looseText(row.name),
    movementType: text(row.movement_type),
    quantity: decimal(row.quantity),
    totalCost: decimal(row.total_cost),
    occurredAt: text(row.occurred_at),
  };
}

function reversalOf(row: Record<string, unknown>): ReversalRow {
  return {
    movementId: digits(row.movement_id),
    itemId: uuidText(row.item_id),
    name: looseText(row.name),
    movementType: text(row.movement_type),
    quantity: decimal(row.quantity),
    totalCost: decimal(row.total_cost),
    reversesMovementId:
      row.reverses_movement_id === null
        ? null
        : digits(row.reverses_movement_id),
  };
}

function adjustmentOf(row: Record<string, unknown>): AdjustmentRow {
  return {
    movementId: digits(row.movement_id),
    itemId: uuidText(row.item_id),
    name: looseText(row.name),
    quantity: decimal(row.quantity),
    totalCost: decimal(row.total_cost),
    adjustsMovementId:
      row.adjusts_movement_id === null ? null : digits(row.adjusts_movement_id),
  };
}

function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) bad();
  return value.map(uuidText);
}

function lossOf(row: Record<string, unknown>): LossVersion {
  return {
    itemId: uuidText(row.item_id),
    versionId: uuidText(row.version_id),
    lossPct: decimal(row.loss_pct),
  };
}

function conversionOf(row: Record<string, unknown>): ConversionVersion {
  return {
    itemId: uuidText(row.item_id),
    unitCode: text(row.unit_code),
    versionId: uuidText(row.version_id),
    factorToBase: decimal(row.factor_to_base),
  };
}

function provenanceOf(value: unknown): Provenance {
  const row = record(value);
  return {
    mappingVersions: idsOf(row.mapping_versions),
    recipeVersions: idsOf(row.recipe_versions),
    packagingVersions: idsOf(row.packaging_versions),
    lossVersions: list(row.loss_versions).map(lossOf),
    conversionVersions: list(row.conversion_versions).map(conversionOf),
    algorithmVersion: digits(row.algorithm_version),
  };
}

function applicationOf(row: Record<string, unknown>): CostApplication {
  if (!isReceiptKind(row.receipt_kind) || !isCostDisposition(row.disposition)) {
    bad();
  }
  return {
    id: digits(row.id),
    receiptKind: row.receipt_kind,
    disposition: row.disposition,
    costInputId: digits(row.cost_input_id),
    inputRevision: digits(row.input_revision),
    snapshotId: digits(row.snapshot_id),
    snapshotVersion: digits(row.snapshot_version),
    predecessorId:
      row.predecessor_id === null ? null : digits(row.predecessor_id),
    retiredApplicationId:
      row.retired_application_id === null
        ? null
        : digits(row.retired_application_id),
    movementOwnerId:
      row.movement_owner_id === null ? null : digits(row.movement_owner_id),
    occurredAt: looseText(row.occurred_at),
    shiftId: looseText(row.shift_id),
    algorithmVersion: digits(row.algorithm_version),
    signature: text(row.signature),
    createdAt: text(row.created_at),
    lines: list(row.lines).map(lineOf),
    posted: list(row.posted).map(postedOf),
    provenance: provenanceOf(row.provenance),
    reversals: list(row.reversals).map(reversalOf),
    adjustments: list(row.adjustments).map(adjustmentOf),
  };
}

function inputOf(value: unknown): CostInput | null {
  if (value === null) return null;
  const row = record(value);
  return {
    inputId: digits(row.input_id),
    inputRevision: digits(row.input_revision),
    snapshotId: digits(row.snapshot_id),
    snapshotVersion: digits(row.snapshot_version),
    missingFromPos: flag(row.missing_from_pos),
    digest: text(row.digest),
  };
}

function stateOf(value: unknown): CostState | null {
  if (value === null) return null;
  const row = record(value);
  const disposition = row.disposition;
  if (disposition !== null && !isCostDisposition(disposition)) bad();
  if (!Array.isArray(row.causes)) bad();
  return {
    disposition,
    latestApplicationId:
      row.latest_application_id === null
        ? null
        : digits(row.latest_application_id),
    ownerApplicationId:
      row.owner_application_id === null
        ? null
        : digits(row.owner_application_id),
    causes: row.causes.map((cause) => text(cause)),
  };
}

export function orderCostOf(value: unknown): OrderCostDetail {
  const row = record(value);
  if (!flag(row.found)) {
    return {
      found: false,
      orderId: text(row.order_id),
      orderNumber: null,
      input: null,
      state: null,
      applications: [],
    };
  }
  return {
    found: true,
    orderId: text(row.order_id),
    orderNumber: row.order_number === null ? null : digits(row.order_number),
    input: inputOf(row.input),
    state: stateOf(row.state),
    applications: list(row.applications).map(applicationOf),
  };
}

function observationOf(value: unknown): OpeningObservation | null {
  if (value === null) return null;
  const row = record(value);
  if (row.explicit_zero === true) {
    if (row.opening_id !== null || row.line_no !== null) bad();
    if (decimal(row.quantity) !== '0') bad();
    return {
      openingId: null,
      lineNo: null,
      quantity: '0',
      unit: text(row.unit),
      unitCost: decimal(row.unit_cost),
      occurredAt: text(row.occurred_at),
      explicitZero: true,
    };
  }
  if (row.explicit_zero !== false) bad();
  return {
    openingId: uuidText(row.opening_id),
    lineNo: digits(row.line_no),
    quantity: decimal(row.quantity),
    unit: text(row.unit),
    unitCost: decimal(row.unit_cost),
    occurredAt: text(row.occurred_at),
    explicitZero: false,
  };
}

function rosterOf(row: Record<string, unknown>): RosterItem {
  const unit = text(row.base_unit);
  if (unit !== 'kg' && unit !== 'piece' && unit !== 'liter') bad();
  return {
    itemId: uuidText(row.item_id),
    name: text(row.name),
    baseUnit: unit,
    active: flag(row.active),
    missing: flag(row.missing),
    openingLineCount: digits(row.opening_line_count),
    observation: observationOf(row.observation),
  };
}

function checklistOf(row: Record<string, unknown>): ChecklistItem {
  if (!isChecklistCode(row.code)) bad();
  return {
    code: row.code,
    ready: flag(row.ready),
    count: digits(row.count),
  };
}

export function openingReviewOf(value: unknown): OpeningReview {
  const row = record(value);
  const next = row.next_item_id;
  return {
    activated: flag(row.activated),
    stockStartedAt: looseText(row.stock_started_at),
    openingManifestHash: looseText(row.opening_manifest_hash),
    canActivate: flag(row.can_activate),
    checklist: list(row.checklist).map(checklistOf),
    roster: list(row.roster).map(rosterOf),
    nextItemId: next === null ? null : uuidText(next),
  };
}

function derivationRowOf(row: Record<string, unknown>): CountDerivationRow {
  return {
    id: digits(row.id),
    expectedQty: decimal(row.expected_qty),
    requiredQty: decimal(row.required_qty),
    requiredValue: decimal(row.required_value),
    causeBatchId: uuidText(row.cause_batch_id),
    predecessorId:
      row.predecessor_id === null ? null : digits(row.predecessor_id),
    createdAt: text(row.created_at),
  };
}

function postingOf(row: Record<string, unknown>): CountPosting {
  if (typeof row.role !== 'string' || !postingRoles.has(row.role)) bad();
  return {
    movementId: digits(row.movement_id),
    role: row.role as CountPosting['role'],
    movementType: text(row.movement_type),
    quantity: decimal(row.quantity),
    totalCost: decimal(row.total_cost),
    occurredAt: text(row.occurred_at),
    createdAt: text(row.created_at),
  };
}

function derivationLineOf(row: Record<string, unknown>): CountDerivationLine {
  return {
    lineNo: digits(row.line_no),
    itemId: uuidText(row.item_id),
    name: text(row.name),
    baseUnit: text(row.base_unit),
    countedQty: decimal(row.counted_qty),
    originalExpectedQty: decimal(row.original_expected_qty),
    originalDeltaQty: decimal(row.original_delta_qty),
    originalDeltaValue: decimal(row.original_delta_value),
    latestExpectedQty: decimal(row.latest_expected_qty),
    latestRequiredQty: decimal(row.latest_required_qty),
    latestRequiredValue: decimal(row.latest_required_value),
    compensatorQty: decimal(row.compensator_qty),
    compensatorValue: decimal(row.compensator_value),
    originalSurplus: flag(row.original_surplus),
    derivedSurplus: flag(row.derived_surplus),
    derivations: list(row.derivations).map(derivationRowOf),
    postings: list(row.postings).map(postingOf),
  };
}

export function countDerivationOf(value: unknown): CountDerivation {
  const row = record(value);
  const found = flag(row.found);
  return {
    found,
    countId: uuidText(row.count_id),
    countedAt: found ? text(row.counted_at) : null,
    frequency: found ? text(row.frequency) : null,
    note: looseText(row.note),
    hasSurplus: flag(row.has_surplus),
    waitingForSync: flag(row.waiting_for_sync),
    waitingForProcessing: flag(row.waiting_for_processing),
    lines: found ? list(row.lines).map(derivationLineOf) : [],
  };
}

function differenceOf(value: unknown): DifferenceVector {
  const row = record(value);
  return {
    netSalesDifference: decimal(row.net_sales_difference),
    cogsDifference: decimal(row.cogs_difference),
    wasteDifference: decimal(row.waste_difference),
    countDifference: decimal(row.count_difference),
    profitDifference: decimal(row.profit_difference),
  };
}

const causeCode = /^[a-z0-9_]{1,64}$/;

function revisionsOf(value: unknown): ShiftRevision[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) bad();
  const revisions: ShiftRevision[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.cause_kind !== 'string' || !causeCode.test(row.cause_kind)) {
      continue;
    }
    if (typeof row.is_latest !== 'boolean') continue;
    if (
      row.source_at !== null &&
      row.source_at !== undefined &&
      typeof row.source_at !== 'string'
    ) {
      continue;
    }
    const sourceAt =
      typeof row.source_at === 'string' && row.source_at.length > 0
        ? row.source_at
        : null;
    revisions.push({
      causeKind: row.cause_kind,
      sourceAt,
      isLatest: row.is_latest,
    });
  }
  return revisions;
}

export function shiftStatusOf(value: unknown): ShiftAccountingStatus {
  const row = record(value);
  if (!Array.isArray(row.causes)) bad();
  return {
    shiftId: text(row.shift_id),
    openedAt: text(row.opened_at),
    statusLabel: text(row.status_label),
    revised: flag(row.revised),
    causes: row.causes.filter(
      (cause): cause is string =>
        typeof cause === 'string' && causeCode.test(cause),
    ),
    revisions: revisionsOf(row.revisions),
    latestDifference: differenceOf(row.latest_difference),
    cumulativeDifference: differenceOf(row.cumulative_difference),
  };
}

export function accountingRunOf(value: unknown): AccountingRun {
  const row = record(value);
  if (typeof row.status !== 'string' || !accountingStatuses.has(row.status)) {
    bad();
  }
  const status = row.status as AccountingStatus;
  if (idleStatuses.has(status)) {
    return {
      status,
      counts: zeroAccountingCounts(),
      head: null,
      critical: null,
    };
  }
  if (status === 'stale') {
    return {
      status,
      counts: zeroAccountingCounts(),
      head: orderRef(row.head),
      critical: null,
    };
  }
  const counts: AccountingCounts = {
    processed: countField(row.processed),
    applied: countField(row.applied),
    unchanged: countField(row.unchanged),
    incomplete: countField(row.incomplete),
    none: countField(row.none),
    blocked: countField(row.blocked),
    dispositionPending: countField(row.disposition_pending),
    failed: countField(row.failed),
    remaining: countField(row.remaining),
  };
  const critical = orderRef(row.critical);
  if ((status === 'critical') !== (critical !== null)) bad();
  return { status, counts, head: orderRef(row.head), critical };
}

export function nextWorkOf(value: unknown): NextWork {
  const row = record(value);
  if (typeof row.status !== 'string' || !nextStatuses.has(row.status)) bad();
  const head = orderRef(row.head);
  if ((row.status === 'ok') !== (head !== null)) bad();
  return { status: row.status as NextWork['status'], head };
}

export function failureReportOf(value: unknown): FailureReport {
  const row = record(value);
  if (typeof row.status !== 'string' || !failureReports.has(row.status)) bad();
  return row.status as FailureReport;
}

export function retryResultOf(
  value: unknown,
): 'retried' | 'not_failed' | 'busy' {
  const row = record(value);
  if (
    row.status !== 'retried' &&
    row.status !== 'not_failed' &&
    row.status !== 'busy'
  ) {
    bad();
  }
  return row.status;
}

export async function loadProcessingSummary(): Promise<ProcessingSummary> {
  return summaryOf(await readRpc('accounting_processing_summary'));
}

export async function loadOrderCost(orderId: string): Promise<OrderCostDetail> {
  return orderCostOf(
    await readRpc('order_cost_detail', { p_order_id: orderId }),
  );
}

class ManifestPagesDisagree extends Error {
  constructor() {
    super('manifest pages disagree');
    this.name = 'ManifestPagesDisagree';
  }
}

async function loadOpeningReviewPass(): Promise<OpeningReview> {
  const roster: OpeningReview['roster'] = [];
  let after: string | undefined;
  let token: string | null | undefined;
  for (let index = 0; index < openingMaxPages; index += 1) {
    const page = openingReviewOf(
      await readRpc('opening_activation_review', {
        ...(after ? { p_after_id: after } : {}),
        p_limit: openingPageSize,
      }),
    );
    if (token === undefined) token = page.openingManifestHash;
    else if (page.openingManifestHash !== token)
      throw new ManifestPagesDisagree();
    roster.push(...page.roster);
    if (!page.nextItemId) {
      return {
        ...page,
        roster: [...roster].sort((left, right) =>
          left.name.localeCompare(right.name, 'ar'),
        ),
      };
    }
    after = page.nextItemId;
  }
  throw new Error('القائمة أكبر من اللي ينفع نعرضه');
}

export async function loadOpeningReview(): Promise<OpeningReview> {
  try {
    return await loadOpeningReviewPass();
  } catch (error) {
    if (!(error instanceof ManifestPagesDisagree)) throw error;
  }
  try {
    return await loadOpeningReviewPass();
  } catch (error) {
    if (error instanceof ManifestPagesDisagree) {
      throw new Error('قائمة الافتتاح اتغيرت — راجعها وفعّل تاني', {
        cause: error,
      });
    }
    throw error;
  }
}

export async function loadCountDerivation(
  countId: string,
): Promise<CountDerivation> {
  return countDerivationOf(
    await readRpc('stock_count_derivation_detail', { p_count_id: countId }),
  );
}

export type ShiftStatusLoad = {
  byId: Map<string, ShiftAccountingStatus>;
  capped: boolean;
};

export async function loadShiftStatuses(
  ids: readonly string[],
): Promise<ShiftStatusLoad> {
  const wanted = new Set(ids);
  const byId = new Map<string, ShiftAccountingStatus>();
  if (wanted.size === 0) return { byId, capped: false };
  let afterOpened: string | undefined;
  let afterId: string | undefined;
  for (
    let page = 0;
    page < shiftMaxPages && byId.size < wanted.size;
    page += 1
  ) {
    const data = await readRpc('list_shift_accounting_status', {
      ...(afterOpened && afterId
        ? { p_after_opened_at: afterOpened, p_after_id: afterId }
        : {}),
      p_limit: shiftPageSize,
    });
    if (!Array.isArray(data)) bad();
    const rows = data.map(shiftStatusOf);
    for (const row of rows) {
      if (wanted.has(row.shiftId)) byId.set(row.shiftId, row);
    }
    if (rows.length < shiftPageSize) return { byId, capped: false };
    const last = rows[rows.length - 1];
    if (!last) return { byId, capped: false };
    afterOpened = last.openedAt;
    afterId = last.shiftId;
  }
  return {
    byId,
    capped: [...wanted].some((id) => !byId.has(id)),
  };
}

async function writeRpc(
  name:
    | 'accounting_next_work'
    | 'run_accounting_work'
    | 'record_accounting_call_failure'
    | 'record_accounting_recompute_timeout'
    | 'retry_accounting_work'
    | 'activate_inventory',
  args?: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await appDb().rpc(name, args as never);
  if (error) throw writeError(error);
  return data;
}

export function webAccountingDb(): AccountingDb {
  return {
    async getNextWork() {
      return nextWorkOf(await writeRpc('accounting_next_work'));
    },
    async runAccountingWork(attemptId, _limit, binding) {
      return accountingRunOf(
        await writeRpc('run_accounting_work', {
          p_attempt_id: attemptId,
          p_limit: 1,
          ...(binding
            ? {
                p_order_id: binding.orderId,
                p_work_generation: binding.workGeneration,
              }
            : {}),
        }),
      );
    },
    async recordAccountingCallFailure(attemptId, orderId, workGeneration) {
      return failureReportOf(
        await writeRpc('record_accounting_call_failure', {
          p_attempt_id: attemptId,
          p_order_id: orderId,
          p_work_generation: workGeneration,
        }),
      );
    },
    async recordAccountingRecomputeTimeout(attemptId, orderId, workGeneration) {
      return failureReportOf(
        await writeRpc('record_accounting_recompute_timeout', {
          p_attempt_id: attemptId,
          p_order_id: orderId,
          p_work_generation: workGeneration,
        }),
      );
    },
  };
}

export async function runDeductions(
  onBoundAttempt?: (report: AttemptReport) => void,
): Promise<RunOutcome> {
  return runAccountingWork(webAccountingDb(), {
    budgetMs: RUN_BUDGET_MS,
    clock: () => Date.now(),
    newAttemptId: () => crypto.randomUUID(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onBoundAttempt,
  });
}

export async function recordRunFailure(
  report: AttemptReport,
): Promise<FailureReport> {
  if (report.failureKind === null) {
    throw new Error(callFailedMessage);
  }
  return failureReportOf(
    await writeRpc(
      report.failureKind === 'recompute_timeout'
        ? 'record_accounting_recompute_timeout'
        : 'record_accounting_call_failure',
      {
        p_attempt_id: report.attemptId,
        p_order_id: report.orderId,
        p_work_generation: report.workGeneration,
      },
    ),
  );
}

function activationResultOf(value: unknown): ActivationResult {
  const row = record(value);
  if (!flag(row.activated)) bad();
  return {
    activated: true,
    stockStartedAt: looseText(row.stock_started_at),
    openingManifestHash: looseText(row.opening_manifest_hash),
  };
}

export async function activateInventory(
  action: ActivationWrite,
): Promise<ActivationResult> {
  const { data, error } = await appDb().rpc('activate_inventory', {
    p_request_id: action.requestId,
    p_manifest_hash: action.manifestHash,
    p_explicit_zero_item_ids: action.explicitZeroItemIds,
  });
  if (error) throw mapActivationError(error);
  return activationResultOf(data);
}

export async function retryParkedOrder(
  orderId: string,
): Promise<'retried' | 'not_failed' | 'busy'> {
  return retryResultOf(
    await writeRpc('retry_accounting_work', { p_order_id: orderId }),
  );
}
