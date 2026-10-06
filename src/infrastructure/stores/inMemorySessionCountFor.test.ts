import {jest} from '@jest/globals';
import {InMemorySessionStore} from './inMemorySessionStore.js';

// specs/hal-engine-conversation-list

describe('InMemorySessionStore.countFor', () => {
  it("counts each user's own conversations and answers 0 for a user with none, while count() stays global", () => {
    const store = new InMemorySessionStore();
    store.create('s1', 'u1');
    store.create('s2', 'u1');
    store.create('s3', 'u2');

    expect({
      u1: store.countFor('u1'),
      u2: store.countFor('u2'),
      none: store.countFor('nobody'),
      global: store.count(),
    }).toEqual({u1: 2, u2: 1, none: 0, global: 3});
  });

  it('does not count a conversation that has aged out', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = new InMemorySessionStore({maxAgeMs: 1000});
    store.create('s1', 'u1');
    store.create('s2', 'u1');

    jest.setSystemTime(new Date('2026-01-01T00:00:01.001Z'));
    store.create('s3', 'u1');

    const count = store.countFor('u1');
    jest.useRealTimers();

    expect(count).toBe(1);
  });
});
