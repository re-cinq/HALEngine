import {jest} from '@jest/globals';
import {InMemorySessionStore} from './inMemorySessionStore.js';

// A list and the latest session read the same activity, so the two can never disagree about which is newest.

const START = new Date('2026-01-01T00:00:00.000Z');
const later = (ms: number): Date => new Date(START.getTime() + ms);

describe('the in-memory store conversation list', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
  });

  afterEach(() => jest.useRealTimers());

  it('answers newest activity first, headed by the very session latestFor returns', () => {
    const store = new InMemorySessionStore();
    store.create('older', 'u1');
    jest.setSystemTime(later(1000));
    const talkedIn = store.create('newer', 'u1');
    talkedIn.entries.push({role: 'user', content: 'hello', timestamp: later(5000).toISOString()});

    const listed = store.listFor('u1');

    expect({
      order: listed.map(row => row.sessionId),
      heads: listed[0]?.sessionId === store.latestFor('u1')?.sessionId,
    }).toEqual({order: ['newer', 'older'], heads: true});
  });

  it('breaks a tie on activity by session id, where latestFor takes the session created later', () => {
    const store = new InMemorySessionStore();
    store.create('zeta', 'u1');
    store.create('alpha', 'u1');

    expect({listed: store.listFor('u1').map(row => row.sessionId), latest: store.latestFor('u1')?.sessionId}).toEqual({
      listed: ['zeta', 'alpha'],
      latest: 'alpha',
    });
  });

  it('reports a creation time, the newest activity and the entry count of each conversation', () => {
    const store = new InMemorySessionStore();
    const session = store.create('s1', 'u1');
    jest.setSystemTime(later(9000));
    session.entries.push(
      {role: 'user', content: 'hello', timestamp: later(4000).toISOString()},
      {role: 'assistant', content: 'hi', timestamp: later(8000).toISOString(), isStreaming: false}
    );

    expect(store.listFor('u1')).toEqual([{sessionId: 's1', createdAt: START, updatedAt: later(8000), entryCount: 2}]);
  });

  it("omits a conversation that aged out and another user's, and answers nothing for a user with none", () => {
    const store = new InMemorySessionStore({maxAgeMs: 1000});
    store.create('aged', 'u1');
    jest.setSystemTime(later(1001));
    store.create('live', 'u1');
    store.create('theirs', 'u2');

    expect({u1: store.listFor('u1').map(row => row.sessionId), u3: store.listFor('u3')}).toEqual({
      u1: ['live'],
      u3: [],
    });
  });

  it('pages down the same order: a limit takes the newest, and before takes what is older than it', () => {
    const store = new InMemorySessionStore();
    store.create('oldest', 'u1');
    jest.setSystemTime(later(1000));
    store.create('middle', 'u1');
    jest.setSystemTime(later(2000));
    store.create('newest', 'u1');

    const firstPage = store.listFor('u1', {limit: 1});

    expect({
      firstPage: firstPage.map(row => row.sessionId),
      rest: store.listFor('u1', {before: firstPage[0]}).map(row => row.sessionId),
    }).toEqual({firstPage: ['newest'], rest: ['middle', 'oldest']});
  });

  it('answers at most two hundred conversations however many are asked for, and fifty when none is', () => {
    const store = new InMemorySessionStore();
    for (let index = 0; index < 250; index++) store.create(`s${index}`, 'u1');

    expect({asked: store.listFor('u1', {limit: 500}).length, default: store.listFor('u1').length}).toEqual({
      asked: 200,
      default: 50,
    });
  });

  it('reads a fractional or negative limit as a count a caller can use rather than failing the list', () => {
    const store = new InMemorySessionStore();
    store.create('s1', 'u1');
    store.create('s2', 'u1');

    expect({
      fractional: store.listFor('u1', {limit: 1.7}).length,
      negative: store.listFor('u1', {limit: -5}),
    }).toEqual({fractional: 1, negative: []});
  });

  it('answers nothing for a limit of none, and the default for a limit that is not a number', () => {
    const store = new InMemorySessionStore();
    store.create('s1', 'u1');
    store.create('s2', 'u1');

    expect({
      none: store.listFor('u1', {limit: 0}),
      unusable: store.listFor('u1', {limit: Number.NaN}).length,
    }).toEqual({none: [], unusable: 2});
  });

  it('keeps a conversation tied on activity rather than dropping it across a page boundary', () => {
    const store = new InMemorySessionStore();
    store.create('a', 'u1');
    store.create('b', 'u1');
    store.create('c', 'u1');

    const pages: string[][] = [];
    let page = store.listFor('u1', {limit: 1});
    while (page.length > 0) {
      pages.push(page.map(row => row.sessionId));
      page = store.listFor('u1', {limit: 1, before: page[0]});
    }

    expect(pages).toEqual([['c'], ['b'], ['a']]);
  });
});
