import {MongoSessionStore} from './mongoSessionStore.js';
import {mongoCollection} from './mongoTestSupport.js';
import type {ChatSession} from '../../../types/session.js';

// The cache is an optimisation; the collection is the truth, and a second instance is how you prove it.

const SENT_AT = '2026-01-01T00:00:00.000Z';

describe('a session written to MongoDB', () => {
  const collectionFor = mongoCollection();

  it('is returned by a second store built on the same collection', async () => {
    const writer = new MongoSessionStore({collection: collectionFor()});
    const reader = new MongoSessionStore({collection: collectionFor()});
    const session = (await writer.create('s1', 'u1')) as ChatSession;
    session.entries.push({role: 'user', content: 'hello', timestamp: SENT_AT});
    await writer.save(session);

    const reloaded = (await reader.get('s1')) as ChatSession | undefined;

    expect(reloaded?.entries).toEqual([{role: 'user', content: 'hello', timestamp: SENT_AT}]);
  });

  it('reloads from the collection after delete evicts the cache', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});
    const session = (await store.create('s1', 'u1')) as ChatSession;
    session.entries.push({role: 'user', content: 'hello', timestamp: SENT_AT});
    await store.save(session);

    const evicted = store.delete('s1');
    const reloaded = (await store.get('s1')) as ChatSession | undefined;

    expect({evicted, held: await store.count(), entries: reloaded?.entries.length}).toEqual({
      evicted: true,
      held: 1,
      entries: 1,
    });
  });

  it('is gone for good once eraseConversation removes it', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});
    await store.create('s1', 'u1');

    const erased = await store.eraseConversation('s1');

    expect({erased, reread: await store.get('s1'), held: await store.count()}).toEqual({
      erased: true,
      reread: undefined,
      held: 0,
    });
  });

  it('reports false when eraseConversation names a session it never held', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});

    expect(await store.eraseConversation('never')).toBe(false);
  });

  it('erases only what was created strictly before the cutoff', async () => {
    const cutoff = new Date('2026-06-01T12:00:00.000Z');
    const before = new MongoSessionStore({collection: collectionFor(), now: () => new Date(cutoff.getTime() - 1000)});
    const after = new MongoSessionStore({collection: collectionFor(), now: () => new Date(cutoff.getTime() + 1000)});
    await before.create('older', 'u1');
    await after.create('newer', 'u1');

    const removed = await before.eraseOlderThan(cutoff);

    expect({removed, survivor: (await after.get('newer'))?.sessionId, held: await after.count()}).toEqual({
      removed: 1,
      survivor: 'newer',
      held: 1,
    });
  });

  it('advances updatedAt on a second save while createdAt stays where it was', async () => {
    const ticks = [new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:01.000Z')];
    let tick = 0;
    const store = new MongoSessionStore({
      collection: collectionFor(),
      now: () => ticks[Math.min(tick++, ticks.length - 1)],
    });
    const session = (await store.create('s1', 'u1')) as ChatSession;
    await store.save(session);
    tick = 1;
    await store.save(session);

    const document = await collectionFor().findOne({_id: 's1'});

    expect({
      created: document?.createdAt.toISOString(),
      moved: (document?.updatedAt.getTime() ?? 0) > (document?.createdAt.getTime() ?? 0),
    }).toEqual({created: '2026-01-01T00:00:00.000Z', moved: true});
  });

  it('empties the cache on clear while every document survives', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});
    await store.create('s1', 'u1');

    store.clear();

    expect({held: await store.count(), reread: (await store.get('s1'))?.sessionId}).toEqual({held: 1, reread: 's1'});
  });

  it('leaves no document behind when a session the client never received is evicted', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});
    await store.create('s1', 'u1');

    const evicted = await store.evict('s1');

    expect({evicted, held: await store.count()}).toEqual({evicted: true, held: 0});
  });

  it('erases every conversation on eraseAll', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});
    await store.create('s1', 'u1');
    await store.create('s2', 'u2');

    expect({removed: await store.eraseAll(), held: await store.count()}).toEqual({removed: 2, held: 0});
  });

  it('returns undefined for a session no collection holds', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});

    expect(await store.get('never')).toBeUndefined();
  });

  it('carries the create options onto the session it returns', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});

    const session = (await store.create('s1', 'u1', {
      authHeaders: {authorization: 'Bearer t'},
      workspaceId: 'w1',
    })) as ChatSession;

    expect({workspaceId: session.workspaceId, authorization: session.authHeaders?.authorization}).toEqual({
      workspaceId: 'w1',
      authorization: 'Bearer t',
    });
  });
});
