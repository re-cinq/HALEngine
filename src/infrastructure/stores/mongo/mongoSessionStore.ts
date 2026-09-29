import type {ChatSession} from '../../../types/session.js';
import type {SessionCreateOptions, SessionStore} from '../../../types/sessionStore.js';
import type {CollectionLike, MongoClientLike} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';
import {persistedFields, toChatSession} from './mongoSessionDocument.js';

const DEFAULT_COLLECTION_NAME = 'hal_sessions';

interface SharedOptions {
  collectionName?: string;
  now?: () => Date;
}

export type MongoSessionStoreOptions = SharedOptions &
  (
    | {collection: CollectionLike<MongoSessionDocument>}
    | {client: MongoClientLike; dbName: string}
    | {url: string; dbName: string}
  );

export class MongoSessionStore implements SessionStore {
  private readonly cache = new Map<string, ChatSession>();
  private readonly options: MongoSessionStoreOptions;
  private readonly now: () => Date;
  private opened: Promise<CollectionLike<MongoSessionDocument>> | undefined;
  private owned: MongoClientLike | undefined;

  constructor(options: MongoSessionStoreOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  async create(sessionId: string, userId: string | number, options?: SessionCreateOptions): Promise<ChatSession> {
    const session: ChatSession = {
      sessionId,
      userId,
      entries: [],
      authHeaders: options?.authHeaders,
      workspaceId: options?.workspaceId,
    };
    this.cache.set(sessionId, session);

    const collection = await this.collection();
    const startedAt = this.now();
    await collection.updateOne(
      {_id: sessionId},
      {$set: {...persistedFields(session), createdAt: startedAt, updatedAt: startedAt}},
      {upsert: true}
    );
    return session;
  }

  async get(sessionId: string): Promise<ChatSession | undefined> {
    const cached = this.cache.get(sessionId);
    if (cached !== undefined) return cached;

    const collection = await this.collection();
    const document = await collection.findOne({_id: sessionId});
    if (document === null) return undefined;

    const session = toChatSession(document);
    this.cache.set(sessionId, session);
    return session;
  }

  // Eviction, not erasure: the document survives and the next get reloads it.
  delete(sessionId: string): boolean {
    return this.cache.delete(sessionId);
  }

  evict(sessionId: string): boolean {
    return this.cache.delete(sessionId);
  }

  async count(): Promise<number> {
    const collection = await this.collection();
    return collection.countDocuments();
  }

  // Empties the cache alone; eraseAll is the durable wipe, so neither can be reached by accident.
  clear(): void {
    this.cache.clear();
  }

  async save(session: ChatSession): Promise<void> {
    const collection = await this.collection();
    await collection.updateOne(
      {_id: session.sessionId},
      {$set: {...persistedFields(session), updatedAt: this.now()}, $setOnInsert: {createdAt: this.now()}},
      {upsert: true}
    );
  }

  /** Erases one conversation permanently and drops it from the cache. */
  async eraseConversation(sessionId: string): Promise<boolean> {
    this.cache.delete(sessionId);
    const collection = await this.collection();
    const {deletedCount} = await collection.deleteOne({_id: sessionId});
    return deletedCount > 0;
  }

  /** Erases every conversation created strictly before `cutoff`, and returns how many went. */
  async eraseOlderThan(cutoff: Date): Promise<number> {
    this.cache.clear();
    const collection = await this.collection();
    const {deletedCount} = await collection.deleteMany({createdAt: {$lt: cutoff}});
    return deletedCount;
  }

  /** Erases every conversation this store can see. */
  async eraseAll(): Promise<number> {
    this.cache.clear();
    const collection = await this.collection();
    const {deletedCount} = await collection.deleteMany({});
    return deletedCount;
  }

  /** Closes the driver only when this store opened it; a supplied client stays the caller's to close. */
  async close(): Promise<void> {
    this.cache.clear();
    if (this.owned === undefined) return;

    await this.owned.close();
    this.owned = undefined;
    this.opened = undefined;
  }

  private collection(): Promise<CollectionLike<MongoSessionDocument>> {
    this.opened ??= this.open();
    return this.opened;
  }

  private async open(): Promise<CollectionLike<MongoSessionDocument>> {
    const options = this.options;
    if ('collection' in options) return options.collection;

    const name = options.collectionName ?? DEFAULT_COLLECTION_NAME;
    if ('client' in options) return namedCollection(options.client, options.dbName, name);

    // Imported here rather than at the top, so a consumer who installs no driver can still load this package.
    const {MongoClient} = await import('mongodb');
    const client = new MongoClient(options.url) as unknown as MongoClientLike;
    this.owned = client;
    return namedCollection(client, options.dbName, name);
  }
}

/** Builds a MongoDB-backed session store from a collection, a client, or a connection URL. */
export function createMongoSessionStore(options: MongoSessionStoreOptions): MongoSessionStore {
  return new MongoSessionStore(options);
}

function namedCollection(client: MongoClientLike, dbName: string, name: string): CollectionLike<MongoSessionDocument> {
  const database = client.db(dbName);
  return database.collection<MongoSessionDocument>(name);
}
