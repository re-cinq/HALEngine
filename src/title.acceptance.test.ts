import {InMemorySessionStore} from './infrastructure/stores/inMemorySessionStore.js';
import {createMongoSessionStore} from './infrastructure/stores/mongo/mongoSessionStore.js';
import {MongoMemoryServer} from 'mongodb-memory-server';

describe('conversation titles', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
  });

  afterAll(async () => {
    await mongoServer.stop();
  });

  it('stores a title in InMemorySessionStore and returns it in listFor', async () => {
    const store = new InMemorySessionStore();
    const session = store.create('session-1', 'user-1');

    // The ticket claim is that a consumer cannot store a title.
    // We expect setTitle to exist and work.
    await (store as any).setTitle('session-1', 'My Important Conversation');

    const summaries = await store.listFor('user-1');
    expect(summaries[0].title).toBe('My Important Conversation');
    expect((session as any).title).toBe('My Important Conversation');
  });

  it('stores a title in MongoSessionStore and returns it in listFor', async () => {
    const store = createMongoSessionStore({
      url: mongoServer.getUri(),
      dbName: 'testdb',
    });

    await store.create('session-2', 'user-1');

    try {
      await (store as any).setTitle('session-2', 'A Mongo Conversation');

      const summaries = await store.listFor('user-1');
      expect(summaries[0].title).toBe('A Mongo Conversation');
    } finally {
      await store.close();
    }
  });
});
