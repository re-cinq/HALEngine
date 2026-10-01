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
  resumeFailure?: string;
  index?: number;
  entry?: SessionEntry;
}

const NEVER_ISSUED = '0f1e2d3c-4b5a-4968-8776-655443322110';
const RESUME_ON: SessionResumeOptions = {enabled: true};
const LATEST_ON: SessionResumeOptions = {enabled: true, latest: true};
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
  const connects: Array<{sessionId: string; resumed: boolean}> = [];
  const disconnected: string[] = [];
  const hal = createServer({
    app: (() => undefined) as unknown as Express,
    wsAuth: async () => ({id: auth.userId}),
    sessionStore: store,
    orchestrator,
    resume,
    onConnect: (session, {resumed}) => void connects.push({sessionId: session.sessionId, resumed}),
    onDisconnect: sessionId => void disconnected.push(sessionId),
  });
  // Resolves once the server itself has seen its first socket close, which the client's own close can precede.
  const firstServerClose = new Promise<void>(resolve => {
    hal.wss.once('connection', socket => socket.once('close', () => resolve()));
  });
  await hal.start(0);
  servers.push(hal);
  const {port} = hal.server.address() as AddressInfo;
  return {auth, connects, disconnected, firstServerClose, base: `ws://127.0.0.1:${port}/hal/ws`};
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
  resumeFailure: frames[0].resumeFailure,
  types: frames.map(frame => frame.type),
});

const deferredRelease = () => {
  let release = (): void => undefined;
  const until = new Promise<void>(resolve => {
    release = resolve;
  });
  return {until, release: () => release()};
};

// Each stored conversation holds one user entry, sent at the given time and reading as its own id.
const storeWith = (conversations: Array<[sessionId: string, userId: string, sentAt: string]>): InMemorySessionStore => {
  const store = new InMemorySessionStore();
  for (const [sessionId, userId, sentAt] of conversations) {
    const {entries} = store.create(sessionId, userId);
    entries.push({role: 'user', content: sessionId, timestamp: sentAt});
  }
  return store;
};

// A store with only the required members, so an optional one can be added, replaced or left out per test.
const delegatingTo = (inner: InMemorySessionStore): SessionStore => ({
  create: (sessionId, userId, options) => inner.create(sessionId, userId, options),
  get: sessionId => inner.get(sessionId),
  delete: sessionId => inner.delete(sessionId),
  count: () => inner.count(),
  clear: () => inner.clear(),
});

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

  it('answers a never-issued id with resumed false, resumeFailure unknown, and no replay or error', async () => {
    const {base} = await startEngine(new InMemorySessionStore(), RESUME_ON);

    const frames = await connectAndSettle(`${base}?sessionId=${NEVER_ISSUED}`);

    expect(shapeOf(frames)).toEqual({
      keys: ['examplePrompts', 'message', 'resumeFailure', 'resumed', 'sessionId', 'type'],
      resumed: false,
      resumeFailure: 'unknown',
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

  it('gives a session back the credentials of a socket still open when the socket that resumed it closes', async () => {
    const store = new InMemorySessionStore();
    const {base} = await startEngine(store, RESUME_ON);
    const first = open(base, 'first');
    const [greeting] = (await once(first, 'message')) as [Buffer];
    const sessionId = (JSON.parse(String(greeting)) as Frame).sessionId ?? '';
    const second = open(`${base}?sessionId=${sessionId}`, 'second');
    await once(second, 'message');
    const held = await store.get(sessionId);
    const whileBothOpen = held?.authHeaders?.authorization;

    second.close();
    await eventually(() => held?.authHeaders?.authorization !== whileBothOpen);

    expect({whileBothOpen, afterSecondCloses: held?.authHeaders?.authorization}).toEqual({
      whileBothOpen: 'Bearer second',
      afterSecondCloses: 'Bearer first',
    });
  });

  it('tells onConnect whether a connection started its session or resumed it', async () => {
    const {base, connects} = await startEngine(new InMemorySessionStore(), RESUME_ON);
    const first = await firstTurn(base);

    await connectAndSettle(`${base}?sessionId=${first}`);

    expect(connects).toEqual([
      {sessionId: first, resumed: false},
      {sessionId: first, resumed: true},
    ]);
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

  it('replays an answer suppressed while it was still open as skips, as blank as the live client was left', async () => {
    const {base} = await startEngine(new InMemorySessionStore(), RESUME_ON, suppressingMidAnswer);
    const first = await firstTurn(base);

    const frames = await connectAndSettle(`${base}?sessionId=${first}`);

    const replayed = JSON.stringify(frames);
    expect({
      types: frames.map(({type, index}) => (index === undefined ? type : `${type} ${index}`)),
      leaked: ['before', 'after'].filter(word => replayed.includes(word)),
    }).toEqual({types: ['connected', 'entry_upsert 0', 'entry_skip 1', 'entry_skip 2', 'pong'], leaked: []});
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

describe('continuing the latest session', () => {
  it('with latest on, rejoins the most recently active session of a user whose connect names none', async () => {
    const store = storeWith([
      ['older', 'u1', '2026-09-30T08:00:00.000Z'],
      ['newer', 'u1', '2026-09-30T09:00:00.000Z'],
      ['theirs', 'u2', '2026-09-30T10:00:00.000Z'],
    ]);
    const {base, connects} = await startEngine(store, LATEST_ON);

    const frames = await connectAndSettle(base);

    expect({connected: frames[0], replay: upserts(frames), connects}).toMatchObject({
      connected: {sessionId: 'newer', resumed: true, entryCount: 1},
      replay: [{index: 0, entry: {role: 'user', content: 'newer'}}],
      connects: [{sessionId: 'newer', resumed: true}],
    });
  });

  it('with latest on, starts a new session for a user with none, and on ?new=1 even when one exists', async () => {
    const store = storeWith([['known', 'u1', '2026-09-30T08:00:00.000Z']]);
    const {auth, base} = await startEngine(store, LATEST_ON);

    const asked = await connectAndSettle(`${base}?new=1`);
    auth.userId = 'u2';
    const firstVisit = await connectAndSettle(base);

    expect({
      asked: {resumed: asked[0].resumed, minted: asked[0].sessionId !== 'known'},
      firstVisit: {resumed: firstVisit[0].resumed, minted: firstVisit[0].sessionId !== 'known'},
      held: store.count(),
    }).toEqual({asked: {resumed: false, minted: true}, firstVisit: {resumed: false, minted: true}, held: 3});
  });

  it('with latest on, still rejoins the session a connect names rather than the latest one', async () => {
    const store = storeWith([
      ['older', 'u1', '2026-09-30T08:00:00.000Z'],
      ['newer', 'u1', '2026-09-30T09:00:00.000Z'],
    ]);
    const {base} = await startEngine(store, LATEST_ON);

    const frames = await connectAndSettle(`${base}?sessionId=older`);

    expect(frames[0]).toMatchObject({sessionId: 'older', resumed: true});
  });

  it("starts a new session when the store's latestFor answers another user's session, throws, or is absent", async () => {
    const inner = storeWith([['theirs', 'u2', '2026-09-30T08:00:00.000Z']]);
    const stores: Record<string, SessionStore> = {
      stranger: {...delegatingTo(inner), latestFor: () => inner.get('theirs')},
      failing: {
        ...delegatingTo(inner),
        latestFor: () => {
          throw new Error('database down');
        },
      },
      absent: delegatingTo(inner),
    };

    const outcomes: Record<string, unknown> = {};
    for (const [name, store] of Object.entries(stores)) {
      const {base} = await startEngine(store, LATEST_ON);
      const [connected] = await connectAndSettle(base);
      outcomes[name] = {resumed: connected.resumed, minted: connected.sessionId !== 'theirs'};
    }

    const fresh = {resumed: false, minted: true};
    expect(outcomes).toEqual({stranger: fresh, failing: fresh, absent: fresh});
  });

  it('with resume on but latest off, starts a new session for a connect that names none', async () => {
    const store = storeWith([['known', 'u1', '2026-09-30T08:00:00.000Z']]);
    const {base} = await startEngine(store, RESUME_ON);

    const [connected] = await connectAndSettle(base);

    expect({resumed: connected.resumed, minted: connected.sessionId !== 'known'}).toEqual({
      resumed: false,
      minted: true,
    });
  });
});

// A store whose only session, the one u1 had, outlived its one-millisecond lifetime before anyone asked for it.
const agedOut = async (): Promise<InMemorySessionStore> => {
  const store = new InMemorySessionStore({maxAgeMs: 1});
  const {entries} = store.create('known', 'u1');
  entries.push({role: 'user', content: 'my booking 4711', timestamp: '2026-09-30T08:00:00.000Z'});
  await new Promise(resolve => setTimeout(resolve, 20));
  return store;
};

describe('telling an expired session apart', () => {
  it('tells the owner of a session that aged out that it expired, with a new id and no replay', async () => {
    const {base} = await startEngine(await agedOut(), RESUME_ON);

    const frames = await connectAndSettle(`${base}?sessionId=known`);

    expect({
      connected: frames[0],
      minted: frames[0].sessionId !== 'known',
      replayed: upserts(frames).length,
    }).toMatchObject({
      connected: {resumed: false, resumeFailure: 'expired'},
      minted: true,
      replayed: 0,
    });
  });

  it('answers another user naming an expired id exactly as it answers an id never issued', async () => {
    const {auth, base} = await startEngine(await agedOut(), RESUME_ON);
    auth.userId = 'u2';

    const expired = await connectAndSettle(`${base}?sessionId=known`);
    const neverIssued = await connectAndSettle(`${base}?sessionId=${NEVER_ISSUED}`);

    expect({expired: shapeOf(expired), failure: expired[0].resumeFailure}).toEqual({
      expired: shapeOf(neverIssued),
      failure: 'unknown',
    });
  });

  it('sends no resumeFailure at all when the connect names no id, even with no latest session to rejoin', async () => {
    const {base} = await startEngine(new InMemorySessionStore(), LATEST_ON);

    const [connected] = await connectAndSettle(base);

    expect({resumed: connected.resumed, failureKey: 'resumeFailure' in connected}).toEqual({
      resumed: false,
      failureKey: false,
    });
  });

  it('reads a named id with one call per attempt: lookup when the store has it, get otherwise', async () => {
    const inner = storeWith([['known', 'u1', '2026-09-30T08:00:00.000Z']]);
    const calls: string[] = [];
    const fiveMembers: SessionStore = {
      ...delegatingTo(inner),
      get: sessionId => {
        calls.push('get');
        return inner.get(sessionId);
      },
    };
    const withLookup: SessionStore = {
      ...fiveMembers,
      lookup: sessionId => {
        calls.push('lookup');
        return inner.lookup(sessionId);
      },
    };

    const outcomes: Record<string, unknown> = {};
    for (const [name, store] of Object.entries({fiveMembers, withLookup})) {
      const {base} = await startEngine(store, RESUME_ON);
      const [live] = await connectAndSettle(`${base}?sessionId=known`);
      const [dead] = await connectAndSettle(`${base}?sessionId=${NEVER_ISSUED}`);
      outcomes[name] = {live: live.resumed, dead: dead.resumeFailure};
    }

    const answered = {live: true, dead: 'unknown'};
    expect({outcomes, calls}).toEqual({
      outcomes: {fiveMembers: answered, withLookup: answered},
      calls: ['get', 'get', 'lookup', 'lookup'],
    });
  });
});
