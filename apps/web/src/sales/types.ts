export type ShiftSummary = {
  shiftId: string;
  openedAt: string;
  closedAt: string | null;
  isActive: boolean;
  ordersComplete: number;
  grossSales: string;
  refunds: string;
  netSales: string;
  ordersCanceled: number;
  ordersOpen: number;
  ordersMissing: number;
  drawerTotal: string | null;
  drawerDifference: string | null;
  unknownTx: number;
};

export type SalesOrderLine = {
  lineId: string;
  itemName: string | null;
  sizeName: string | null;
  quantity: string;
  weightedQty: string | null;
  weightedUnit: string | null;
  lineTotal: string;
  optionValues: string[];
};

export type SalesOrder = {
  id: string;
  orderNumber: number | null;
  orderedAt: string;
  orderType: string | null;
  paymentType: string | null;
  status: string;
  missingFromPos: boolean;
  total: string;
  refunded: string;
  lines: SalesOrderLine[];
};

export type ShiftDetail = {
  summary: ShiftSummary;
  orders: SalesOrder[];
};

export type SalesHome = {
  shifts: ShiftSummary[];
  lastSyncAt: string | null;
};
