import {once} from 'node:events';
import type {WebSocket} from 'ws';
import {askOnOpen, connectClient, framesUntil, startEngine, stopEngines} from './wsTestSupport.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import type {ChatSession} from '../types/session.js';

// The engine's own spec promises sessions persist across disconnections; the transport used to erase them on close.

const FAIL_FAST_MS = 5_000;
const settle = (ms = 50) => new Promise<void>(resolve => setTimeout(resolve, ms));

// The id is only ever announced in the connected frame, and both tests below need it after the fact.
const announcedId = (client: WebSocket): (() => string) => {
  let sessionId = '';
  client.on('message', raw => {
    const frame = JSON.parse(String(raw)) as {type: string; sessionId?: string};
    if (frame.type === 'connected') sessionId = frame.sessionId ?? '';
  });
  return () => sessionId;
};

const turnThenClose = async (store: InMemorySessionStore, onDisconnect?: (sessionId: string) => void) => {
  const url = await startEngine(store, onDisconnect);
  const {client, finished} = askOnOpen(url);
  // Attached before any frame is delivered: delivery is asynchronous, so this still precedes the connected frame.
  const sessionId = announcedId(client);

  await finished;
  client.close();
  await once(client, 'close');
  await settle();

  return {held: await store.count(), session: (await store.get(sessionId())) as ChatSession | undefined};
};

describe('a conversation whose socket closes', () => {
  afterEach(stopEngines);

  // prettier-ignore
  it('survives the close with its entries intact', async () => {
    const store = new InMemorySessionStore();

    const {held, session} = await turnThenClose(store);

    expect({held, entries: session?.entries.map(entry => entry.role)}).toEqual({
      held: 1,
      entries: ['user', 'assistant'],
    });
  }, FAIL_FAST_MS);

  // prettier-ignore
  it('reaches an onDisconnect that can still read the session it names', async () => {
    const store = new InMemorySessionStore();
    const seen: Array<string | undefined> = [];

    await turnThenClose(store, sessionId => void seen.push((store.get(sessionId) as ChatSession | undefined)?.sessionId));

    expect(seen).toEqual([expect.any(String)]);
  }, FAIL_FAST_MS);

  // prettier-ignore
  it('keeps streaming on a socket held open past maxAgeMs, whose id has left the index', async () => {
    const store = new InMemorySessionStore({maxAgeMs: 30});
    const url = await startEngine(store);
    const client = connectClient(url);
    await once(client, 'open');
    await settle(80);

    const sessionId = announcedId(client);
    const finished = framesUntil(client, 'stream_end');
    client.send(JSON.stringify({type: 'user_message', content: 'hello'}));
    const seen = await finished;

    expect({answered: seen.includes('stream_end'), indexed: await store.get(sessionId())}).toEqual({
      answered: true,
      indexed: undefined,
    });
  }, FAIL_FAST_MS);
});
