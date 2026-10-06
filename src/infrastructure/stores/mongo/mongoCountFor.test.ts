import {MongoSessionStore} from './mongoSessionStore.js';
import {mongoCollection} from './mongoTestSupport.js';
import type {CollectionLike} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';

// specs/hal-engine-conversation-list

const fixedCollection = (
  overrides: Partial<CollectionLike<MongoSessionDocument>>
): CollectionLike<MongoSessionDocument> =>
  ({
    findOne: () => Promise.resolve(null),
    updateOne: () => Promise.resolve(undefined),
    deleteOne: () => Promise.resolve({deletedCount: 0}),
    deleteMany: () => Promise.resolve({deletedCount: 0}),
    countDocuments: () => Promise.resolve(0),
    ...overrides,
  }) as CollectionLike<MongoSessionDocument>;

describe('MongoSessionStore.countFor (fake collection)', () => {
  it('calls countDocuments with {userId} as the filter, not an empty filter, and returns what it answers', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const store = new MongoSessionStore({
      collection: fixedCollection({
        countDocuments: (filter?: Record<string, unknown>) => {
          calls.push(filter);
          return Promise.resolve(3);
        },
      }),
    });

    const count = await store.countFor('u1');

    expect({count, filter: calls[0]}).toEqual({count: 3, filter: {userId: 'u1'}});
  });

  it('surfaces a countDocuments rejection to the caller rather than answering 0', async () => {
    const store = new MongoSessionStore({
      collection: fixedCollection({
        countDocuments: () => Promise.reject(new Error('db gone')),
      }),
    });

    await expect(store.countFor('u1')).rejects.toThrow('db gone');
  });
});

describe('MongoSessionStore.countFor (real MongoDB)', () => {
  const collectionFor = mongoCollection();

  it('counts documents in the collection, not cache entries — a second store instance sees the right total', async () => {
    const writer = new MongoSessionStore({collection: collectionFor()});
    const reader = new MongoSessionStore({collection: collectionFor()});
    await writer.create('s1', 'u1');
    await writer.create('s2', 'u1');
    await writer.create('s3', 'u2');

    expect({
      u1: await reader.countFor('u1'),
      u2: await reader.countFor('u2'),
      global: await reader.count(),
    }).toEqual({u1: 2, u2: 1, global: 3});
  });
});
