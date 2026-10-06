import {MongoSessionStore} from './mongoSessionStore.js';
import type {CollectionLike} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';

// Guards at the store boundary: a non-scalar userId is refused before any query reaches the collection.

const recordingCollection = (): {collection: CollectionLike<MongoSessionDocument>; calls: string[]} => {
  const calls: string[] = [];
  const collection: CollectionLike<MongoSessionDocument> = {
    findOne: () => {
      calls.push('findOne');
      return Promise.resolve(null);
    },
    updateOne: () => {
      calls.push('updateOne');
      return Promise.resolve(undefined as never);
    },
    deleteOne: () => Promise.resolve({deletedCount: 0}),
    deleteMany: () => Promise.resolve({deletedCount: 0}),
    countDocuments: () => Promise.resolve(0),
  };
  return {collection, calls};
};

const nonScalar: unknown[] = [{$ne: null}, null, undefined, [], Number.NaN, Number.POSITIVE_INFINITY];

describe('MongoSessionStore scalar id guard', () => {
  it('refuses create with a non-scalar userId', async () => {
    const {collection} = recordingCollection();
    const store = new MongoSessionStore({collection});
    for (const id of nonScalar) {
      await expect(store.create('s1', id as string | number)).rejects.toThrow();
    }
  });

  it('refuses latestFor with a non-scalar userId', async () => {
    const {collection} = recordingCollection();
    const store = new MongoSessionStore({collection});
    for (const id of nonScalar) {
      await expect(store.latestFor(id as string | number)).rejects.toThrow();
    }
  });

  it('issues no queries when given a non-scalar userId', async () => {
    const {collection, calls} = recordingCollection();
    const store = new MongoSessionStore({collection});
    for (const id of nonScalar) {
      try {
        await store.create('s1', id as string | number);
      } catch {}
      try {
        await store.latestFor(id as string | number);
      } catch {}
    }
    expect(calls).toEqual([]);
  });
});
