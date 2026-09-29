import {once} from 'node:events';
import type {IncomingMessage} from 'node:http';
import type {AddressInfo} from 'node:net';
import {WebSocket} from 'ws';
import type {Express} from 'express';
import {createServer} from './createServer.js';
import {HAL_WS_SUBPROTOCOL} from './ws/subprotocol.js';
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

const engine = async () => {
  // Read at connect: the close handler clears authHeaders, so a post-close read would see nothing.
  const bearers: Array<string | undefined> = [];
  const serverSockets: WebSocket[] = [];
  const disconnected = signal();
  const hal = createServer({
    app: (() => undefined) as unknown as Express,
    wsAuth: async () => ({id: 'u1'}),
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

  it('still connects a bare-token client for one minor, echoing its offer as before', async () => {
    const result = await handshake([TOKEN]);

    expect({answered: result.answered, authorization: result.authorization}).toEqual({
      answered: TOKEN,
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it('writes no offered value to any log line from connect to close, in either shape', async () => {
    await handshake([HAL_WS_SUBPROTOCOL, TOKEN]);
    await handshake([TOKEN]);

    const warned = lines.filter(line => line.includes(`subprotocol offered without ${HAL_WS_SUBPROTOCOL}`));
    expect({warned: warned.length, leaked: lines.filter(line => line.includes(TOKEN))}).toEqual({
      warned: 1,
      leaked: [],
    });
  });
});
