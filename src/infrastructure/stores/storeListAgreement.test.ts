import {InMemorySessionStore} from './inMemorySessionStore.js';
import {MongoSessionStore} from './mongo/mongoSessionStore.js';
import {mongoCollection} from './mongo/mongoTestSupport.js';
import type {SessionStore, SessionSummary} from '../../types/sessionStore.js';

// Both shipped stores answer one order, so a consumer swapping one for the other sees the same conversation list.

// Dated ahead of any real clock, so the in-memory store reads activity off these entries rather than off creation.
const START = Date.parse('2099-01-01T00:00:00.000Z');
const ids = ['beta', 'alpha', 'gamma'];

const listed = async (store: SessionStore, options?: {limit?: number; before?: SessionSummary}): Promise<string[]> => {
  const rows = (await store.listFor?.('u1', options)) ?? [];
  return rows.map(row => row.sessionId);
};

const pagesOf = async (store: SessionStore): Promise<string[][]> => {
  const pages: string[][] = [];
  let rows = (await store.listFor?.('u1', {limit: 2})) ?? [];
  while (rows.length > 0) {
    pages.push(rows.map(row => row.sessionId));
    rows = (await store.listFor?.('u1', {limit: 2, before: rows.at(-1)})) ?? [];
  }
  return pages;
};

describe('the two shipped stores', () => {
  const collectionFor = mongoCollection();

  const bothHolding = async (apart: number): Promise<SessionStore[]> => {
    let clock = START;
    const memory = new InMemorySessionStore();
    const mongo = new MongoSessionStore({collection: collectionFor(), now: () => new Date(clock)});
    for (const [index, id] of ids.entries()) {
      clock = START + index * apart;
      const held = memory.create(id, 'u1');
      held.entries.push({role: 'user', content: 'hello', timestamp: new Date(clock).toISOString()});
      await mongo.create(id, 'u1');
    }
    return [memory, mongo];
  };

  it('answer the same order for conversations whose activity differs', async () => {
    const [memory, mongo] = await bothHolding(1000);

    expect([await listed(memory), await listed(mongo)]).toEqual([
      ['gamma', 'alpha', 'beta'],
      ['gamma', 'alpha', 'beta'],
    ]);
  });

  it('break a tie on activity the same way, by session id', async () => {
    const [memory, mongo] = await bothHolding(0);

    expect([await listed(memory), await listed(mongo)]).toEqual([
      ['gamma', 'beta', 'alpha'],
      ['gamma', 'beta', 'alpha'],
    ]);
  });

  it('page the same way through the documented call, two rows at a time from the last row seen', async () => {
    const [memory, mongo] = await bothHolding(0);

    expect({memory: await pagesOf(memory), mongo: await pagesOf(mongo)}).toEqual({
      memory: [['gamma', 'beta'], ['alpha']],
      mongo: [['gamma', 'beta'], ['alpha']],
    });
  });
});
