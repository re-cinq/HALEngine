import {jest} from '@jest/globals';
import {MongoSessionStore} from './mongoSessionStore.js';
import {fakeCollection} from './mongoTestSupport.js';
import type {CollectionLike} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';
import type {ChatSession} from '../../../types/session.js';
import {log} from '../../../shared/logger.js';

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

const session: ChatSession = {sessionId: 's1', userId: 'u1', entries: []};

describe('a save whose write returns no result', () => {
  afterEach(() => jest.restoreAllMocks());

  it('completes without error or warning when updateOne returns no result', async () => {
    const warn = jest.spyOn(log, 'warn').mockImplementation(() => undefined);
    const store = new MongoSessionStore({collection: fakeCollection()});

    const outcome = await outcomeOf(store.save(session));

    expect({outcome, warnings: warn.mock.calls}).toEqual({outcome: 'resolved', warnings: []});
  });

  it('warns without naming the session when no document matched', async () => {
    const warn = jest.spyOn(log, 'warn').mockImplementation(() => undefined);
    const store = new MongoSessionStore({
      collection: fakeCollection({updateOne: () => Promise.resolve({matchedCount: 0})}),
    });

    await store.save(session);

    expect(warn.mock.calls).toEqual([['session', 'save found no document']]);
  });
});
