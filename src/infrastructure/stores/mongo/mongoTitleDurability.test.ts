import {MongoSessionStore} from './mongoSessionStore.js';
import {mongoCollection} from './mongoTestSupport.js';
import type {ChatSession} from '../../../types/session.js';

// specs/hal-engine-conversation-list/spec.md#a-stored-title

const SENT_AT = '2026-01-01T00:00:00.000Z';

describe('MongoSessionStore title durability', () => {
  const collectionFor = mongoCollection();

  it('a title written by setTitle survives a subsequent save', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});
    const reader = new MongoSessionStore({collection: collectionFor()});
    const session = (await store.create('s1', 'u1')) as ChatSession;
    await store.setTitle('s1', 'Surviving Title');
    session.entries.push({role: 'user', content: 'hello', timestamp: SENT_AT});
    await store.save(session);
    expect(((await reader.get('s1')) as ChatSession | undefined)?.title).toBe('Surviving Title');
  });

  it('is erased together with its conversation by eraseConversation', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});
    const reader = new MongoSessionStore({collection: collectionFor()});
    await store.create('s1', 'u1');
    await store.setTitle('s1', 'Doomed Title');
    await store.eraseConversation('s1');
    expect(await reader.get('s1')).toBeUndefined();
  });

  it('is erased together with its conversation by eraseOlderThan', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});
    await store.create('s1', 'u1');
    await store.setTitle('s1', 'Aged Title');
    const removed = await store.eraseOlderThan(new Date('2999-01-01T00:00:00.000Z'));
    expect({removed, held: await collectionFor().countDocuments()}).toEqual({removed: 1, held: 0});
  });

  it('is erased together with its conversation by eraseAll', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});
    await store.create('s1', 'u1');
    await store.setTitle('s1', 'Wiped Title');
    const removed = await store.eraseAll();
    expect({removed, held: await collectionFor().countDocuments()}).toEqual({removed: 1, held: 0});
  });

  it('reaches the database even when no cached session is held', async () => {
    const creator = new MongoSessionStore({collection: collectionFor()});
    const titler = new MongoSessionStore({collection: collectionFor()});
    const reader = new MongoSessionStore({collection: collectionFor()});
    await creator.create('s1', 'u1');
    await titler.setTitle('s1', 'Cold Cache Title');
    expect(((await reader.get('s1')) as ChatSession | undefined)?.title).toBe('Cold Cache Title');
  });
});
