import {InMemorySessionStore} from './inMemorySessionStore.js';
import {MongoSessionStore} from './mongo/mongoSessionStore.js';
import {fiveMemberStore} from './sessionStoreTestSupport.js';
import type {SessionStore, SessionSummary} from '../../types/sessionStore.js';

// listFor is optional, and its summary is the smallest row a list needs: never a conversation, never a credential.

const START = new Date('2026-01-01T00:00:00.000Z');

describe('the SessionStore listFor member', () => {
  it('leaves a store with only the five original members satisfying the interface beside both shipped ones', () => {
    const memory: SessionStore = new InMemorySessionStore();
    const mongo: SessionStore = new MongoSessionStore({url: 'mongodb://localhost:27017', dbName: 'unused'});

    expect({
      fiveMembers: fiveMemberStore.listFor,
      memory: typeof memory.listFor,
      mongo: typeof mongo.listFor,
    }).toEqual({fiveMembers: undefined, memory: 'function', mongo: 'function'});
  });

  it('carries only its four fields, so a list can never hand over a conversation or a credential', () => {
    const store = new InMemorySessionStore();
    const session = store.create('s1', 'u1', {authHeaders: {cookie: 'session=secret'}});
    session.entries.push({role: 'user', content: 'hello', timestamp: START.toISOString()});
    const [summary] = store.listFor('u1') as [SessionSummary];

    expect({
      keys: Object.keys(summary).sort(),
      // @ts-expect-error a summary has no entries: the conversation does not travel with the list.
      entries: summary.entries,
      // @ts-expect-error a summary has no authHeaders: a credential does not travel with the list.
      authHeaders: summary.authHeaders,
    }).toEqual({
      keys: ['createdAt', 'entryCount', 'sessionId', 'updatedAt'],
      entries: undefined,
      authHeaders: undefined,
    });
  });
});
