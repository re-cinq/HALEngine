import {jest} from '@jest/globals';
import {MongoSessionStore} from './mongoSessionStore.js';
import type {CollectionLike} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';

// The collection is the truth, so the cache in front of it is a cache: bounded, and never the thing that erases.

const START = new Date('2026-01-01T00:00:00.000Z');

const countingCollection = (reads: {findOne: number}): CollectionLike<MongoSessionDocument> =>
  ({
    findOne: (filter: Record<string, unknown>) => {
      reads.findOne++;
      return Promise.resolve({
        _id: String(filter._id),
        userId: 'u1',
        entries: [],
        createdAt: START,
        updatedAt: START,
      });
    },
    find: () => ({toArray: () => Promise.resolve([])}),
    updateOne: () => Promise.resolve(undefined),
    deleteOne: () => Promise.resolve({deletedCount: 1}),
    deleteMany: () => Promise.resolve({deletedCount: 0}),
    countDocuments: () => Promise.resolve(1),
  }) as CollectionLike<MongoSessionDocument>;

describe('the Mongo store cache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
  });

  afterEach(() => jest.useRealTimers());

  it('drops a stale entry and reloads it, leaving the document untouched', async () => {
    const reads = {findOne: 0};
    const store = new MongoSessionStore({collection: countingCollection(reads), maxAgeMs: 1000});
    await store.create('s1', 'u1');
    await store.get('s1');

    jest.setSystemTime(new Date(START.getTime() + 1001));
    const reloaded = await store.get('s1');

    expect({reads: reads.findOne, sessionId: reloaded?.sessionId, held: await store.count()}).toEqual({
      reads: 1,
      sessionId: 's1',
      held: 1,
    });
  });

  // The clock steps back afterwards so the entry would read as fresh: only a sweep can explain the reload.
  it('sweeps a session nobody reads again when another is cached', async () => {
    const reads = {findOne: 0};
    const store = new MongoSessionStore({collection: countingCollection(reads), maxAgeMs: 1000});
    await store.create('s1', 'u1');

    jest.setSystemTime(new Date(START.getTime() + 1001));
    await store.create('s2', 'u2');
    jest.setSystemTime(new Date(START.getTime() + 500));
    await store.get('s1');

    expect(reads.findOne).toBe(1);
  });
});
