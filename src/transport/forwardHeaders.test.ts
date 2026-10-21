import {WebSocket} from 'ws';
import request from 'supertest';
import type {ToolContext} from '../orchestration/tools/registry.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import type {ForwardableHeader} from './authHeaders.js';
import {createApp} from './createApp.js';
import {HAL_WS_SUBPROTOCOL} from './ws/subprotocol.js';
import {setLogger} from '../shared/logger.js';
import {keepEveryLine} from '../shared/logCaptureTestSupport.js';
import {startEngineWith, stopEngines} from './wsTestSupport.js';
import {whoamiOrchestrator} from './whoamiTestSupport.js';

const CALLER = {
  authorization: 'Bearer token-9c2e',
  cookie: 'sid=cookie-7f3a',
  'x-forwarded-host': 'tenant-4b1d.example',
};

// One turn over a real socket presenting all three headers; resolves with the context whoami was handed, once both ends closed.
async function socketTurn(forwardHeaders: readonly ForwardableHeader[] | undefined): Promise<ToolContext | undefined> {
  const {orchestrator, contexts} = whoamiOrchestrator();
  const {url, hal} = await startEngineWith({sessionStore: new InMemorySessionStore(), orchestrator, forwardHeaders});
  const serverClosed = new Promise<void>(resolve => {
    hal.wss.once('connection', socket => socket.once('close', () => setImmediate(resolve)));
  });
  // Only the marker is offered, so the credential the upgrade reads is the Authorization header.
  const client = new WebSocket(url, [HAL_WS_SUBPROTOCOL], {headers: CALLER});
  await new Promise<void>(resolve => {
    client.on('message', raw => {
      const {type} = JSON.parse(String(raw)) as {type: string};
      if (type === 'connected') client.send(JSON.stringify({type: 'user_message', content: 'who am I?'}));
      if (type === 'stream_end') resolve();
    });
  });
  client.close();
  await serverClosed;
  return contexts[0];
}

// One turn through the REST chat routes with all three headers sent; resolves with the context whoami was handed.
async function restTurn(forwardHeaders: readonly ForwardableHeader[] | undefined): Promise<ToolContext | undefined> {
  const {orchestrator, contexts} = whoamiOrchestrator();
  const app = createApp({
    orchestrator,
    sessionStore: new InMemorySessionStore(),
    authMiddleware: (req, _res, next) => {
      Object.assign(req, {user: {id: 'u1'}});
      next();
    },
    forwardHeaders,
  });

  const created = await request(app).post('/hal/chats').set(CALLER);
  await request(app)
    .post(`/hal/chats/${(created.body as {id: string}).id}/messages`)
    .set(CALLER)
    .send({content: 'who am I?'});
  return contexts[0];
}

afterEach(stopEngines);
afterAll(() => setLogger());

describe('the caller headers a tool receives', () => {
  it('hands a tool authorization alone over a real socket when forwardHeaders lists only authorization, the cookie and host nowhere in its context', async () => {
    const context = await socketTurn(['authorization']);

    const recorded = JSON.stringify(context);
    expect({
      authHeaders: context?.authHeaders,
      cookie: recorded.includes('cookie-7f3a'),
      host: recorded.includes('tenant-4b1d'),
    }).toEqual({authHeaders: {authorization: 'Bearer token-9c2e'}, cookie: false, host: false});
  });

  it('hands a tool authHeaders undefined over a real socket when forwardHeaders is empty', async () => {
    const context = await socketTurn([]);

    expect({hasContext: context !== undefined, authHeaders: context?.authHeaders}).toEqual({
      hasContext: true,
      authHeaders: undefined,
    });
  });

  it('hands a tool authHeaders undefined over a real socket when forwardHeaders is unset', async () => {
    const context = await socketTurn(undefined);

    expect({hasContext: context !== undefined, authHeaders: context?.authHeaders}).toEqual({
      hasContext: true,
      authHeaders: undefined,
    });
  });

  it('applies the same filter on POST /chats/:id/messages: authorization alone when forwardHeaders lists only authorization', async () => {
    expect((await restTurn(['authorization']))?.authHeaders).toEqual({authorization: 'Bearer token-9c2e'});
  });

  it('hands a tool reached through POST /chats/:id/messages authHeaders undefined when forwardHeaders is unset', async () => {
    const context = await restTurn(undefined);

    expect({hasContext: context !== undefined, authHeaders: context?.authHeaders}).toEqual({
      hasContext: true,
      authHeaders: undefined,
    });
  });

  it('writes neither the authorization nor the cookie value to any log line at any level across a whole connection', async () => {
    const lines = keepEveryLine();

    const context = await socketTurn(['authorization', 'cookie']);

    const logged = JSON.stringify(lines);
    expect({
      held: context?.authHeaders?.authorization,
      lines: lines.length > 0,
      authorization: logged.includes('token-9c2e'),
      cookie: logged.includes('cookie-7f3a'),
    }).toEqual({held: 'Bearer token-9c2e', lines: true, authorization: false, cookie: false});
  });
});
