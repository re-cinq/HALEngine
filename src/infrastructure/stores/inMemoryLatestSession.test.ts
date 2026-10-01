import {jest} from '@jest/globals';
import {InMemorySessionStore} from './inMemorySessionStore.js';

// This store has no save to stamp, so "latest" is read off the entries, or a session's creation when it has none.

const START = new Date('2026-01-01T00:00:00.000Z');
const later = (ms: number): Date => new Date(START.getTime() + ms);

describe('the in-memory store latest session', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
  });

  afterEach(() => jest.useRealTimers());

  it("returns the user's session with the newest entry, not the one created last, a thought counting for nothing", () => {
    const store = new InMemorySessionStore();
    const talkedIn = store.create('older', 'u1');
    jest.setSystemTime(later(1000));
    store.create('newer', 'u1');
    talkedIn.entries.push(
      {role: 'user', content: 'hello', timestamp: later(5000).toISOString()},
      {role: 'thinking', content: 'pondering', isStreaming: false}
    );

    expect(store.latestFor('u1')?.sessionId).toBe('older');
  });

  it('falls back to creation time for sessions with no entries, the one created later winning a tie', () => {
    const store = new InMemorySessionStore();
    store.create('early', 'u1');
    jest.setSystemTime(later(1000));
    store.create('late', 'u1');
    const tied = new InMemorySessionStore();
    tied.create('first', 'u2');
    tied.create('second', 'u2');

    expect({byCreation: store.latestFor('u1')?.sessionId, tie: tied.latestFor('u2')?.sessionId}).toEqual({
      byCreation: 'late',
      tie: 'second',
    });
  });

  it("returns nothing for a user whose only session aged out, nor another user's live one", () => {
    const store = new InMemorySessionStore({maxAgeMs: 1000});
    store.create('aged', 'u1');
    jest.setSystemTime(later(1001));
    store.create('theirs', 'u2');

    expect({aged: store.latestFor('u1'), stranger: store.latestFor('u3')}).toEqual({
      aged: undefined,
      stranger: undefined,
    });
  });

  it('reads a conversation too long to spread into a function call', () => {
    const store = new InMemorySessionStore();
    const long = store.create('long', 'u1');
    const sentAt = later(5000).toISOString();
    long.entries = Array.from({length: 200_000}, () => ({role: 'user' as const, content: 'hi', timestamp: sentAt}));
    store.create('empty', 'u1');

    expect(store.latestFor('u1')?.sessionId).toBe('long');
  });
});
