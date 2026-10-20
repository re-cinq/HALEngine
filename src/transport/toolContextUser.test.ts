import type {WebSocket} from 'ws';
import type {ToolContext} from '../orchestration/tools/registry.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import type {AuthenticatedUser, ChatSession} from '../types/session.js';
import type {HalServerOptions} from './createServer.js';
import {credentialFromSubprotocol} from './ws/subprotocol.js';
import {setLogger} from '../shared/logger.js';
import {connectClient, startEngineWith, stopEngines} from './wsTestSupport.js';
import {whoamiOrchestrator} from './whoamiTestSupport.js';

const CLAIMS: AuthenticatedUser = {id: 'u1', workspaceId: 'w1', role: 'editor', accountId: 'acct-1'};
const SECRET = 'sk-live-0123456789abcdef';

interface Engine {
  url: string;
  store: InMemorySessionStore;
  contexts: ToolContext[];
  /** One promise per server-side socket, in connection order, settled once that socket's close has been handled. */
  closes: Array<Promise<void>>;
}

// An engine whose auth.ws answers `claimsFor` the subprotocol token, and whose whoami tool keeps every context it is handed.
async function engineFor(
  claimsFor: (token: string | undefined) => AuthenticatedUser,
  options: Partial<HalServerOptions> = {}
): Promise<Engine> {
  const {orchestrator, contexts} = whoamiOrchestrator();
  const store = new InMemorySessionStore();
  const {url, hal} = await startEngineWith({
    sessionStore: store,
    wsAuth: async request => claimsFor(credentialFromSubprotocol(request.headers['sec-websocket-protocol'])),
    orchestrator,
    ...options,
  });
  const closes: Array<Promise<void>> = [];
  hal.wss.on('connection', socket => {
    closes.push(new Promise(resolve => socket.once('close', () => setImmediate(resolve))));
  });
  return {url, store, contexts, closes};
}

// Opens a socket as `token`, asks one question once connected, and resolves with every raw frame once the turn ends.
function turnAs(url: string, token: string): Promise<string[]> {
  const client = connectClient(url, token);
  const frames: string[] = [];
  return new Promise(resolve => {
    client.on('message', raw => {
      frames.push(String(raw));
      const {type} = JSON.parse(String(raw)) as {type: string};
      if (type === 'connected') client.send(JSON.stringify({type: 'user_message', content: 'who am I?'}));
      if (type === 'stream_end') {
        client.close();
        resolve(frames);
      }
    });
  });
}

// The session id a client's connected frame announces.
function connectedAs(client: WebSocket): Promise<string> {
  return new Promise(resolve => {
    client.once('message', raw => resolve((JSON.parse(String(raw)) as {sessionId: string}).sessionId));
  });
}

afterEach(stopEngines);
afterAll(() => setLogger());

describe('the authenticated user on the tool context', () => {
  it('hands whoami context.user deep-equal to what auth.ws returned, beside userId u1 and workspaceId w1, over a real connection', async () => {
    const engine = await engineFor(() => CLAIMS);

    await turnAs(engine.url, 't');
    await Promise.all(engine.closes);

    const [context] = engine.contexts;
    expect({user: context?.user, userId: context?.userId, workspaceId: context?.workspaceId}).toEqual({
      user: CLAIMS,
      userId: 'u1',
      workspaceId: 'w1',
    });
  });

  it('sets session.user.id to u1, the same id as session.userId, on a session the connection handler created', async () => {
    const seen: Array<{userId: ChatSession['userId']; userIdOfUser: unknown}> = [];
    const engine = await engineFor(() => CLAIMS, {
      onConnect: session => void seen.push({userId: session.userId, userIdOfUser: session.user?.id}),
    });

    await turnAs(engine.url, 't');
    await Promise.all(engine.closes);

    expect(seen).toEqual([{userId: 'u1', userIdOfUser: 'u1'}]);
  });

  it('writes the secret-shaped claim to no log line at any level and to no frame, though the tool received it', async () => {
    const lines: unknown[] = [];
    const keep = (category: string, message: string, fields?: Record<string, unknown>) =>
      void lines.push({category, message, ...fields});
    setLogger({debug: keep, info: keep, warn: keep, error: keep});
    const engine = await engineFor(() => ({...CLAIMS, apiToken: SECRET}));

    const frames = await turnAs(engine.url, 't');
    await Promise.all(engine.closes);

    const [context] = engine.contexts;
    expect({
      lines: lines.length > 0,
      logged: JSON.stringify(lines).includes(SECRET),
      sent: frames.join('\n').includes(SECRET),
      received: context?.user?.apiToken,
    }).toEqual({lines: true, logged: false, sent: false, received: SECRET});
  });

  it('takes session.user from the upgrade that resumed the session, role second, and gives back role first when that socket closes', async () => {
    const engine = await engineFor(token => ({id: 'u1', role: token}), {resume: {enabled: true}});
    const first = connectClient(engine.url, 'first');
    const sessionId = await connectedAs(first);
    const second = connectClient(`${engine.url}?sessionId=${sessionId}`, 'second');
    await connectedAs(second);
    const held = await engine.store.get(sessionId);
    const whileBothOpen = held?.user?.role;

    second.close();
    await engine.closes[1];
    const afterSecondCloses = held?.user?.role;
    first.close();
    await Promise.all(engine.closes);

    expect({whileBothOpen, afterSecondCloses, afterBothClose: held?.user}).toEqual({
      whileBothOpen: 'second',
      afterSecondCloses: 'first',
      afterBothClose: undefined,
    });
  });
});
