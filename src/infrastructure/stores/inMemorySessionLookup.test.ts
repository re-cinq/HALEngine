import {jest} from '@jest/globals';
import {InMemorySessionStore} from './inMemorySessionStore.js';

// lookup reports what maxAgeMs already decided: it decides nothing, and keeps no record of what it evicted.

const START = new Date('2026-01-01T00:00:00.000Z');
const later = (ms: number): Date => new Date(START.getTime() + ms);

describe('the in-memory store lookup', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('reports a session past maxAgeMs as expired, with its owner and nothing else', () => {
    const store = new InMemorySessionStore({maxAgeMs: 1000});
    store.create('s1', 'u1');
    jest.setSystemTime(later(1001));

    expect(store.lookup('s1')).toStrictEqual({status: 'expired', userId: 'u1'});
  });

  it('reports a live session as active with the object create returned, and an id never issued as missing', () => {
    const store = new InMemorySessionStore();
    const created = store.create('s1', 'u1');

    const live = store.lookup('s1');

    expect({sameObject: live.status === 'active' && live.session === created, never: store.lookup('nope')}).toEqual({
      sameObject: true,
      never: {status: 'missing'},
    });
  });

  it('reports an expired session once, then as missing, keeping no tombstone', () => {
    const store = new InMemorySessionStore({maxAgeMs: 1000});
    store.create('s1', 'u1');
    jest.setSystemTime(later(1001));

    expect({first: store.lookup('s1'), second: store.lookup('s1'), held: store.count()}).toEqual({
      first: {status: 'expired', userId: 'u1'},
      second: {status: 'missing'},
      held: 0,
    });
  });

  it('never reports a session whose creation time was not a finite number as expired', () => {
    const store = new InMemorySessionStore({maxAgeMs: 1000});
    jest.spyOn(Date, 'now').mockReturnValueOnce(Number.NaN);
    store.create('s1', 'u1');
    jest.setSystemTime(later(60 * 60 * 1000));

    expect(store.lookup('s1')).toMatchObject({status: 'active'});
  });

  it('lets no entry content reach an expired result', () => {
    const store = new InMemorySessionStore({maxAgeMs: 1000});
    const {entries} = store.create('s1', 'u1');
    entries.push({role: 'user', content: 'my booking 4711', timestamp: START.toISOString()});
    jest.setSystemTime(later(1001));

    const expired = store.lookup('s1');

    expect({keys: Object.keys(expired).sort(), leaked: JSON.stringify(expired).includes('4711')}).toEqual({
      keys: ['status', 'userId'],
      leaked: false,
    });
  });
});
