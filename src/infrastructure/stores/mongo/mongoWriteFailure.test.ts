import {MongoSessionStore} from './mongoSessionStore.js';
import {fakeCollection} from './mongoTestSupport.js';
import type {CollectionLike} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';

// A store that caches before it writes keeps what it failed to save, credentials and all, until the process ends.

const refusingCollection = (): CollectionLike<MongoSessionDocument> =>
  fakeCollection({updateOne: () => Promise.reject(new Error('database unreachable'))});

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
