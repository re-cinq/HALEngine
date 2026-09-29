import {MongoClient} from 'mongodb';
import {MongoSessionStore, createMongoSessionStore} from './mongoSessionStore.js';
import {MONGO_START_MS, startMongo} from './mongoTestSupport.js';
import type {MongoHarness} from './mongoTestSupport.js';
import type {MongoClientLike} from './mongoDriverTypes.js';
import type {ChatSession} from '../../../types/session.js';

// The connection string is the consumer's to supply: nothing here reads the environment or assumes a host.

describe('how the store reaches MongoDB', () => {
  let harness: MongoHarness;

  beforeAll(async () => {
    harness = await startMongo();
  }, MONGO_START_MS);

  afterAll(() => harness.stop());

  it('connects from a url the consumer supplied, and closes the client it opened', async () => {
    const store = new MongoSessionStore({url: harness.uri, dbName: harness.dbName, collectionName: 'from_url'});

    await store.create('s1', 'u1');
    const held = await store.count();
    await store.close();

    expect({held, reclosed: await store.close()}).toEqual({held: 1, reclosed: undefined});
  });

  it('uses a client the consumer owns and leaves it open', async () => {
    const client = new MongoClient(harness.uri);
    await client.connect();
    const store = new MongoSessionStore({
      client: client as unknown as MongoClientLike,
      dbName: harness.dbName,
      collectionName: 'from_client',
    });

    await store.create('s1', 'u1');
    await store.close();
    const stillUsable = await client.db(harness.dbName).collection('from_client').countDocuments();
    await client.close();

    expect(stillUsable).toBe(1);
  });

  it('defaults the collection name when the consumer names none', async () => {
    const client = new MongoClient(harness.uri);
    await client.connect();
    const store = new MongoSessionStore({client: client as unknown as MongoClientLike, dbName: harness.dbName});

    const session = (await store.create('s1', 'u1')) as ChatSession;
    const named = await client.db(harness.dbName).collection('hal_sessions').countDocuments();
    await client.close();

    expect({sessionId: session.sessionId, named}).toEqual({sessionId: 's1', named: 1});
  });

  it('is built by the factory the package exports, on the same options', async () => {
    const client = new MongoClient(harness.uri);
    await client.connect();
    const store = createMongoSessionStore({
      client: client as unknown as MongoClientLike,
      dbName: harness.dbName,
      collectionName: 'from_factory',
    });

    await store.create('s1', 'u1');
    const held = await store.count();
    await client.close();

    expect({held, kind: store instanceof MongoSessionStore}).toEqual({held: 1, kind: true});
  });
});
