import {MongoSessionStore} from './mongoSessionStore.js';
import type {ChatSession} from '../../../types/session.js';
import {fakeCollection} from './mongoFakeCollection.js';

// eraseOlderThan must evict only the sessions it deleted, never a live session it never touched.

describe('eraseOlderThan selective cache eviction', () => {
  it('evicts only the sessions it deleted, leaving live ones in cache', async () => {
    const oldDoc = {
      _id: 'old1',
      userId: 'u',
      entries: [],
      createdAt: new Date('2020-01-01'),
      updatedAt: new Date('2020-01-01'),
    };
    const coll = fakeCollection({
      find: () => ({toArray: () => Promise.resolve([oldDoc])}),
      deleteMany: () => Promise.resolve({deletedCount: 1}),
    });
    const store = new MongoSessionStore({collection: coll});

    const live: ChatSession = {sessionId: 'live1', userId: 'u', entries: []};
    store['cache'].set('live1', live);

    await store.eraseOlderThan(new Date('2021-01-01'));

    expect({live: store['cache'].get('live1'), erased: store['cache'].has('old1')}).toEqual({live, erased: false});
  });
});
