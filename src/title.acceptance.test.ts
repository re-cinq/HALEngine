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

  it('stores a title in MongoSessionStore and returns it in listFor', async () => {
    const store = createMongoSessionStore({
      url: mongoServer.getUri(),
      dbName: 'testdb',
    });

    await store.create('session-2', 'user-1');

    try {
      await store.setTitle('session-2', 'A Mongo Conversation');

      const summaries = await store.listFor('user-1');
      expect(summaries[0]?.title).toBe('A Mongo Conversation');
    } finally {
      await store.close();
    }
  });
});
