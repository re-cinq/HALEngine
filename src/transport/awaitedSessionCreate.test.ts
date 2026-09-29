import {once} from 'node:events';
import {askOnOpen, connectClient, framesUntil, startEngine, stopEngines} from './wsTestSupport.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import type {SessionStore} from '../types/sessionStore.js';

// A store that answers from a database cannot answer in the same tick, so the handler must wait without dropping a frame.

const CREATE_MS = 50;
// A hang fails in this long instead of stalling the suite; its tests stay on one line so a spec citation can name them.
const FAIL_FAST_MS = 5_000;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Wraps the real store so only the timing of `create` differs from the shipped one.
const slowStore = (delayMs: number, failWith?: Error): SessionStore => {
  const store = new InMemorySessionStore();
  return Object.assign(Object.create(Object.getPrototypeOf(store) as object) as SessionStore, store, {
    create: async (sessionId: string, userId: string | number) => {
      await wait(delayMs);
      if (failWith) throw failWith;
      return store.create(sessionId, userId);
    },
    get: (sessionId: string) => store.get(sessionId),
    delete: (sessionId: string) => store.delete(sessionId),
    count: () => store.count(),
    clear: () => store.clear(),
  }) as SessionStore;
};

describe('awaiting a slow session store', () => {
  afterEach(stopEngines);

  // prettier-ignore
  it('delivers a frame sent before the connected frame arrives', async () => {
    const url = await startEngine(slowStore(CREATE_MS));
    const {finished} = askOnOpen(url);

    const seen = await finished;

    expect(seen[0]).toBe('connected');
  }, FAIL_FAST_MS);

  it('leaves no session behind when the socket closes during create', async () => {
    const store = slowStore(CREATE_MS);
    const url = await startEngine(store);
    const client = connectClient(url);
    await once(client, 'open');

    client.terminate();
    await wait(CREATE_MS * 3);
    const held = await store.count();

    expect(held).toBe(0);
  });

  // prettier-ignore
  it('answers a rejecting create with SERVER_ERROR rather than an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', record);
    const url = await startEngine(slowStore(1, new Error('store down')));
    const client = connectClient(url);
    const failed = framesUntil(client, 'error');

    const seen = await failed;
    await wait(20);
    process.off('unhandledRejection', record);

    expect({seen, unhandled: unhandled.length}).toEqual({seen: ['error'], unhandled: 0});
  }, FAIL_FAST_MS);
});
