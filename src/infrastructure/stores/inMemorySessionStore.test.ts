import {InMemorySessionStore} from './inMemorySessionStore.js';

describe('InMemorySessionStore', () => {
  let store: InMemorySessionStore;

  beforeEach(() => {
    store = new InMemorySessionStore();
  });

  it('creates and retrieves a session', () => {
    const session = store.create('s1', 'u1');

    expect({created: session, retrievedIsSameObject: store.get('s1') === session}).toEqual({
      created: {sessionId: 's1', userId: 'u1', entries: [], authHeaders: undefined, workspaceId: undefined},
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
});
