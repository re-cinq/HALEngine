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

  it('stores a title in InMemorySessionStore and returns it in listFor', () => {
    const store = new InMemorySessionStore();
    const session = store.create('session-1', 'user-1');
    store.setTitle('session-1', 'My Important Conversation');
    const summaries = store.listFor('user-1');
    expect({summaryTitle: summaries[0]?.title, sessionTitle: session.title}).toMatchObject({
      summaryTitle: 'My Important Conversation',
      sessionTitle: 'My Important Conversation',
    });
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
