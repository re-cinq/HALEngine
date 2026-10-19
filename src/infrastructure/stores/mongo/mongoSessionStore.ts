import type {ChatSession} from '../../../types/session.js';
import type {
  SessionCreateOptions,
  SessionCursor,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from '../../../types/sessionStore.js';
import {StoreCannotList} from '../../../types/sessionStore.js';
import type {CollectionLike, MongoClientLike} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';
import {persistedFields, toChatSession, toLabelledSummary, toSessionSummary} from './mongoSessionDocument.js';
import {cappedLimit, cursorAt} from '../sessionListWindow.js';
import {log} from '../../../shared/logger.js';

const DEFAULT_COLLECTION_NAME = 'hal_sessions';
// Entries are left out so a page of summaries never carries a conversation out of the database.
const SUMMARY_FIELDS = {_id: 1, createdAt: 1, updatedAt: 1, entryCount: 1} as const;
// The first element and no more, so a labelled page still leaves every entry after the opening question behind.
const LABELLED_FIELDS = {...SUMMARY_FIELDS, entries: {$slice: 1}} as const;
// Eight hours, matching InMemorySessionStore: a bound on the cache in front of the collection, not a retention period.
const DEFAULT_MAX_AGE_MS = 8 * 60 * 60 * 1000;

interface SharedOptions {
  collectionName?: string;
  now?: () => Date;
  maxAgeMs?: number;
}

export type MongoSessionStoreOptions = SharedOptions &
  (
    | {collection: CollectionLike<MongoSessionDocument>}
    | {client: MongoClientLike; dbName: string}
    | {url: string; dbName: string}
  );

interface CachedSession {
  session: ChatSession;
  cachedAt: number;
}

export class MongoSessionStore implements SessionStore {
  private readonly cache = new Map<string, CachedSession>();
  // Only reads still waiting on the collection, so it is bounded by concurrency rather than by every erasure ever made.
  private readonly inFlightGets = new Map<symbol, string>();
  private readonly options: MongoSessionStoreOptions;
  private readonly now: () => Date;
  private readonly maxAgeMs: number;
  private opened: Promise<CollectionLike<MongoSessionDocument>> | undefined;
  private owned: MongoClientLike | undefined;

  constructor(options: MongoSessionStoreOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  async create(sessionId: string, userId: string | number, options?: SessionCreateOptions): Promise<ChatSession> {
    const session: ChatSession = {
      sessionId,
      userId,
      entries: [],
      authHeaders: options?.authHeaders,
      workspaceId: options?.workspaceId,
    };
    const collection = await this.collection();
    const startedAt = this.now();
    await collection.updateOne(
      {_id: sessionId},
      {$set: {...persistedFields(session), createdAt: startedAt, updatedAt: startedAt}},
      {upsert: true}
    );

    // Cached only once the write landed: a failing database would otherwise fill memory with sessions it never stored.
    this.remember(sessionId, session);
    return session;
  }

  async get(sessionId: string): Promise<ChatSession | undefined> {
    const cached = this.cache.get(sessionId);
    if (cached !== undefined && !this.hasAged(cached)) return cached.session;
    // Dropped on a stale read too: a document erased elsewhere would otherwise leave its entry cached for good.
    this.cache.delete(sessionId);

    const read = Symbol(sessionId);
    this.inFlightGets.set(read, sessionId);
    try {
      const collection = await this.collection();
      const document = await collection.findOne({_id: sessionId});
      if (document === null) return undefined;

      const session = toChatSession(document);
      // An erasure that landed while this read was waiting withdrew it, so what it read is returned but never cached.
      if (this.inFlightGets.has(read)) this.remember(sessionId, session);
      return session;
    } finally {
      this.inFlightGets.delete(read);
    }
  }

  // The consumer's erasure primitive, which the engine never calls: it removes the document, not just the cache.
  delete(sessionId: string): Promise<boolean> {
    return this.eraseConversation(sessionId);
  }

  // The engine evicts only a session no client ever received, so its document holds nothing worth keeping.
  evict(sessionId: string): Promise<boolean> {
    return this.eraseConversation(sessionId);
  }

  async count(): Promise<number> {
    const collection = await this.collection();
    return collection.countDocuments();
  }

  // Empties the cache alone; eraseAll is the durable wipe, so neither can be reached by accident.
  clear(): void {
    this.cache.clear();
  }

  // After an erasure the REST router's own Map still answers GET requests; its next message writes nothing here.
  async save(session: ChatSession): Promise<void> {
    const collection = await this.collection();
    const result = (await collection.updateOne(
      {_id: session.sessionId},
      {$set: {...persistedFields(session), updatedAt: this.now()}},
      {upsert: false}
    )) as {matchedCount?: number} | undefined;
    // A caller saving its own copy, as the REST router does, leaves the cached object behind what was just written.
    if (this.cache.get(session.sessionId)?.session !== session) this.forget([session.sessionId]);
    // No id in the line: the conversation it names may be one an erasure request just removed.
    if (result?.matchedCount === 0) {
      log.warn('session', 'save found no document');
    }
  }

  /** One query, filtered on the user in the database and sorted on the index `latestFor` already needs. */
  async listFor(userId: string | number, options?: SessionListOptions): Promise<SessionSummary[]> {
    const limit = cappedLimit(options?.limit);
    // Never issued as a query: mongo reads `limit: 0` as no limit at all, which is the opposite of what it asks for.
    if (limit === 0) return [];

    const collection = await this.collection();
    if (collection.find === undefined) {
      throw new StoreCannotList('The collection this store was built on implements no find');
    }

    const preview = options?.preview === true;
    const documents = await collection
      .find(olderThan(userId, options?.before), {
        sort: {updatedAt: -1, _id: -1},
        limit,
        projection: preview ? LABELLED_FIELDS : SUMMARY_FIELDS,
      })
      .toArray();
    return documents.map(preview ? toLabelledSummary : toSessionSummary);
  }

  /** The user's most recently saved conversation, by `updatedAt`, read through `get` so a live one is the object its running turn writes to. */
  async latestFor(userId: string | number): Promise<ChatSession | undefined> {
    const collection = await this.collection();
    const latest = await collection.findOne({userId}, {sort: {updatedAt: -1, _id: -1}, projection: {_id: 1}});
    return latest === null ? undefined : this.get(latest._id);
  }

  /** Erases one conversation permanently and drops it from the cache. */
  async eraseConversation(sessionId: string): Promise<boolean> {
    const collection = await this.collection();
    const {deletedCount} = await collection.deleteOne({_id: sessionId});
    // After the delete, not before: a read that began while it was pending would otherwise cache the doomed document.
    this.forget([sessionId]);
    return deletedCount > 0;
  }

  /** Erases every conversation created strictly before `cutoff`, and returns how many went. */
  async eraseOlderThan(cutoff: Date): Promise<number> {
    const collection = await this.collection();
    const older = (await collection.find?.({createdAt: {$lt: cutoff}}, {projection: {_id: 1}})?.toArray()) ?? [];
    const ids = older.map(d => d._id);
    const {deletedCount} = await collection.deleteMany({createdAt: {$lt: cutoff}});
    this.forget(ids);
    return deletedCount;
  }

  /** Erases every conversation this store can see. */
  async eraseAll(): Promise<number> {
    const collection = await this.collection();
    const {deletedCount} = await collection.deleteMany({});
    this.cache.clear();
    this.inFlightGets.clear();
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

  // Dropping a stale entry erases nothing: the collection is the truth and the next get reloads from it.
  private remember(sessionId: string, session: ChatSession): void {
    for (const [cachedId, cached] of this.cache) {
      if (!this.hasAged(cached)) break;
      this.cache.delete(cachedId);
    }
    // Deleted first: `set` on an existing key keeps its old position, which would break the sweep's age order.
    this.cache.delete(sessionId);
    this.cache.set(sessionId, {session, cachedAt: this.now().getTime()});
  }

  // Drops the cache entries and withdraws every read still waiting on them, so none can re-cache an erased session.
  private forget(sessionIds: string[]): void {
    const erased = new Set(sessionIds);
    for (const id of erased) this.cache.delete(id);
    for (const [read, id] of this.inFlightGets) {
      if (erased.has(id)) this.inFlightGets.delete(read);
    }
  }

  private hasAged(cached: CachedSession): boolean {
    return this.now().getTime() - cached.cachedAt > this.maxAgeMs;
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

// The id breaks a tie on updatedAt, so two conversations saved in the same millisecond cannot straddle a page boundary.
function olderThan(userId: string | number, before: SessionCursor | undefined): Record<string, unknown> {
  if (before === undefined) return {userId};
  // A Date, whatever the caller held: a string compares against no BSON date, so a JSON cursor would quietly match none.
  const updatedAt = new Date(cursorAt(before));
  return {userId, $or: [{updatedAt: {$lt: updatedAt}}, {updatedAt, _id: {$lt: before.sessionId}}]};
}

/** Builds a MongoDB-backed session store from a collection, a client, or a connection URL. */
export function createMongoSessionStore(options: MongoSessionStoreOptions): MongoSessionStore {
  return new MongoSessionStore(options);
}

function namedCollection(client: MongoClientLike, dbName: string, name: string): CollectionLike<MongoSessionDocument> {
  const database = client.db(dbName);
  return database.collection<MongoSessionDocument>(name);
}
