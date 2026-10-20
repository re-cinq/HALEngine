import {InMemorySessionStore} from './inMemorySessionStore.js';
import {MongoSessionStore} from './mongo/mongoSessionStore.js';
import type {CollectionLike} from './mongo/mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongo/mongoSessionDocument.js';

const recordingCollection = (): {collection: CollectionLike<MongoSessionDocument>; calls: string[]} => {
  const calls: string[] = [];
  const collection: CollectionLike<MongoSessionDocument> = {
    findOne: () => {
      calls.push('findOne');
      return Promise.resolve(null);
    },
    find: () => {
      calls.push('find');
      return {toArray: () => Promise.resolve([])};
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

describe('listFor scalar userId enforcement', () => {
  it('InMemorySessionStore.listFor refuses a non-scalar userId', () => {
    const store = new InMemorySessionStore();
    for (const id of nonScalar) {
      expect(() => store.listFor(id as string | number)).toThrow();
    }
  });

  it('MongoSessionStore.listFor refuses a non-scalar userId', async () => {
    const {collection} = recordingCollection();
    const store = new MongoSessionStore({collection});
    for (const id of nonScalar) {
      await expect(store.listFor(id as string | number)).rejects.toThrow();
    }
  });

  it('MongoSessionStore.listFor issues no queries when given a non-scalar userId', async () => {
    const {collection, calls} = recordingCollection();
    const store = new MongoSessionStore({collection});
    for (const id of nonScalar) {
      try {
        await store.listFor(id as string | number);
      } catch {
        // expected rejection — only checking that no query was issued
      }
    }
    expect(calls).toEqual([]);
  });
});
