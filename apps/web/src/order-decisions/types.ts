export type Decision = 'made' | 'not_made';

export const decisionClasses = [
  'canceled',
  'missing',
  'full_refund',
  'partial_refund',
  'unresolved_refund',
  'none',
] as const;
export type DecisionClass = (typeof decisionClasses)[number];

export const reviewReasons = [
  'refund_changed',
  'class_changed',
  'items_changed',
  'quantities_changed',
  'unresolved_refund',
] as const;
export type ReviewReason = (typeof reviewReasons)[number];

export type DecisionSource = 'system_default' | 'owner';

export type BasisStatus = 'ready' | 'incomplete' | 'none';

export function isDecision(value: unknown): value is Decision {
  return value === 'made' || value === 'not_made';
}

export function isDecisionClass(value: unknown): value is DecisionClass {
  return (decisionClasses as readonly unknown[]).includes(value);
}

export function isReviewReason(value: unknown): value is ReviewReason {
  return (reviewReasons as readonly unknown[]).includes(value);
}

export function isDecisionSource(value: unknown): value is DecisionSource {
  return value === 'system_default' || value === 'owner';
}

export function isBasisStatus(value: unknown): value is BasisStatus {
  return value === 'ready' || value === 'incomplete' || value === 'none';
}

/** Exact decimal text, never a JS number. */
export type Differences = {
  stockQuantity: string;
  stockValue: string;
  cogs: string;
  waste: string;
  profit: string;
};

export type BasisItem = {
  stockItemId: string;
  name: string;
  baseUnit: string;
  quantity: string;
};

export type RefundRef = {
  shiftId: string;
  txId: string;
  amount: string;
  occurredAt: string;
};

/** Cumulative returned quantity of one stock item, as decimal text. */
export type ReturnedLine = {
  stockItemId: string;
  returned: string;
};

export type HistoryEntry = {
  eventId: number;
  episode: number;
  decision: Decision;
  decisionClass: DecisionClass;
  source: DecisionSource;
  ownerReviewed: boolean;
  reason: string | null;
  createdAt: string;
  returned: ReturnedLine[];
  differences: Differences;
};

export type QueueRow = {
  orderId: string;
  episode: number;
  /** Null when the order no longer cancels, goes missing or has a refund. */
  currentClass: DecisionClass | null;
  decidedClass: DecisionClass;
  reviewReason: ReviewReason | null;
  token: string;
  needsDecision: boolean;
  eventId: number;
  decision: Decision;
  source: DecisionSource;
  ownerReviewed: boolean;
  decisionReason: string | null;
  decidedAt: string;
  orderNumber: number | null;
  orderedAt: string;
  orderStatus: string;
  missingFromPos: boolean;
  orderTotal: string;
  decidedOrderTotal: string;
  refundTotal: string | null;
  decidedRefundTotal: string;
  basisStatus: BasisStatus;
  basisItems: BasisItem[];
  refunds: RefundRef[];
  returned: ReturnedLine[];
  differences: Differences;
  history: HistoryEntry[];
};

export type UnlinkedRefund = {
  shiftId: string;
  txId: string;
  amount: string;
  occurredAt: string;
};

export type QueueFilter = 'pending' | 'all';

export type DecisionWrite = {
  requestId: string;
  orderId: string;
  decision: Decision;
  token: string;
  reason: string | null;
  /** Null keeps the stored quantities; an array replaces them. */
  returned: ReturnedLine[] | null;
};

export type DecisionResult =
  | { status: 'not_activated' }
  | {
      status: 'ok';
      orderId: string;
      eventId: number;
      decision: Decision;
      decisionClass: DecisionClass;
      outcome: string;
      reason: string | null;
      differences: Differences;
    };

/** What the card shows after the last save; it outlives the form's remount. */
export type DecisionNotice =
  | { kind: 'saved'; result: DecisionResult; warning: string | null }
  | { kind: 'failed'; message: string };
