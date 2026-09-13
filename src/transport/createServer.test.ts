import {jest} from '@jest/globals';
import net from 'node:net';
import {setLogger} from '../shared/logger.js';
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

// An EventEmitter with no `error` listener throws, so a socket error on a running server ended the process.
describe('a server error after start', () => {
  const engineLines: string[] = [];

  beforeEach(() => {
    engineLines.length = 0;
    const collect = (_category: string, message: string) => void engineLines.push(message);
    setLogger({debug: collect, info: collect, warn: collect, error: collect});
  });

  afterEach(() => {
    setLogger();
  });

  const started = async () => {
    const {hal} = harness();
    await hal.start(0);
    return hal;
  };

  // A stopped engine and a port something else holds, so the next start is refused by the OS.
  const refusedStart = async () => {
    const hal = await started();
    await hal.stop();
    const blocker = net.createServer();
    await new Promise<void>(resolve => blocker.listen(0, resolve));
    const taken = (blocker.address() as net.AddressInfo).port;
    const release = () => new Promise<void>(resolve => blocker.close(() => resolve()));
    return {hal, taken, release};
  };

  it('is reported rather than ending the process', async () => {
    const hal = await started();

    hal.server.emit('error', new Error('late failure'));
    await hal.stop();

    expect(engineLines).toContain('server error after start');
  });

  it('leaves exactly one listener behind, however many times the server is restarted', async () => {
    const hal = await started();
    await hal.stop();
    await hal.start(0);

    const count = hal.server.listenerCount('error');
    await hal.stop();

    expect(count).toBe(1);
  });

  it('is still reported after stop, because an error with no handler ends the process', async () => {
    const hal = await started();
    await hal.stop();

    hal.server.emit('error', new Error('after stop'));

    expect(engineLines).toContain('server error after start');
  });

  it('is not reported for a start that was cleanly refused, because nothing was running', async () => {
    const {hal, taken, release} = await refusedStart();

    await hal.start(taken).catch((error: NodeJS.ErrnoException) => engineLines.push(`rejected ${error.code}`));
    await release();

    expect(engineLines).toEqual(['HAL Engine started', 'rejected EADDRINUSE']);
  });

  it('stops cleanly after a refused start, so a finally block does not turn one failure into two', async () => {
    const {hal, taken, release} = await refusedStart();
    await hal.start(taken).catch(() => undefined);

    const stopped = hal.stop().then(
      () => 'resolved',
      (error: NodeJS.ErrnoException) => `rejected ${error.code}`
    );
    await release();

    await expect(stopped).resolves.toBe('resolved');
  });

  it('refuses a second start without stripping the running server of its handler', async () => {
    const hal = await started();

    await hal.start(0).catch((error: Error) => engineLines.push(`rejected ${error.message}`));
    hal.server.emit('error', new Error('after the refused start'));
    await hal.stop();

    expect(engineLines).toEqual([
      'HAL Engine started',
      'rejected HAL Engine is already started',
      'server error after start',
    ]);
  });
});
