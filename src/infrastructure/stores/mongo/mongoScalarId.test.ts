import {MongoSessionStore} from './mongoSessionStore.js';
import {fakeCollection} from './mongoFakeCollection.js';

const nonScalar: unknown[] = [{$ne: null}, null, undefined, [], Number.NaN, Number.POSITIVE_INFINITY];

describe('MongoSessionStore scalar id guard', () => {
  it('refuses create with a non-scalar userId', async () => {
    const store = new MongoSessionStore({collection: fakeCollection()});
    for (const id of nonScalar) {
      await expect(store.create('s1', id as string | number)).rejects.toThrow();
    }
  });

  it('refuses latestFor with a non-scalar userId', async () => {
    const store = new MongoSessionStore({collection: fakeCollection()});
    for (const id of nonScalar) {
      await expect(store.latestFor(id as string | number)).rejects.toThrow();
    }
  });

  it('issues no queries when create or latestFor is given a non-scalar userId', async () => {
    const calls: string[] = [];
    const store = new MongoSessionStore({
      collection: fakeCollection({
        findOne: () => {
          calls.push('findOne');
          return Promise.resolve(null);
        },
        updateOne: () => {
          calls.push('updateOne');
          return Promise.resolve(undefined as never);
        },
      }),
    });
    for (const id of nonScalar) {
      try {
        await store.create('s1', id as string | number);
      } catch {
        // expected rejection — only checking that no query was issued
      }
      try {
        await store.latestFor(id as string | number);
      } catch {
        // expected rejection — only checking that no query was issued
      }
    }
    expect(calls).toEqual([]);
  });
});
