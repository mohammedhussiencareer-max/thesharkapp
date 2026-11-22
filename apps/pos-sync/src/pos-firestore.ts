export type FirestoreRestDocument = {
  name: string;
  updateTime?: string;
  fields?: Record<string, unknown>;
};

export type ListQuery = {
  pageSize: number;
  pageToken?: string;
  orderBy?: 'opening_time' | 'opening_time asc' | 'opening_time desc';
};

export type ListPage = {
  documents: FirestoreRestDocument[];
  nextPageToken?: string;
};

export type TransactionListQuery = {
  pageSize: number;
  pageToken?: string;
};

export type ListCollection =
  'orders' | 'custody_shifts' | 'items' | 'optionGroups';

export type PosFirestore = {
  list(collection: ListCollection, query: ListQuery): Promise<ListPage>;
  listShiftTransactions(
    shiftId: string,
    query: TransactionListQuery,
  ): Promise<ListPage>;
  getShift(id: string): Promise<FirestoreRestDocument | null>;
  queryOrders(body: unknown): Promise<FirestoreRestDocument[]>;
};
