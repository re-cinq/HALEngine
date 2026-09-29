import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {WebSocket} from 'ws';
import type {Express} from 'express';
import {createServer} from './createServer.js';
import {HAL_WS_SUBPROTOCOL} from './ws/subprotocol.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import {setLogger} from '../shared/logger.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import type {MessageChunk} from '../types/ai.js';
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

const answering: ChatOrchestrator = {
  processMessage: async () => 'hi',
  async *processMessageStream(): AsyncGenerator<MessageChunk> {
    yield {type: 'text', text: 'hi'};
    yield {type: 'stop', stopReason: 'end_turn'};
  },
};

const started: Array<{stop: () => Promise<void>}> = [];
const opened: WebSocket[] = [];

const engine = async (sessionStore: SessionStore) => {
  const hal = createServer({
    app: (() => undefined) as unknown as Express,
    wsAuth: async () => ({id: 'u1'}),
    sessionStore,
    orchestrator: answering,
  });
  await hal.start(0);
  started.push(hal);
  const {port} = hal.server.address() as AddressInfo;
  return {hal, url: `ws://127.0.0.1:${port}/hal/ws/c1`};
};

// Every socket and server torn down even when a test fails, so a red run reports instead of hanging.
const connect = (url: string): WebSocket => {
  const client = new WebSocket(url, [HAL_WS_SUBPROTOCOL, 't']);
  opened.push(client);
  return client;
};

const framesFor = async (client: WebSocket, until: string): Promise<string[]> => {
  const seen: string[] = [];
  return new Promise<string[]>(resolve => {
    client.on('message', raw => {
      const frame = JSON.parse(String(raw)) as {type: string};
      seen.push(frame.type);
      if (frame.type === until) resolve(seen);
    });
  });
};

describe('awaiting a slow session store', () => {
  afterEach(async () => {
    setLogger();
    for (const client of opened.splice(0)) client.terminate();
    for (const hal of started.splice(0)) await hal.stop();
  });

  // prettier-ignore
  it('delivers a frame sent before the connected frame arrives', async () => {
    const {url} = await engine(slowStore(CREATE_MS));
    const client = connect(url);
    const finished = framesFor(client, 'stream_end');
    client.on('open', () => client.send(JSON.stringify({type: 'user_message', content: 'hello'})));

    const seen = await finished;

    expect(seen[0]).toBe('connected');
  }, FAIL_FAST_MS);

  it('leaves no session behind when the socket closes during create', async () => {
    const store = slowStore(CREATE_MS);
    const {url} = await engine(store);
    const client = connect(url);
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
    const {url} = await engine(slowStore(1, new Error('store down')));
    const client = connect(url);
    const failed = framesFor(client, 'error');

    const seen = await failed;
    await wait(20);
    process.off('unhandledRejection', record);

    expect({seen, unhandled: unhandled.length}).toEqual({seen: ['error'], unhandled: 0});
  }, FAIL_FAST_MS);
});
