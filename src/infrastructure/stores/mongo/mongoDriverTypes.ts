// Structural ports rather than the driver's own types, so `mongodb` never reaches the published declarations.

export interface DeleteOutcome {
  deletedCount: number;
}

export interface FindOneOptions {
  sort?: Record<string, 1 | -1>;
  projection?: Record<string, 0 | 1>;
}

/** `sort` and `limit` ride on the options rather than a chained cursor, so the port stays one method wide. */
export interface FindManyOptions extends FindOneOptions {
  limit?: number;
}

export interface CursorLike<T> {
  toArray(): Promise<T[]>;
}

export interface CollectionLike<T> {
  findOne(filter: Record<string, unknown>, options?: FindOneOptions): Promise<T | null>;
  /** Optional, so an adapter written before conversation lists existed still satisfies this port; `listFor` needs it. */
  find?(filter: Record<string, unknown>, options?: FindManyOptions): CursorLike<T>;
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
