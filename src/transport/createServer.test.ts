import {jest} from '@jest/globals';
import type {Express} from 'express';
import {createServer} from './createServer.js';
import type {ExtWebSocket} from './ws/connectionHandler.js';
import type {ChatSession} from '../types/session.js';
import type {SessionStore} from '../types/sessionStore.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import type {WsAuthenticator} from '../types/auth.js';

// The defect this pins is an omission: both hooks are declared on HalServerOptions, and one was never forwarded.

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const harness = (onConnect?: (session: ChatSession) => void) => {
  const sessionStore = {
    create: (sessionId: string, userId: string | number): ChatSession => ({sessionId, userId, entries: []}),
    delete: () => true,
  } as unknown as SessionStore;

  const hal = createServer({
    app: (() => undefined) as unknown as Express,
    wsAuth: jest.fn() as unknown as WsAuthenticator,
    sessionStore,
    orchestrator: {} as ChatOrchestrator,
    onConnect,
  });

  const ws = {
    userId: 'u1',
    isAlive: true,
    send: () => undefined,
    on: () => undefined,
  } as unknown as ExtWebSocket;

  return {hal, ws};
};

describe('createServer hook wiring', () => {
  it('forwards onConnect to the connection handler', async () => {
    const seen: ChatSession[] = [];
    const {hal, ws} = harness(session => void seen.push(session));

    hal.wss.emit('connection', ws);
    await settle();
    hal.wss.emit('close');

    expect(seen.length).toBe(1);
  });

  it('accepts a server configured without either hook', async () => {
    const {hal, ws} = harness();

    hal.wss.emit('connection', ws);
    await settle();
    hal.wss.emit('close');

    expect(hal.wss.listenerCount('connection')).toBe(1);
  });
});
