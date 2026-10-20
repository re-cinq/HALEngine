import net from 'node:net';
import type {AddressInfo} from 'node:net';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import type {WsAuthenticator} from '../types/auth.js';
import {setLogger} from '../shared/logger.js';
import {eventsUntilClose, startEngineWith, stopEngines} from './wsTestSupport.js';

// Real sockets: what a client sees after the 101 is the point, and no fake socket shows a corrupted frame.

const SECRET_HEADERS = {authorization: 'Bearer auth-secret-9', cookie: 'sid=cookie-secret-4'};

const lines: Array<{level: string; category: string; message: string; fields?: Record<string, unknown>}> = [];
const logAt = (level: string) => (category: string, message: string, fields?: Record<string, unknown>) =>
  void lines.push({level, category, message, fields});

beforeAll(() => setLogger({debug: logAt('debug'), info: logAt('info'), warn: logAt('warn'), error: logAt('error')}));
beforeEach(() => {
  lines.length = 0;
});
afterEach(() => stopEngines());
afterAll(() => setLogger());

// An engine whose next connection hits a second `connection` listener that throws once the handshake is done.
async function engineWithThrowingListener(): Promise<string> {
  const {url, hal} = await startEngineWith({sessionStore: new InMemorySessionStore()});
  hal.wss.once('connection', () => {
    throw new Error('listener-boom');
  });
  return url;
}

// The first line the server writes back to a raw upgrade request, before any WebSocket framing.
async function firstLineFor(wsAuth: WsAuthenticator, connections: {count: number}): Promise<string> {
  const {hal} = await startEngineWith({sessionStore: new InMemorySessionStore(), wsAuth});
  hal.wss.on('connection', () => void (connections.count += 1));
  const {port} = hal.server.address() as AddressInfo;
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () =>
      socket.write(
        'GET /hal/ws HTTP/1.1\r\nHost: example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
      )
    );
    socket.once('data', chunk => {
      socket.destroy();
      resolve(String(chunk).split('\r\n')[0]);
    });
  });
}

describe('a connection that fails after the WebSocket handshake', () => {
  it('closes with 1011 and no client error when a second connection listener throws, and the next client still connects', async () => {
    const url = await engineWithThrowingListener();

    const failed = await eventsUntilClose(url, SECRET_HEADERS);
    const next = await eventsUntilClose(url, SECRET_HEADERS, client => client.close(1000));

    expect({failed: failed.filter(event => event !== 'frame:connected'), next}).toEqual({
      failed: ['open', 'close:1011'],
      next: ['open', 'frame:connected', 'close:1000'],
    });
  });

  it('logs the failure at error under ws and keeps the authorization and cookie values out of every log line', async () => {
    await eventsUntilClose(await engineWithThrowingListener(), SECRET_HEADERS);

    expect({
      failure: lines.filter(line => line.message === 'connection failed after the handshake'),
      leaked: /auth-secret-9|cookie-secret-4/.test(JSON.stringify(lines)),
    }).toEqual({
      failure: [
        {
          level: 'error',
          category: 'ws',
          message: 'connection failed after the handshake',
          fields: {error: 'listener-boom'},
        },
      ],
      leaked: false,
    });
  });
});

describe('a connection refused before the WebSocket handshake', () => {
  it('answers a rejecting wsAuth with 500 and a null one with 401, with no 101 and no connection event', async () => {
    const connections = {count: 0};

    const replies = [
      await firstLineFor(() => Promise.reject(new Error('auth down')), connections),
      await firstLineFor(async () => null, connections),
    ];

    expect({replies, connections: connections.count}).toEqual({
      replies: ['HTTP/1.1 500 Internal Server Error', 'HTTP/1.1 401 Unauthorized'],
      connections: 0,
    });
  });
});
