import {InMemorySessionStore} from './inMemorySessionStore.js';
import type {ChatSession} from '../../types/session.js';
import type {SessionStore} from '../../types/sessionStore.js';

// lookup is optional, and named so it cannot collide with a load a durable store may already have.

const fiveMembers: SessionStore = {
  create: (sessionId, userId): ChatSession => ({sessionId, userId, entries: []}),
  get: () => undefined,
  delete: () => false,
  count: () => 0,
  clear: () => undefined,
};

class StoreWithItsOwnLoad implements SessionStore {
  private readonly rows = new Map<string, ChatSession>();

  async load(sessionId: string): Promise<ChatSession | undefined> {
    return this.rows.get(sessionId);
  }

  create(sessionId: string, userId: string | number): ChatSession {
    const session: ChatSession = {sessionId, userId, entries: []};
    this.rows.set(sessionId, session);
    return session;
  }

  get(sessionId: string): ChatSession | undefined {
    return this.rows.get(sessionId);
  }

  delete(sessionId: string): boolean {
    return this.rows.delete(sessionId);
  }

  count(): number {
    return this.rows.size;
  }

  clear(): void {
    this.rows.clear();
  }
}

describe('the SessionStore lookup member', () => {
  it('leaves a store with only the five original members satisfying the interface beside the shipped one', () => {
    const shipped: SessionStore = new InMemorySessionStore();

    expect({fiveMembers: fiveMembers.lookup, shipped: typeof shipped.lookup}).toEqual({
      fiveMembers: undefined,
      shipped: 'function',
    });
  });

  it("compiles beside a store's own load method of a different shape", async () => {
    const store = new StoreWithItsOwnLoad();
    store.create('s1', 'u1');

    expect((await store.load('s1'))?.sessionId).toBe('s1');
  });
});
