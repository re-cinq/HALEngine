import {MongoSessionStore} from './mongoSessionStore.js';
import type {ChatSession} from '../../../types/session.js';
import type {CollectionLike} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';

// eraseOlderThan must evict only the sessions it deleted, never a live session it never touched.

function minimalCollection(
  overrides: Partial<{[K in keyof CollectionLike<MongoSessionDocument>]: (...args: any[]) => any}>
): CollectionLike<MongoSessionDocument> {
  return {
    findOne: () => Promise.resolve(null),
    updateOne: () => Promise.resolve(undefined),
    deleteOne: () => Promise.resolve({deletedCount: 0}),
    deleteMany: () => Promise.resolve({deletedCount: 0}),
    countDocuments: () => Promise.resolve(0),
    ...overrides,
  } as CollectionLike<MongoSessionDocument>;
}

describe('eraseOlderThan selective cache eviction', () => {
  it('evicts only the sessions it deleted, leaving live ones in cache', async () => {
    const oldDoc: MongoSessionDocument = {
      _id: 'old1',
      userId: 'u',
      entries: [],
      createdAt: new Date('2020-01-01'),
      updatedAt: new Date('2020-01-01'),
    };
    const coll = minimalCollection({
      find: () => ({toArray: () => Promise.resolve([oldDoc])}),
      deleteMany: () => Promise.resolve({deletedCount: 1}),
    });
    const store = new MongoSessionStore({collection: coll});

    const live: ChatSession = {sessionId: 'live1', userId: 'u', entries: []};
    store['cache'].set('live1', live);

    await store.eraseOlderThan(new Date('2021-01-01'));

    expect(store['cache'].get('live1')).toBe(live);
    expect(store['cache'].has('old1')).toBe(false);
  });
});
