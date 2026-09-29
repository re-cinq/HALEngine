// Structural ports rather than the driver's own types, so `mongodb` never reaches the published declarations.

export interface DeleteOutcome {
  deletedCount: number;
}

export interface CollectionLike<T> {
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: {upsert?: boolean}
  ): Promise<unknown>;
  deleteOne(filter: Record<string, unknown>): Promise<DeleteOutcome>;
  deleteMany(filter: Record<string, unknown>): Promise<DeleteOutcome>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
}

export interface DbLike {
  collection<T>(name: string): CollectionLike<T>;
}

export interface MongoClientLike {
  db(name?: string): DbLike;
  close(): Promise<void>;
}
