import net from 'node:net';
import type {AddressInfo} from 'node:net';
import type {Express} from 'express';
import {createServer} from './createServer.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import type {WsAuthenticator} from '../types/auth.js';
import {setLogger} from '../shared/logger.js';

// Raw requests over a real socket: a ws client always sends a Host and a valid target, so it cannot send these.

const admitEveryone: WsAuthenticator = async () => ({id: 'u1'});
const REPLY_WAIT_MS = 2_000;

const upgradeRequest = (target: string, hostLine: string): string =>
  `GET ${target} HTTP/1.1\r\n${hostLine}Connection: Upgrade\r\nUpgrade: websocket\r\n` +
  'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';

// The first status line the server writes back, or a marker when it writes nothing, so a regression fails, not hangs.
const statusLineFor = async (wsAuth: WsAuthenticator, request: string): Promise<string> => {
  const hal = createServer({
    app: (() => undefined) as unknown as Express,
    wsAuth,
    sessionStore: new InMemorySessionStore(),
    orchestrator: {} as ChatOrchestrator,
  });
  // Only an upgraded request opens a connection; waiting on its close keeps its log line inside the test.
  const serverClosed = new Promise<void>(resolve => {
    hal.wss.once('connection', connection => connection.once('close', () => resolve()));
  });
  await hal.start(0);
  const {port} = hal.server.address() as AddressInfo;
  const reply = await new Promise<string>(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    const finish = (line: string): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(line);
    };
    const timer = setTimeout(() => finish('(no reply)'), REPLY_WAIT_MS);
    socket.once('data', chunk => finish(String(chunk).split('\r\n')[0]));
    socket.once('close', () => finish('(closed without a reply)'));
  });
  await Promise.race([serverClosed, new Promise(resolve => setTimeout(resolve, 50))]);
  await hal.stop();
  return reply;
};

describe('an upgrade request the server cannot read', () => {
  beforeAll(() => {
    setLogger({debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined});
  });

  afterAll(() => {
    setLogger();
  });

  it('answers an empty Host, a missing Host and a // target with 400 instead of throwing out of the upgrade listener', async () => {
    const replies = {
      emptyHost: await statusLineFor(admitEveryone, upgradeRequest('/hal/ws', 'Host:\r\n')),
      absentHost: await statusLineFor(admitEveryone, upgradeRequest('/hal/ws', '')),
      doubleSlash: await statusLineFor(admitEveryone, upgradeRequest('//', 'Host: example.com\r\n')),
    };

    expect(replies).toEqual({
      emptyHost: 'HTTP/1.1 400 Bad Request',
      absentHost: 'HTTP/1.1 400 Bad Request',
      doubleSlash: 'HTTP/1.1 400 Bad Request',
    });
  });

  it('answers 500 when the authenticator throws synchronously instead of rejecting', async () => {
    const throwsSynchronously: WsAuthenticator = () => {
      throw new Error('authenticator bug');
    };

    const reply = await statusLineFor(throwsSynchronously, upgradeRequest('/hal/ws', 'Host: example.com\r\n'));

    expect(reply).toBe('HTTP/1.1 500 Internal Server Error');
  });

  it('upgrades a request whose authenticator returns a user without a promise', async () => {
    const returnsPlainUser = (() => ({id: 'u1'})) as unknown as WsAuthenticator;

    const reply = await statusLineFor(returnsPlainUser, upgradeRequest('/hal/ws', 'Host: example.com\r\n'));

    expect(reply).toBe('HTTP/1.1 101 Switching Protocols');
  });

  it('still upgrades a well-formed request', async () => {
    const reply = await statusLineFor(admitEveryone, upgradeRequest('/hal/ws', 'Host: example.com\r\n'));

    expect(reply).toBe('HTTP/1.1 101 Switching Protocols');
  });
});
