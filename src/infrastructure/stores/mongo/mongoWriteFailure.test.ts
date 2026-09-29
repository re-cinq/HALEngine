import {MongoSessionStore} from './mongoSessionStore.js';
import type {CollectionLike} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';

// A store that caches before it writes keeps what it failed to save, credentials and all, until the process ends.

const refusingCollection = (): CollectionLike<MongoSessionDocument> =>
  ({
    findOne: () => Promise.resolve(null),
    updateOne: () => Promise.reject(new Error('database unreachable')),
    deleteOne: () => Promise.resolve({deletedCount: 0}),
    deleteMany: () => Promise.resolve({deletedCount: 0}),
    countDocuments: () => Promise.resolve(0),
  }) as CollectionLike<MongoSessionDocument>;

const outcomeOf = (call: Promise<unknown>): Promise<string> =>
  call.then(() => 'resolved').catch((error: Error) => error.message);

describe('a create whose write fails', () => {
  it('keeps nothing in the cache, so a failing database cannot fill memory', async () => {
    const store = new MongoSessionStore({collection: refusingCollection()});

    const outcome = await outcomeOf(store.create('s1', 'u1', {authHeaders: {authorization: 'Bearer t'}}));
    const cached = await store.get('s1');

    expect({outcome, cached}).toEqual({outcome: 'database unreachable', cached: undefined});
  });
});
