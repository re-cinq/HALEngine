import {once} from 'node:events';
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

  it('writes no offered value to any log line from connect to close, in either shape', async () => {
    await handshake([HAL_WS_SUBPROTOCOL, TOKEN]);
    await refusedHandshake([TOKEN]);

    expect(lines.filter(line => line.includes(TOKEN))).toEqual([]);
  });
});
