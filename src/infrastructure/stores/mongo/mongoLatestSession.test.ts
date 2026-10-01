import {MongoSessionStore} from './mongoSessionStore.js';
import {mongoCollection} from './mongoTestSupport.js';
import type {ChatSession} from '../../../types/session.js';

// The newest updatedAt decides, and a live session comes back as the very object its running turn writes to.

const START = Date.parse('2026-01-01T00:00:00.000Z');

describe('the MongoDB store latest session', () => {
  const collectionFor = mongoCollection();

  it("returns the user's session saved last, as the cached object while it is live", async () => {
    let clock = START;
    const store = new MongoSessionStore({collection: collectionFor(), now: () => new Date(clock)});
    const older = (await store.create('older', 'u1')) as ChatSession;
    clock += 1000;
    await store.create('newer', 'u1');
    await store.create('theirs', 'u2');
    clock += 1000;
    older.entries.push({role: 'user', content: 'hello', timestamp: new Date(clock).toISOString()});
    await store.save(older);

    const latest = await store.latestFor('u1');

    expect({id: latest?.sessionId, live: latest === older, stranger: await store.latestFor('u3')}).toEqual({
      id: 'older',
      live: true,
      stranger: undefined,
    });
  });

  it('finds the latest session in the collection when its cache is cold', async () => {
    let clock = START;
    const writer = new MongoSessionStore({collection: collectionFor(), now: () => new Date(clock)});
    await writer.create('older', 'u1');
    clock += 1000;
    await writer.create('newer', 'u1');
    const reader = new MongoSessionStore({collection: collectionFor()});

    expect((await reader.latestFor('u1'))?.sessionId).toBe('newer');
  });
});
