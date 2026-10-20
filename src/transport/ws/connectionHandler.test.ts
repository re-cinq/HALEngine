import {jest} from '@jest/globals';
import {
  createConnectionHandler,
  DEFAULT_CONNECT_MESSAGE,
  type ConnectionHandlerDeps,
  type ExtWebSocket,
} from './connectionHandler.js';
import type {ChatSession} from '../../types/session.js';
import type {SessionStore} from '../../types/sessionStore.js';
import type {WsAuthenticator} from '../../types/auth.js';
import {captureErrors} from '../../shared/logCaptureTestSupport.js';
import {recordingSocket} from './recordingSocketTestSupport.js';

// Pins the lifecycle hooks: that onConnect is called at all, when, and that neither hook can kill a connection.

// Drains the microtask queue the hook is deferred onto.
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

type HarnessOptions = Partial<Pick<ConnectionHandlerDeps, 'onConnect' | 'onDisconnect' | 'sessionStore'>> & {
  connectMessage?: string;
};

const harness = ({connectMessage, ...options}: HarnessOptions = {}) => {
  const socket = recordingSocket({userId: 'u1', isAlive: true});
  const ws = socket.ws as ExtWebSocket;

  const deleted: string[] = [];
  const sessionStore = {
    create: (sessionId: string, userId: string | number): ChatSession => ({sessionId, userId, entries: []}),
    delete: (sessionId: string) => (deleted.push(sessionId), true),
  } as unknown as SessionStore;

  const deps = {
    wsAuth: jest.fn(),
    sessionStore,
    handleMessage: jest.fn(),
    basePath: '/hal',
    ...options,
  } as unknown as ConnectionHandlerDeps;

  const connect = () => createConnectionHandler(deps, {examplePrompts: [], connectMessage})(ws);

  return {
    connect,
    sent: socket.sent,
    deleted,
    handleMessage: deps.handleMessage as jest.Mock,
    close: socket.close,
    receive: socket.receive,
  };
};

describe('the websocket connection handler', () => {
  describe('the connected frame', () => {
    it('sends DEFAULT_CONNECT_MESSAGE in a frame byte-identical to the release before when no connectMessage is set', async () => {
      const {connect, sent, close} = harness();

      connect();
      await settle();
      close();
      await settle();

      const expected = new RegExp(
        `^\\{"type":"connected","sessionId":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}","message":"${DEFAULT_CONNECT_MESSAGE}","examplePrompts":\\[\\]\\}$`
      );
      expect(expected.test(JSON.stringify(sent[0]))).toBe(true);
    });

    it('sends a set connectMessage character for character, diacritics included, as the first frame with type and examplePrompts unchanged', async () => {
      const disclosure = 'Du skriver med en AI-assistent, ikke et menneske. Æ, ø og å.';
      const {connect, sent, close} = harness({connectMessage: disclosure});

      connect();
      await settle();
      close();
      await settle();

      expect({count: sent.length, first: sent[0]}).toMatchObject({
        count: 1,
        first: {type: 'connected', message: disclosure, examplePrompts: []},
      });
    });
  });

  describe('onConnect', () => {
    it('is called once for an accepted connection, with the session the socket was given', async () => {
      const seen: ChatSession[] = [];
      const {connect, sent} = harness({onConnect: session => void seen.push(session)});

      connect();
      await settle();

      const frame = sent[0] as {type: string; sessionId: string};
      expect({calls: seen.length, sessionId: seen[0]?.sessionId}).toEqual({calls: 1, sessionId: frame.sessionId});
    });

    // A REST chat id is not a socket session id: the socket mints its own, so neither can be guessed
    it('mints a fresh session id per connection rather than reusing one', async () => {
      const first = harness();
      const second = harness();

      first.connect();
      second.connect();
      await settle();

      const id = (frame: unknown) => (frame as {sessionId: string}).sessionId;
      expect(id(first.sent[0]) === id(second.sent[0])).toBe(false);
    });

    // Counted inside the hook: the connected frame is sent after an awaited create, so no synchronous read sees it.
    it('runs after the connected frame is sent, not before it', async () => {
      const framesAtHook: number[] = [];
      let frames: unknown[] = [];
      const {connect, sent} = harness({onConnect: () => void framesAtHook.push(frames.length)});
      frames = sent;

      connect();
      await settle();

      expect(framesAtHook).toEqual([1]);
    });

    it('is deferred, so it never runs inside the connection listener', () => {
      const order: string[] = [];
      const {connect} = harness({onConnect: () => void order.push('hook')});

      connect();

      expect(order).toEqual([]);
    });

    it('survives a hook that throws synchronously', async () => {
      const {connect} = harness({
        onConnect: () => {
          throw new Error('hook exploded');
        },
      });

      connect();

      await expect(settle()).resolves.toBeUndefined();
    });

    it('survives a hook that rejects', async () => {
      const {connect} = harness({onConnect: () => Promise.reject(new Error('hook rejected'))});

      connect();

      await expect(settle()).resolves.toBeUndefined();
    });

    it('is optional, so a connection without one still sends its frame', async () => {
      const {connect, sent} = harness();

      connect();
      await settle();

      expect(sent.length).toBe(1);
    });
  });

  describe('onDisconnect', () => {
    // The close path erases nothing now, so the hook is the only thing a consumer can hang cleanup on.
    it('is called with the session id while the store still holds the session', async () => {
      const seen: string[] = [];
      const {connect, sent, close, deleted} = harness({onDisconnect: id => void seen.push(id)});

      connect();
      await settle();
      const {sessionId} = sent[0] as {sessionId: string};
      close();
      await settle();

      expect({seen, deleted}).toEqual({seen: [sessionId], deleted: []});
    });

    it('does not let a throwing hook escape the close listener', () => {
      const {connect, close} = harness({
        onDisconnect: () => {
          throw new Error('hook exploded');
        },
      });
      connect();

      expect(() => close()).not.toThrow();
    });

    it('does not let a rejecting hook reach the process', async () => {
      const {connect, close} = harness({onDisconnect: () => Promise.reject(new Error('hook rejected'))});
      connect();

      close();

      await expect(settle()).resolves.toBeUndefined();
    });
  });

  describe('the connection signal', () => {
    it('hands every message on a connection the same signal, and each connection its own', async () => {
      const first = harness();
      const second = harness();
      first.connect();
      second.connect();
      await settle();

      first.receive(JSON.stringify({type: 'ping', timestamp: 1}));
      first.receive(JSON.stringify({type: 'ping', timestamp: 2}));
      second.receive(JSON.stringify({type: 'ping', timestamp: 3}));

      const {calls: firstCalls} = first.handleMessage.mock;
      const {calls: secondCalls} = second.handleMessage.mock;
      const [one, two, other] = [...firstCalls, ...secondCalls].map(call => call[3]);
      expect({isSignal: one instanceof AbortSignal, shared: one === two, own: one !== other}).toEqual({
        isSignal: true,
        shared: true,
        own: true,
      });
    });

    it('aborts the connection signal when its socket closes, before onDisconnect is called', async () => {
      const abortedAtDisconnect: unknown[] = [];
      const handed: {signal?: AbortSignal} = {};
      const {connect, receive, close, handleMessage} = harness({
        onDisconnect: () => void abortedAtDisconnect.push(handed.signal?.aborted),
      });
      connect();
      await settle();
      receive(JSON.stringify({type: 'ping', timestamp: 1}));
      const {calls} = handleMessage.mock;
      handed.signal = calls[0]?.[3] as AbortSignal | undefined;
      const beforeClose = handed.signal?.aborted;

      close();

      expect({beforeClose, abortedAtDisconnect}).toEqual({beforeClose: false, abortedAtDisconnect: [true]});
    });
  });

  describe('inbound frames', () => {
    it('answers unparseable JSON with INVALID_FORMAT alone and never dispatches it', async () => {
      const {connect, sent, receive, handleMessage} = harness();
      connect();
      // The message listener is attached once the awaited create resolves.
      await settle();

      receive('{"type": "user_message", "content": ');

      const types = sent.slice(1).map(frame => ('code' in frame ? frame.code : undefined) ?? 'no code');
      const {calls} = handleMessage.mock;
      expect({afterConnected: types, dispatched: calls.length}).toEqual({
        afterConnected: ['INVALID_FORMAT'],
        dispatched: 0,
      });
    });
  });
});

// A durable erase that fails silently would be recorded as done, so the close path has to report it.
describe('a session store that fails to release', () => {
  const errors = captureErrors();

  it('logs a rejecting evict rather than dropping it', async () => {
    const evicted: string[] = [];
    const sessionStore = {
      create: async (sessionId: string, userId: string | number): Promise<ChatSession> => {
        await settle();
        return {sessionId, userId, entries: []};
      },
      evict: (sessionId: string) => {
        evicted.push(sessionId);
        return Promise.reject(new Error('store unreachable'));
      },
    } as unknown as SessionStore;
    const {connect, close} = harness({sessionStore});

    connect();
    close();
    await settle();
    await settle();

    expect(errors).toEqual([
      {category: 'ws', message: 'session evict failed', sessionId: evicted[0], error: 'store unreachable'},
    ]);
  });

  it('stays silent for a connection that was never handed a session', async () => {
    const seen: string[] = [];
    const sessionStore = {
      create: () => Promise.reject(new Error('store down')),
      delete: () => true,
    } as unknown as SessionStore;
    const {connect, close} = harness({sessionStore, onDisconnect: id => void seen.push(id)});

    connect();
    await settle();
    close();
    await settle();

    expect(seen).toEqual([]);
  });

  it('clears the credentials of a session whose socket closed before it was delivered', async () => {
    const created: ChatSession[] = [];
    const sessionStore = {
      create: async (sessionId: string, userId: string | number): Promise<ChatSession> => {
        await settle();
        const session: ChatSession = {sessionId, userId, entries: [], authHeaders: {authorization: 'Bearer t'}};
        created.push(session);
        return session;
      },
    } as unknown as SessionStore;
    const {connect, close} = harness({sessionStore});

    connect();
    close();
    await settle();
    await settle();

    expect(created.map(session => session.authHeaders)).toEqual([undefined]);
  });

  // One socket whose send throws, driven twice: once for what the socket sees, once for what the store keeps.
  const setupThatFails = (sessionStore: SessionStore) => {
    const calls: string[] = [];
    const listeners = new Map<string, (arg?: unknown) => void>();
    const ws = {
      userId: 'u1',
      isAlive: true,
      send: () => {
        throw new Error('socket gone');
      },
      on: (event: string, fn: (arg?: unknown) => void) => listeners.set(event, fn),
      pause: () => void calls.push('pause'),
      resume: () => void calls.push('resume'),
      close: () => void calls.push('close'),
    } as unknown as ExtWebSocket;
    const deps = {
      wsAuth: jest.fn(),
      sessionStore,
      handleMessage: jest.fn(),
      basePath: '/hal',
    } as unknown as ConnectionHandlerDeps;

    createConnectionHandler(deps, {examplePrompts: []})(ws);
    return calls;
  };

  const holdingStore = (evicted: string[]) =>
    ({
      create: (sessionId: string, userId: string | number): ChatSession => ({sessionId, userId, entries: []}),
      evict: (sessionId: string) => (evicted.push(sessionId), true),
    }) as unknown as SessionStore;

  it('does not strand a paused socket when connection setup throws', async () => {
    const calls = setupThatFails(holdingStore([]));

    await settle();

    expect(calls).toEqual(['pause', 'resume', 'close']);
  });

  it('evicts a session it created but could not hand over', async () => {
    const evicted: string[] = [];

    setupThatFails(holdingStore(evicted));
    await settle();

    expect(evicted).toHaveLength(1);
  });
});

describe('the websocket upgrade handler non-scalar id guard', () => {
  const errors = captureErrors();

  const upgradeWithId = async (id: unknown): Promise<{upgraded: boolean; written: string[]}> => {
    let upgraded = false;
    const written: string[] = [];
    const wss = {
      handleUpgrade: () => void (upgraded = true),
    } as unknown as WebSocketServer;
    const socket = {
      write: (responseChunk: string) => written.push(responseChunk),
      destroy: () => undefined,
    } as unknown as Duplex;
    const request = {headers: {host: 'localhost'}, url: '/hal/ws'} as unknown as IncomingMessage;
    const wsAuth: WsAuthenticator = _req => Promise.resolve({id} as unknown as AuthenticatedUser);
    const deps = {
      wsAuth,
      sessionStore: {} as SessionStore,
      handleMessage: jest.fn(),
      basePath: '/hal',
    } as unknown as ConnectionHandlerDeps;
    createUpgradeHandler(wss, deps)(request, socket, Buffer.from(''));
    await settle();
    return {upgraded, written};
  };

  it('logs the type of a refused non-scalar id and never its contents', async () => {
    const sensitiveId = {$ne: null, secret: 'SENSITIVE-PAYLOAD'};
    const {upgraded} = await upgradeWithId(sensitiveId);
    const errorsJson = JSON.stringify(errors);
    expect({
      upgraded,
      hasRefusalError: errors.length > 0,
      leakedSecret: errorsJson.includes('SENSITIVE-PAYLOAD'),
      leakedOperator: errorsJson.includes('$ne'),
      loggedType: errorsJson.includes('object'),
    }).toEqual({
      upgraded: false,
      hasRefusalError: true,
      leakedSecret: false,
      leakedOperator: false,
      loggedType: true,
    });
  });
});
