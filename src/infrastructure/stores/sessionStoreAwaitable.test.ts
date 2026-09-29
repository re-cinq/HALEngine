import {InMemorySessionStore} from './inMemorySessionStore.js';
import type {SessionStore} from '../../types/sessionStore.js';
import type {ChatSession} from '../../types/session.js';

// A database-backed store cannot answer synchronously, so every member is widened rather than made async.

const synchronous: SessionStore = new InMemorySessionStore();

const asynchronous: SessionStore = {
  create: async (sessionId, userId): Promise<ChatSession> => ({sessionId, userId, entries: []}),
  get: async () => undefined,
  delete: async () => true,
  count: async () => 0,
  clear: async () => undefined,
};

describe('the SessionStore member signatures', () => {
  it('accepts a fully synchronous store and a fully asynchronous one', async () => {
    const counts = await Promise.all([synchronous.count(), asynchronous.count()]);

    expect(counts).toEqual([0, 0]);
  });
});
