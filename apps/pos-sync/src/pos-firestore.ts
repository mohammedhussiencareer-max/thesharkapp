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

export type PosFirestore = {
  list(
    collection: 'orders' | 'custody_shifts',
    query: ListQuery,
  ): Promise<ListPage>;
  getShift(id: string): Promise<FirestoreRestDocument | null>;
  queryOrders(body: unknown): Promise<FirestoreRestDocument[]>;
};
