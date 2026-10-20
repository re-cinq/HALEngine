import {jest} from '@jest/globals';
import {InMemorySessionStore} from './inMemorySessionStore.js';
import type {ChatSession} from '../../types/session.js';
import type {SessionStore} from '../../types/sessionStore.js';

describe('InMemorySessionStore', () => {
  let store: InMemorySessionStore;

  beforeEach(() => {
    store = new InMemorySessionStore();
  });

  it('creates and retrieves a session', () => {
    const session = store.create('s1', 'u1');

    expect({created: session, retrievedIsSameObject: store.get('s1') === session}).toEqual({
      created: {
        sessionId: 's1',
        userId: 'u1',
        entries: [],
        authHeaders: undefined,
        workspaceId: undefined,
        createdAt: expect.any(String),
      },
      retrievedIsSameObject: true,
    });
  });

  it('creates session with options', () => {
    const session = store.create('s1', 'u1', {
      authHeaders: {cookie: 'abc', authorization: 'Bearer xyz', host: 'example.com'},
      workspaceId: 'ws1',
    });

    expect(session).toMatchObject({
      authHeaders: {cookie: 'abc', authorization: 'Bearer xyz', host: 'example.com'},
      workspaceId: 'ws1',
    });
  });

  it('returns undefined for unknown session', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('deletes a session', () => {
    store.create('s1', 'u1');
    const deleted = store.delete('s1');

    expect({deleted, afterDelete: store.get('s1')}).toEqual({deleted: true, afterDelete: undefined});
  });

  it('returns false when deleting nonexistent session', () => {
    expect(store.delete('nonexistent')).toBe(false);
  });

  it('tracks count correctly', () => {
    const empty = store.count();
    store.create('s1', 'u1');
    store.create('s2', 'u2');
    const afterTwoCreates = store.count();
    store.delete('s1');

    expect({empty, afterTwoCreates, afterOneDelete: store.count()}).toEqual({
      empty: 0,
      afterTwoCreates: 2,
      afterOneDelete: 1,
    });
  });

  it('clears all sessions', () => {
    store.create('s1', 'u1');
    store.create('s2', 'u2');
    store.clear();

    expect({count: store.count(), s1: store.get('s1')}).toEqual({count: 0, s1: undefined});
  });

  it('stamps createdAt at create as the ISO 8601 time of the call, 2026-10-20T08:00:00.000Z on a clock set to it', () => {
    jest.useFakeTimers({now: new Date('2026-10-20T08:00:00.000Z')});
    try {
      expect(store.create('s-created', 'u1').createdAt).toBe('2026-10-20T08:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('lets a consumer type its sessions with createdAt required and implement SessionStore over them', () => {
    interface DatedSession extends ChatSession {
      createdAt: string;
    }
    class DatedStore implements SessionStore<DatedSession> {
      private readonly held = new Map<string, DatedSession>();
      create(sessionId: string, userId: string | number): DatedSession {
        const session = {sessionId, userId, entries: [], createdAt: new Date(0).toISOString()};
        this.held.set(sessionId, session);
        return session;
      }
      get(sessionId: string): DatedSession | undefined {
        return this.held.get(sessionId);
      }
      save(session: DatedSession): void {
        this.held.set(session.sessionId, session);
      }
      delete(sessionId: string): boolean {
        return this.held.delete(sessionId);
      }
      count(): number {
        return this.held.size;
      }
      clear(): void {
        this.held.clear();
      }
    }

    expect(new DatedStore().create('s', 'u').createdAt).toBe('1970-01-01T00:00:00.000Z');
  });
});
