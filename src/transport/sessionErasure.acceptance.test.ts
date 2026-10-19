import express from 'express';
import request from 'supertest';
import {MongoSessionStore} from '../infrastructure/stores/mongo/mongoSessionStore.js';
import {
  freshCollection,
  fakeCollection,
  startMongo,
  MONGO_START_MS,
  type MongoHarness,
} from '../infrastructure/stores/mongo/mongoTestSupport.js';
import {createChatRoutes} from './routes/chats.js';
import {startEngineWith, askOnOpen, announcedId, stopEngines, deferred} from './wsTestSupport.js';
import {createChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import type {ChatSession, SessionEntry} from '../types/session.js';
import type {AIProvider} from '../types/ai.js';
import type {PromptBuilder} from '../infrastructure/builders/promptBuilder.js';
import type {AuthenticatedRequest} from '../types/auth.js';

describe('conversation erasure', () => {
  let harness: MongoHarness;
  let collection: ReturnType<typeof freshCollection>;

  beforeAll(async () => {
    harness = await startMongo();
  }, MONGO_START_MS);

  afterAll(async () => {
    await stopEngines();
    await harness.stop();
  });

  beforeEach(() => {
    collection = freshCollection(harness.db);
  });

  const getStore = () => new MongoSessionStore({collection});

  it('create, eraseConversation, then save of the session a socket still holds: await store.count() is 0', async () => {
    const store = getStore();
    const session = (await store.create('session1', 'user1')) as ChatSession;

    await store.eraseConversation('session1');

    // Simulate socket holding session and saving it back
    session.entries.push({role: 'user', content: 'hello', timestamp: '2024-01-01T00:00:00.000Z'});
    await store.save(session);

    const [count, doc] = await Promise.all([store.count(), store.get('session1')]);
    expect({count, doc}).toEqual({count: 0, doc: undefined});
  });

  it('create with createdAt back-dated past a cutoff, eraseOlderThan(cutoff), then save of the held session: no document is written', async () => {
    const store = getStore();
    const session = (await store.create('session2', 'user1')) as ChatSession;

    // Backdate the document
    await collection.updateOne({_id: 'session2'}, {$set: {createdAt: new Date('2020-01-01T00:00:00.000Z')}});

    const cutoff = new Date('2021-01-01T00:00:00.000Z');
    await store.eraseOlderThan(cutoff);

    await store.save(session);

    const count = await store.count();
    expect(count).toBe(0);
  });

  it('GDPR. Over a real socket: a turn, an erasure, a second turn, and the conversation stays erased', async () => {
    const sessionStore = getStore();
    const provider = {
      complete: async () => 'hello back',
      completeStream: async function* () {
        yield {type: 'text', text: 'hello back'};
        yield {type: 'stop', stopReason: 'end_turn'};
      },
    };
    const orchestrator = createChatOrchestrator(
      provider as unknown as AIProvider,
      {build: (sess: ChatSession) => sess.entries} as unknown as PromptBuilder,
      undefined,
      {sessionStore}
    );
    const {url, hal: _hal} = await startEngineWith({sessionStore, orchestrator});

    const {client, finished} = askOnOpen(url, {until: 'stream_end', token: 'token1'});
    const id = announcedId(client);
    await finished;
    const sessionId = id();

    // Erasure
    await sessionStore.eraseConversation(sessionId);

    // Second turn
    const turn2 = deferred();
    client.on('message', rawMsg => {
      const msg = JSON.parse(rawMsg.toString());
      if (msg.type === 'stream_end' || msg.type === 'error') {
        turn2.release();
      }
    });
    client.on('close', () => turn2.release());
    client.on('error', () => turn2.release());
    client.send(JSON.stringify({type: 'user_message', content: 'second message'}));
    await turn2.until;

    const count = await sessionStore.count();
    expect(count).toBe(0);
  });

  it('POST /chats then POST /chats/:id/messages stores the chat in the session store, and after its erasure a further message writes nothing', async () => {
    const store = getStore();
    const provider = {
      complete: async () => 'assistant reply',
      completeStream: async function* () {
        yield {type: 'text', text: 'assistant reply'};
      },
    };
    const orchestrator = createChatOrchestrator(
      provider as unknown as AIProvider,
      {build: (sess: ChatSession) => sess.entries} as unknown as PromptBuilder,
      undefined,
      {sessionStore: store}
    );

    const app = express();
    app.use(express.json());
    app.use(
      '/chats',
      createChatRoutes(
        orchestrator,
        store,
        (req: AuthenticatedRequest, _res: express.Response, next: express.NextFunction) => {
          req.user = {id: 'user1'};
          next();
        }
      )
    );

    const res = await request(app).post('/chats').send({});
    const chatId = (res.body as {id: string}).id;

    await request(app).post(`/chats/${chatId}/messages`).send({content: 'hello'});
    const countAfterFirst = await store.count();

    await store.eraseConversation(chatId);
    await request(app).post(`/chats/${chatId}/messages`).send({content: 'hello 2'});
    const countAfterErase = await store.count();

    expect({status: res.status, countAfterFirst, countAfterErase}).toEqual({
      status: 201,
      countAfterFirst: 1,
      countAfterErase: 0,
    });
  });

  it('A live session created after the cutoff is the same object from get before and after eraseOlderThan', async () => {
    const store = getStore();
    await store.create('session3', 'user1');
    const fromGet = await store.get('session3');

    const cutoff = new Date('2020-01-01T00:00:00.000Z');
    await store.eraseOlderThan(cutoff);

    const afterErasure = await store.get('session3');
    expect(afterErasure).toBe(fromGet);
  });

  it('An eraseOlderThan whose delete rejects leaves every cached session cached, asserted with a fake collection whose deleteMany rejects', async () => {
    let callCount = 0;
    const fakeColl = fakeCollection({
      deleteMany: () => {
        callCount++;
        return Promise.reject(new Error('db failure'));
      },
    });
    const store = new MongoSessionStore({collection: fakeColl});

    const session = {sessionId: 's1'} as ChatSession;
    store['cache'].set('s1', session);

    let thrownMessage: string | undefined;
    try {
      await store.eraseOlderThan(new Date('2021-01-01T00:00:00.000Z'));
    } catch (e) {
      thrownMessage = (e as Error).message;
    }

    expect({thrownMessage, cached: store['cache'].get('s1'), callCount}).toEqual({
      thrownMessage: 'db failure',
      cached: session,
      callCount: 1,
    });
  });

  it('A get racing an erasure of the same id never leaves the erased session cached', async () => {
    let getResolves: () => void;
    const getStarted = new Promise<void>(resolve => {
      getResolves = resolve;
    });

    const mockCollection = fakeCollection({
      findOne: async () => {
        getResolves();
        await new Promise(r => setTimeout(r, 50));
        return {
          _id: 's1',
          entries: [] as SessionEntry[],
          userId: 'u1',
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
          updatedAt: new Date('2020-01-01T00:00:00.000Z'),
        };
      },
      deleteOne: async () => {
        return {deletedCount: 1, acknowledged: true};
      },
    });

    const store = new MongoSessionStore({collection: mockCollection});

    const getPromise = store.get('s1');
    await getStarted;
    const erasePromise = store.eraseConversation('s1');

    await Promise.all([getPromise, erasePromise]);

    expect(store['cache'].has('s1')).toBe(false);
  });
});
