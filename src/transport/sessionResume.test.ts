import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {WebSocket} from 'ws';
import type {Express} from 'express';
import {createServer} from './createServer.js';
import {HAL_WS_SUBPROTOCOL} from './ws/subprotocol.js';
import type {SessionResumeOptions} from './ws/sessionResume.js';
import {answeringOrchestrator} from './wsTestSupport.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import type {MessageChunk} from '../types/ai.js';
import type {ConnectedMessage} from '../types/messages.js';
import type {SessionEntry} from '../types/session.js';
import type {SessionStore} from '../types/sessionStore.js';
import {setLogger} from '../shared/logger.js';

// Real upgrades over a real socket: what a reconnect is sent is the contract, and no double can observe it.

interface Frame {
  type: string;
  sessionId?: string;
  resumed?: boolean;
  entryCount?: number;
  index?: number;
  entry?: SessionEntry;
}

const NEVER_ISSUED = '0f1e2d3c-4b5a-4968-8776-655443322110';
const RESUME_ON: SessionResumeOptions = {enabled: true};
const HALF_ANSWER: SessionEntry = {
  role: 'assistant',
  content: 'half',
  timestamp: '2026-09-30T08:00:01.000Z',
  isStreaming: true,
};

// A tool's suppression lands while the answer is still open, as when a provider ends a tool round with no stop.
const suppressingMidAnswer: ChatOrchestrator = {
  processMessage: async () => 'before after',
  async *processMessageStream(): AsyncGenerator<MessageChunk> {
    yield {type: 'text', text: 'before'};
    yield {type: 'suppress_output'} as unknown as MessageChunk;
    yield {type: 'text', text: ' after'};
    yield {type: 'stop', stopReason: 'end_turn'};
  },
};

const servers: Array<ReturnType<typeof createServer>> = [];
const clients: WebSocket[] = [];

const eventually = async (check: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 50 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
};

// Silenced for the whole file: the server logs every connection and close, and these tests read frames, not logs.
beforeAll(() => {
  setLogger({debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined});
});

afterAll(() => {
  setLogger();
});

// Each server sees its sockets close before it stops, so no close is logged after the logger above is restored.
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  for (const hal of servers.splice(0)) {
    const {wss} = hal;
    await eventually(() => wss.clients.size === 0);
    await hal.stop();
  }
});

// The authenticated user is read per upgrade, so one test can reconnect as someone else.
const startEngine = async (
  store: SessionStore,
  resume?: SessionResumeOptions,
  orchestrator: ChatOrchestrator = answeringOrchestrator
) => {
  const auth = {userId: 'u1'};
  const disconnected: string[] = [];
  const hal = createServer({
    app: (() => undefined) as unknown as Express,
    wsAuth: async () => ({id: auth.userId}),
    sessionStore: store,
    orchestrator,
    resume,
    onDisconnect: sessionId => void disconnected.push(sessionId),
  });
  // Resolves once the server itself has seen its first socket close, which the client's own close can precede.
  const firstServerClose = new Promise<void>(resolve => {
    hal.wss.once('connection', socket => socket.once('close', () => resolve()));
  });
  await hal.start(0);
  servers.push(hal);
  const {port} = hal.server.address() as AddressInfo;
  return {auth, disconnected, firstServerClose, base: `ws://127.0.0.1:${port}/hal/ws`};
};

const open = (url: string, token = 't'): WebSocket => {
  const client = new WebSocket(url, [HAL_WS_SUBPROTOCOL, token]);
  clients.push(client);
  return client;
};

// One question answered and the socket closed, returning the id the connected frame announced.
const firstTurn = async (base: string): Promise<string> => {
  const client = open(base);
  let sessionId = '';
  await new Promise<void>(resolve => {
    client.on('message', raw => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (frame.type === 'connected') sessionId = frame.sessionId ?? '';
      if (frame.type === 'connected') client.send(JSON.stringify({type: 'user_message', content: 'hello'}));
      if (frame.type === 'stream_end') resolve();
    });
  });
  client.close();
  await once(client, 'close');
  return sessionId;
};

// A ping sent on connect is a barrier: its pong can only follow every frame the replay wrote.
const connectAndSettle = async (url: string, token?: string): Promise<Frame[]> => {
  const client = open(url, token);
  const frames: Frame[] = [];
  await new Promise<void>(resolve => {
    client.on('message', raw => {
      const frame = JSON.parse(String(raw)) as Frame;
      frames.push(frame);
      if (frame.type === 'connected') client.send(JSON.stringify({type: 'ping', timestamp: 1}));
      if (frame.type === 'pong') resolve();
    });
  });
  return frames;
};

const upserts = (frames: Frame[]) =>
  frames.filter(frame => frame.type === 'entry_upsert').map(({index, entry}) => ({index, entry}));

const shapeOf = (frames: Frame[]) => ({
  keys: Object.keys(frames[0]).sort(),
  resumed: frames[0].resumed,
  types: frames.map(frame => frame.type),
});

const deferredRelease = () => {
  let release = (): void => undefined;
  const until = new Promise<void>(resolve => {
    release = resolve;
  });
  return {until, release: () => release()};
};

describe('resuming a conversation on reconnect', () => {
  it('with resume absent, answers a reconnect naming the first id with a new id and no replay', async () => {
    const {base} = await startEngine(new InMemorySessionStore());
    const first = await firstTurn(base);

    const frames = await connectAndSettle(`${base}?sessionId=${first}`);

    expect({newId: frames[0].sessionId !== first, shape: shapeOf(frames)}).toEqual({
      newId: true,
      shape: {
        keys: ['examplePrompts', 'message', 'sessionId', 'type'],
        resumed: undefined,
        types: ['connected', 'pong'],
      },
    });
  });

  it('with resume on, answers the owner reconnecting with resumed true, entryCount 2 and both stored entries', async () => {
    const store = new InMemorySessionStore();
    const {base} = await startEngine(store, RESUME_ON);
    const first = await firstTurn(base);

    const frames = await connectAndSettle(`${base}?sessionId=${first}`);

    const stored = JSON.parse(JSON.stringify((await store.get(first))?.entries)) as SessionEntry[];
    expect({connected: frames[0], replay: upserts(frames)}).toMatchObject({
      connected: {type: 'connected', sessionId: first, resumed: true, entryCount: 2},
      replay: [
        {index: 0, entry: stored[0]},
        {index: 1, entry: stored[1]},
      ],
    });
  });

  it('answers another user naming the id exactly as it answers an id that was never issued', async () => {
    const {auth, base} = await startEngine(new InMemorySessionStore(), RESUME_ON);
    const first = await firstTurn(base);
    auth.userId = 'u2';

    const otherUser = await connectAndSettle(`${base}?sessionId=${first}`);
    const neverIssued = await connectAndSettle(`${base}?sessionId=${NEVER_ISSUED}`);

    expect({fresh: otherUser[0].sessionId !== first, otherUser: shapeOf(otherUser)}).toEqual({
      fresh: true,
      otherUser: shapeOf(neverIssued),
    });
  });

  it('answers a never-issued id with resumed false and no replay or error', async () => {
    const {base} = await startEngine(new InMemorySessionStore(), RESUME_ON);

    const frames = await connectAndSettle(`${base}?sessionId=${NEVER_ISSUED}`);

    expect(shapeOf(frames)).toEqual({
      keys: ['examplePrompts', 'message', 'resumed', 'sessionId', 'type'],
      resumed: false,
      types: ['connected', 'pong'],
    });
  });

  it('never adopts a requested id as a key: one session, under the id the server minted', async () => {
    const store = new InMemorySessionStore();
    const {base} = await startEngine(store, RESUME_ON);

    const frames = await connectAndSettle(`${base}?sessionId=${NEVER_ISSUED}`);

    expect({
      held: await store.count(),
      adopted: (await store.get(NEVER_ISSUED)) !== undefined,
      minted: (await store.get(frames[0].sessionId ?? '')) !== undefined,
    }).toEqual({held: 1, adopted: false, minted: true});
  });

  it('still calls onDisconnect with the session id when a socket closes under resume', async () => {
    const {disconnected, base} = await startEngine(new InMemorySessionStore(), RESUME_ON);

    const first = await firstTurn(base);
    await eventually(() => disconnected.length > 0);

    expect(disconnected).toEqual([first]);
  });

  it('keeps the credentials of the socket that resumed a session when the socket it replaced closes', async () => {
    const store = new InMemorySessionStore();
    const {base, disconnected, firstServerClose} = await startEngine(store, RESUME_ON);
    const replaced = open(base, 'old');
    const [greeting] = (await once(replaced, 'message')) as [Buffer];
    const sessionId = (JSON.parse(String(greeting)) as Frame).sessionId ?? '';

    const frames = await connectAndSettle(`${base}?sessionId=${sessionId}`, 'new');
    replaced.close();
    await firstServerClose;

    const held = await store.get(sessionId);
    expect({resumed: frames[0].resumed, disconnected, authorization: held?.authHeaders?.authorization}).toEqual({
      resumed: true,
      disconnected: [sessionId],
      authorization: 'Bearer new',
    });
  });

  it('resumes the id its store knows and starts fresh for one it does not', async () => {
    const store = new InMemorySessionStore();
    const known = await store.create('known', 'u1');
    known.entries.push({role: 'user', content: 'earlier', timestamp: '2026-09-30T08:00:00.000Z'});
    const {base} = await startEngine(store, RESUME_ON);

    const resumed = await connectAndSettle(`${base}?sessionId=known`);
    const fresh = await connectAndSettle(`${base}?sessionId=unknown`);

    expect({resumed: resumed[0], fresh: fresh[0]}).toMatchObject({
      resumed: {sessionId: 'known', resumed: true, entryCount: 1},
      fresh: {resumed: false},
    });
  });

  it('replays a suppressed entry as a skip, so the client never sees text a tool suppressed', async () => {
    const store = new InMemorySessionStore();
    const known = await store.create('known', 'u1');
    known.entries.push(
      {role: 'user', content: 'hello', timestamp: '2026-09-30T08:00:00.000Z'},
      {
        role: 'assistant',
        content: 'hidden',
        timestamp: '2026-09-30T08:00:01.000Z',
        isStreaming: false,
        suppressed: true,
      }
    );
    const {base} = await startEngine(store, RESUME_ON);

    const frames = await connectAndSettle(`${base}?sessionId=known`);

    expect({
      types: frames.map(({type, index}) => (index === undefined ? type : `${type} ${index}`)),
      leaked: JSON.stringify(frames).includes('hidden'),
    }).toEqual({types: ['connected', 'entry_upsert 0', 'entry_skip 1', 'pong'], leaked: false});
  });

  it('replays an answer suppressed while it was still open as a skip, never the text it gathered after', async () => {
    const {base} = await startEngine(new InMemorySessionStore(), RESUME_ON, suppressingMidAnswer);
    const first = await firstTurn(base);

    const frames = await connectAndSettle(`${base}?sessionId=${first}`);

    expect({
      types: frames.map(({type, index}) => (index === undefined ? type : `${type} ${index}`)),
      leaked: JSON.stringify(frames).includes('after'),
    }).toEqual({types: ['connected', 'entry_upsert 0', 'entry_skip 1', 'pong'], leaked: false});
  });

  it('replays an entry whose turn is still running as finished and truncated, leaving the stored entry as it is', async () => {
    const store = new InMemorySessionStore();
    const known = await store.create('known', 'u1');
    known.entries.push({role: 'user', content: 'hello', timestamp: '2026-09-30T08:00:00.000Z'}, {...HALF_ANSWER});
    const {base} = await startEngine(store, RESUME_ON);

    const frames = await connectAndSettle(`${base}?sessionId=known`);

    expect({replayed: upserts(frames)[1], stored: known.entries[1]}).toEqual({
      replayed: {index: 1, entry: {...HALF_ANSWER, isStreaming: false, truncated: true}},
      stored: HALF_ANSWER,
    });
  });

  it('keeps a resumed session whose socket closed before the replay, rather than evicting it', async () => {
    const inner = new InMemorySessionStore();
    const known = await inner.create('known', 'u1');
    known.entries.push({role: 'user', content: 'earlier', timestamp: '2026-09-30T08:00:00.000Z'});
    const lookupHeld = deferredRelease();
    const evicted: string[] = [];
    const store: SessionStore = {
      create: (sessionId, userId, options) => inner.create(sessionId, userId, options),
      get: async sessionId => {
        await lookupHeld.until;
        return inner.get(sessionId);
      },
      delete: sessionId => inner.delete(sessionId),
      count: () => inner.count(),
      clear: () => inner.clear(),
      evict: sessionId => {
        evicted.push(sessionId);
        return inner.evict(sessionId);
      },
    };
    const {base, firstServerClose} = await startEngine(store, RESUME_ON);

    const client = open(`${base}?sessionId=known`);
    await once(client, 'open');
    // Terminated, not closed: the server holds the socket paused across the lookup, so it never reads a close frame.
    client.terminate();
    await firstServerClose;
    lookupHeld.release();
    await new Promise(resolve => setTimeout(resolve, 50));

    const kept = inner.get('known');
    expect({evicted, kept: kept?.entries.length}).toEqual({evicted: [], kept: 1});
  });

  it('with resume off, still completes a handshake at /hal/ws/undefined and mints an id', async () => {
    const {base} = await startEngine(new InMemorySessionStore());

    const frames = await connectAndSettle(`${base}/undefined`);

    expect(frames[0]).toMatchObject({type: 'connected', sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/)});
  });

  it('still types a connected frame literal that carries neither resume field', () => {
    const legacy: ConnectedMessage = {type: 'connected', sessionId: 's1', message: 'hi', examplePrompts: []};

    expect(Object.keys(legacy)).toEqual(['type', 'sessionId', 'message', 'examplePrompts']);
  });
});
