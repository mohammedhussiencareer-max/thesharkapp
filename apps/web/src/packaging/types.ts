import type { Json } from '@/lib/database.types';

export type PackagingDecision = 'lines' | 'none';

export type PackagingMode = PackagingDecision | 'gap';

export type PackagingLine = {
  lineNo: number;
  stockItemId: string;
  quantity: string;
  unitCode: string;
  capacityKg: string | null;
};

export type PackagingVersion = {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  decision: PackagingDecision;
  lines: PackagingLine[];
};

export type PackagingSchedule = {
  subjectId: string | null;
  token: string;
  emptyToken: string;
  versions: PackagingVersion[];
};

export type PackagingHistoryRow = PackagingVersion & {
  superseded: boolean;
};

export type PackagingDetail = {
  schedule: PackagingSchedule;
  history: PackagingHistoryRow[];
};

export type PackagingPolicy =
  | { none: true }
  | {
      lines: {
        stock_item_id: string;
        quantity: string;
        unit: string;
        capacity_kg?: string;
      }[];
    };

export type PackagingWrite = {
  requestId: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  token: string;
  reason: string | null;
  policy: PackagingPolicy | null;
};

export type OrderTypePackagingWrite = PackagingWrite & {
  orderType: string | null;
};

export type BasePackagingWrite = PackagingWrite & {
  posItemId: string;
  sizeKey: Json;
};

export type ObservedOrderType = {
  key: string;
  keyText: string;
  label: string | null;
  orderCount: number;
  lastOrderedAt: string;
};

export type PackagingCatalog = {
  items: { id: string; name: string; baseUnit: string }[];
  units: { code: string; label: string }[];
  shiftStart: string | null;
};
