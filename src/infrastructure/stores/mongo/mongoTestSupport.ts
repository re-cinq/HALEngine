import {randomUUID} from 'node:crypto';
import {MongoMemoryServer} from 'mongodb-memory-server';
import {MongoClient} from 'mongodb';
import type {Collection, Db} from 'mongodb';
import type {MongoSessionDocument} from './mongoSessionDocument.js';

// A real mongod, started once per suite: no cloud account, no Docker, and no double standing in for a database.

const BINARY_DOWNLOAD_MS = 120_000;

export interface MongoHarness {
  db: Db;
  uri: string;
  dbName: string;
  stop: () => Promise<void>;
}

export const TEST_DB_NAME = 'hal-engine-test';

/** Starts a mongod for the surrounding suite and returns the handle its tests read through. */
export async function startMongo(): Promise<MongoHarness> {
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri());
  await client.connect();
  return {
    db: client.db(TEST_DB_NAME),
    uri: server.getUri(),
    dbName: TEST_DB_NAME,
    stop: async () => {
      await client.close();
      await server.stop();
    },
  };
}

/** A collection no other test writes to, so suites never have to clean up after each other. */
export function freshCollection(db: Db): Collection<MongoSessionDocument> {
  return db.collection<MongoSessionDocument>(`sessions_${randomUUID().replace(/-/g, '')}`);
}

/** The timeout the one-time mongod binary download needs, applied to `beforeAll` alone. */
export const MONGO_START_MS = BINARY_DOWNLOAD_MS;

/** Runs a mongod for the surrounding suite and hands each test a collection of its own. */
export function mongoCollection(): () => Collection<MongoSessionDocument> {
  let harness: MongoHarness;
  let collection: Collection<MongoSessionDocument>;

  beforeAll(async () => {
    harness = await startMongo();
  }, MONGO_START_MS);

  afterAll(() => harness.stop());

  beforeEach(() => {
    collection = freshCollection(harness.db);
  });

  return () => collection;
}
