import {jest} from '@jest/globals';
import {createConnectionHandler, type ConnectionHandlerDeps, type ExtWebSocket} from './connectionHandler.js';
import type {ChatSession} from '../../types/session.js';
import type {SessionStore} from '../../types/sessionStore.js';

// Pins the lifecycle hooks: that onConnect is called at all, when, and that neither hook can kill a connection.

// Drains the microtask queue the hook is deferred onto.
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const harness = (hooks: Partial<Pick<ConnectionHandlerDeps, 'onConnect' | 'onDisconnect'>> = {}) => {
  const sent: string[] = [];
  const listeners = new Map<string, (arg?: unknown) => void>();

  const ws = {
    userId: 'u1',
    isAlive: true,
    send: (raw: string) => sent.push(raw),
    on: (event: string, fn: (arg?: unknown) => void) => listeners.set(event, fn),
  } as unknown as ExtWebSocket;

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
    ...hooks,
  } as unknown as ConnectionHandlerDeps;

  const connect = () => createConnectionHandler(deps, [])(ws);

  return {connect, sent, deleted, close: () => listeners.get('close')?.()};
};

describe('the websocket connection handler', () => {
  describe('onConnect', () => {
    it('is called once for an accepted connection, with the session the socket was given', async () => {
      const seen: ChatSession[] = [];
      const {connect, sent} = harness({onConnect: session => void seen.push(session)});

      connect();
      await settle();

      const frame = JSON.parse(sent[0]) as {type: string; sessionId: string};
      expect({calls: seen.length, sessionId: seen[0]?.sessionId}).toEqual({calls: 1, sessionId: frame.sessionId});
    });

    // A REST chat id is not a socket session id: the socket mints its own, so neither can be guessed
    it('mints a fresh session id per connection rather than reusing one', async () => {
      const first = harness();
      const second = harness();

      first.connect();
      second.connect();

      const id = (raw: string) => (JSON.parse(raw) as {sessionId: string}).sessionId;
      expect(id(first.sent[0]) === id(second.sent[0])).toBe(false);
    });

    it('runs after the connected frame is sent, not before it', async () => {
      const order: string[] = [];
      const {connect, sent} = harness({onConnect: () => void order.push('hook')});

      connect();
      order.push(`frames:${sent.length}`);
      await settle();

      expect(order).toEqual(['frames:1', 'hook']);
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
    it('is called with the session id after the store entry is deleted', async () => {
      const seen: string[] = [];
      const {connect, close, deleted} = harness({onDisconnect: id => void seen.push(id)});

      connect();
      close();
      await settle();

      expect({seen, deleted}).toEqual({seen: deleted, deleted: [deleted[0]]});
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
});
