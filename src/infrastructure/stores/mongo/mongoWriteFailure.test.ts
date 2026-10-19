import {MongoSessionStore} from './mongoSessionStore.js';
import {fakeCollection} from './mongoTestSupport.js';
import type {CollectionLike} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';
import type {ChatSession} from '../../../types/session.js';

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

describe('a save whose write returns no result', () => {
  it('completes without error when updateOne returns no result', async () => {
    const store = new MongoSessionStore({collection: fakeCollection()});
    const session: ChatSession = {sessionId: 's1', userId: 'u1', entries: []};

    await expect(store.save(session)).resolves.toBeUndefined();
  });
});

describe('a get from a cache entry with no recorded time', () => {
  it('returns the cached session without querying the collection', async () => {
    const reads = {findOne: 0};
    const store = new MongoSessionStore({
      collection: fakeCollection({findOne: () => (reads.findOne++, Promise.resolve(null))}),
    });
    const session: ChatSession = {sessionId: 's1', userId: 'u1', entries: []};
    store['cache'].set('s1', session);

    const result = await store.get('s1');

    expect({result, reads: reads.findOne}).toEqual({result: session, reads: 0});
  });
});
