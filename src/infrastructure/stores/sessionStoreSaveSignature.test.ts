import {InMemorySessionStore} from './inMemorySessionStore.js';
import type {SessionStore} from '../../types/sessionStore.js';

// save is typed `void | Promise<void>`, so an implementation may be either; these three are the pin.

const shipped: SessionStore = new InMemorySessionStore();
const savesSynchronously: SessionStore = Object.assign(new InMemorySessionStore(), {save: () => undefined});
const savesAsynchronously: SessionStore = Object.assign(new InMemorySessionStore(), {save: async () => undefined});

describe('the SessionStore save signature', () => {
  it('accepts a synchronous save, an async save, and the shipped store that has none', () => {
    const implementations = [savesSynchronously, savesAsynchronously, shipped];

    expect(implementations.map(store => typeof store.save)).toEqual(['function', 'function', 'undefined']);
  });
});
