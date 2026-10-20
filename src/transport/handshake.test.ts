import {jest} from '@jest/globals';
import {once} from 'node:events';
import net from 'node:net';
import type {IncomingMessage} from 'node:http';
import type {AddressInfo} from 'node:net';
import {WebSocket} from 'ws';
import type {Express} from 'express';
import {createServer} from './createServer.js';
import {HAL_WS_SUBPROTOCOL, credentialFromSubprotocol} from './ws/subprotocol.js';
import type {WsAuthenticator} from '../types/auth.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import {setLogger} from '../shared/logger.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';

// Real upgrades over a real socket: what the 101 carries is the contract, and no double can observe it.

const TOKEN = 'super-secret-token';

interface Handshake {
  answered: string | undefined;
  leakedHeaders: string[];
  socketProtocol: string;
  authorization: string | undefined;
}

const signal = () => {
  let release = (): void => undefined;
  const fired = new Promise<void>(resolve => {
    release = resolve;
  });
  return {fired, release: () => release()};
};

const admitEveryone: WsAuthenticator = async () => ({id: 'u1'});

const engine = async (wsAuth: WsAuthenticator = admitEveryone) => {
  // Read at connect: the close handler clears authHeaders, so a post-close read would see nothing.
  const bearers: Array<string | undefined> = [];
  const serverSockets: WebSocket[] = [];
  const disconnected = signal();
  const hal = createServer({
    app: (() => undefined) as unknown as Express,
    wsAuth,
    sessionStore: new InMemorySessionStore(),
    orchestrator: {} as ChatOrchestrator,
    onConnect: session => void bearers.push(session.authHeaders?.authorization),
    onDisconnect: disconnected.release,
  });
  hal.wss.on('connection', socket => void serverSockets.push(socket));
  await hal.start(0);
  const {port} = hal.server.address() as AddressInfo;
  return {hal, bearers, serverSockets, disconnected, url: `ws://127.0.0.1:${port}/hal/ws/c1`};
};

// Connect, ping, close: the whole lifecycle a credential could be logged in.
const roundTrip = async (url: string, offer: string[], headers: Record<string, string>) => {
  const client = new WebSocket(url, offer, {headers});
  // Both listened for before either is awaited: the connected frame can land in the same tick as the 101.
  const upgraded = once(client, 'upgrade');
  const connected = once(client, 'message');
  const [response] = (await upgraded) as [IncomingMessage];
  await connected;
  client.send(JSON.stringify({type: 'ping', timestamp: 1}));
  await once(client, 'message');
  client.close();
  return response;
};

const handshake = async (offer: string[], headers: Record<string, string> = {}): Promise<Handshake> => {
  const {hal, bearers, serverSockets, disconnected, url} = await engine();
  const response = await roundTrip(url, offer, headers);
  await disconnected.fired;
  await hal.stop();

  const [bearer] = bearers;
  const [serverSocket] = serverSockets;
  const {rawHeaders} = response;
  return {
    answered: response.headers['sec-websocket-protocol'],
    leakedHeaders: rawHeaders.filter(value => value.includes(TOKEN)),
    socketProtocol: serverSocket.protocol,
    authorization: bearer,
  };
};

// A raw upgrade, read to the socket's close, so the whole response is seen and not just what a ws client reports.
const rawUpgrade = async (port: number, headers: string): Promise<{response: string; closed: boolean}> =>
  new Promise(resolve => {
    let response = '';
    const socket = net.connect(port, '127.0.0.1', () =>
      socket.write(
        'GET /hal/ws/c1 HTTP/1.1\r\nHost: example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
          `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${headers}\r\n`
      )
    );
    socket.on('data', chunk => void (response += String(chunk)));
    socket.on('close', () => resolve({response, closed: true}));
  });

// Raced against open, so a server that still accepts an offer fails the test instead of hanging it.
const clientOutcome = (client: WebSocket): Promise<string> =>
  Promise.race([
    once(client, 'error').then(([error]) => (error as Error).message),
    once(client, 'open').then(() => 'opened'),
  ]);

// The authenticator the docs recommend: it reads the credential the way the engine does.
const readsSubprotocol: WsAuthenticator = async request =>
  credentialFromSubprotocol(request.headers['sec-websocket-protocol']) ? {id: 'u1'} : null;

// An offer without the marker is answered with no subprotocol, which the ws client fails after the 101.
const refusedHandshake = async (offer: string[]) => {
  const {hal, disconnected, url} = await engine();
  const client = new WebSocket(url, offer);
  const upgraded = once(client, 'upgrade');
  const outcome = clientOutcome(client);
  const [response] = (await upgraded) as [IncomingMessage];
  const clientError = await outcome;
  client.close();
  await disconnected.fired;
  await hal.stop();
  return {
    answered: response.headers['sec-websocket-protocol'],
    leakedHeaders: response.rawHeaders.filter(value => value.includes(TOKEN)),
    clientError,
  };
};

describe('the WebSocket handshake', () => {
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    const collect = (category: string, message: string, fields?: Record<string, unknown>) =>
      void lines.push(JSON.stringify({category, message, fields}));
    setLogger({debug: collect, info: collect, warn: collect, error: collect});
  });

  afterEach(() => {
    setLogger();
  });

  it('answers a hal.v1 and token offer with hal.v1 alone, and forwards the token as a bearer', async () => {
    expect(await handshake([HAL_WS_SUBPROTOCOL, TOKEN])).toEqual({
      answered: HAL_WS_SUBPROTOCOL,
      leakedHeaders: [],
      socketProtocol: HAL_WS_SUBPROTOCOL,
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it('connects a client offering only the marker, reading its credential from the Authorization header', async () => {
    expect(await handshake([HAL_WS_SUBPROTOCOL], {Authorization: 'Bearer from-header'})).toEqual({
      answered: HAL_WS_SUBPROTOCOL,
      leakedHeaders: [],
      socketProtocol: HAL_WS_SUBPROTOCOL,
      authorization: 'Bearer from-header',
    });
  });

  it('answers a bare-token offer with no subprotocol, so the client fails it and no response header holds the token', async () => {
    expect(await refusedHandshake([TOKEN])).toEqual({
      answered: undefined,
      leakedHeaders: [],
      clientError: 'Server sent no subprotocol',
    });
  });

  it('refuses a bare-token offer with 401 when the authenticator reads its credential with credentialFromSubprotocol', async () => {
    const {hal, url} = await engine(readsSubprotocol);
    const client = new WebSocket(url, [TOKEN]);

    const clientError = await clientOutcome(client);
    client.close();
    await hal.stop();

    expect(clientError).toBe('Unexpected server response: 401');
  });

  it('refuses Bearer attacker-token beside a victim-token subprotocol with 400 before wsAuth runs, and neither value reaches the response or a log line', async () => {
    const wsAuth = jest.fn(admitEveryone);
    const {hal} = await engine(wsAuth);
    const {port} = hal.server.address() as AddressInfo;

    const {response, closed} = await rawUpgrade(
      port,
      'Authorization: Bearer attacker-token\r\nSec-WebSocket-Protocol: hal.v1, victim-token\r\n'
    );
    await hal.stop();

    const {calls} = wsAuth.mock;
    expect({
      statusLine: response.split('\r\n')[0],
      closed,
      authenticatorCalls: calls.length,
      leaked: /attacker-token|victim-token/.test(response + lines.join('\n')),
      warned: lines.filter(line => line.includes('different credentials')).length,
    }).toEqual({statusLine: 'HTTP/1.1 400 Bad Request', closed: true, authenticatorCalls: 0, leaked: false, warned: 1});
  });

  it('still hands an upgrade with no credential to wsAuth, since a consumer may authenticate by cookie', async () => {
    const wsAuth = jest.fn(admitEveryone);
    const {hal, bearers, disconnected, url} = await engine(wsAuth);

    await roundTrip(url, [HAL_WS_SUBPROTOCOL], {Cookie: 'sid=cookie-session'});
    await disconnected.fired;
    await hal.stop();

    const {calls} = wsAuth.mock;
    expect({authenticatorCalls: calls.length, authorization: bearers[0]}).toEqual({
      authenticatorCalls: 1,
      authorization: undefined,
    });
  });

  it('connects a client presenting the same token in the header and the subprotocol, and forwards it once as a bearer', async () => {
    expect(await handshake([HAL_WS_SUBPROTOCOL, TOKEN], {Authorization: `Bearer ${TOKEN}`})).toEqual({
      answered: HAL_WS_SUBPROTOCOL,
      leakedHeaders: [],
      socketProtocol: HAL_WS_SUBPROTOCOL,
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it('writes no offered value to any log line from connect to close, in either shape', async () => {
    await handshake([HAL_WS_SUBPROTOCOL, TOKEN]);
    await refusedHandshake([TOKEN]);

    expect(lines.filter(line => line.includes(TOKEN))).toEqual([]);
  });
});
