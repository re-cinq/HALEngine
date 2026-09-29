import {jest} from '@jest/globals';
import {InMemorySessionStore} from './inMemorySessionStore.js';

// Nothing erases a session on close any more, so the default store needs a bound of its own or it grows forever.

const HOUR_MS = 60 * 60 * 1000;
const START = new Date('2026-01-01T00:00:00.000Z');

describe('the in-memory store age bound', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
  });

  afterEach(() => jest.useRealTimers());

  it('defaults to eight hours', () => {
    const store = new InMemorySessionStore();
    store.create('s1', 'u1');

    jest.setSystemTime(new Date(START.getTime() + 8 * HOUR_MS + 1));

    expect({held: store.get('s1'), count: store.count()}).toEqual({held: undefined, count: 0});
  });

  it('evicts lazily on get once maxAgeMs has passed', () => {
    const store = new InMemorySessionStore({maxAgeMs: 1000});
    store.create('s1', 'u1');

    jest.setSystemTime(new Date(START.getTime() + 1001));

    expect({held: store.get('s1'), count: store.count()}).toEqual({held: undefined, count: 0});
  });

  it('sweeps an expired session on the next create without anyone reading it', () => {
    const store = new InMemorySessionStore({maxAgeMs: 1000});
    store.create('s1', 'u1');

    jest.setSystemTime(new Date(START.getTime() + 1001));
    store.create('s2', 'u2');

    expect({count: store.count(), gone: store.get('s1')}).toEqual({count: 1, gone: undefined});
  });

  it('stops the sweep at the first live session rather than scanning all 1,000', () => {
    const store = new InMemorySessionStore({maxAgeMs: 1000});
    store.create('old', 'u1');
    jest.setSystemTime(new Date(START.getTime() + 500));
    for (let index = 0; index < 1000; index++) store.create(`s${index}`, 'u1');

    jest.setSystemTime(new Date(START.getTime() + 1001));
    store.create('fresh', 'u1');

    expect({count: store.count(), gone: store.get('old')}).toEqual({count: 1001, gone: undefined});
  });

  it('never expires a session whose creation time was not a finite number', () => {
    const store = new InMemorySessionStore({maxAgeMs: 1000});
    const now = jest.spyOn(Date, 'now').mockReturnValue(Number.NaN);
    store.create('s1', 'u1');
    now.mockRestore();

    jest.setSystemTime(new Date(START.getTime() + HOUR_MS));

    expect({held: store.get('s1')?.sessionId, count: store.count()}).toEqual({held: 's1', count: 1});
  });

  it('returns to zero once every session has passed maxAgeMs', () => {
    const store = new InMemorySessionStore({maxAgeMs: 1000});
    store.create('s1', 'u1');
    store.create('s2', 'u2');

    jest.setSystemTime(new Date(START.getTime() + 1001));
    const swept = [store.get('s1'), store.get('s2')];

    expect({swept, count: store.count()}).toEqual({swept: [undefined, undefined], count: 0});
  });
});
