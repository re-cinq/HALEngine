import {jest} from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {createChatRoutes} from './chats.js';
import type {AuthenticatedRequest} from '../../types/auth.js';
import type {AuthenticatedUser} from '../../types/session.js';
import {setLogger} from '../../shared/logger.js';
import type {ChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import type {SessionStore} from '../../types/sessionStore.js';

// Pins the ownership guard, including that a rejected request stops before the route's work.

interface TestUser extends AuthenticatedUser {
  workspaceId?: string | number;
}

const ALICE: TestUser = {id: 'alice'};
const BOB: TestUser = {id: 'bob'};

const harness = () => {
  let user: TestUser | undefined;
  const processMessage = jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('assistant reply');
  const orchestrator = {processMessage} as unknown as ChatOrchestrator;

  const app = express();
  app.use(express.json());
  app.use(
    '/chats',
    createChatRoutes(orchestrator, {} as SessionStore, (req, _res, next) => {
      if (user) (req as AuthenticatedRequest).user = user;
      next();
    })
  );

  // One router means one chat store, reached by different callers - the thing the guard separates.
  const as = (next: TestUser | undefined) => {
    user = next;
    return request(app);
  };

  const chatOwnedBy = async (owner: TestUser | undefined): Promise<string> => {
    const created = await as(owner).post('/chats');
    return (created.body as {id: string}).id;
  };

  return {as, chatOwnedBy, processMessage};
};

describe('chat routes ownership guard', () => {
  describe('GET /chats/:id', () => {
    it('serves the chat to the user who created it', async () => {
      const {as, chatOwnedBy} = harness();
      const id = await chatOwnedBy(ALICE);

      const response = await as(ALICE).get(`/chats/${id}`);

      expect({status: response.status, id: (response.body as {id: string}).id}).toEqual({status: 200, id});
    });

    it('refuses a different user with 403 and no chat content', async () => {
      const {as, chatOwnedBy} = harness();
      const id = await chatOwnedBy(ALICE);

      const response = await as(BOB).get(`/chats/${id}`);

      expect({status: response.status, body: response.body}).toEqual({status: 403, body: {error: 'Forbidden'}});
    });

    it('answers 404 for a chat that does not exist', async () => {
      const {as} = harness();

      const response = await as(ALICE).get('/chats/no-such-chat');

      expect({status: response.status, body: response.body}).toEqual({status: 404, body: {error: 'Chat not found'}});
    });

    it('answers 404 before 403, so a wrong owner cannot probe which ids exist', async () => {
      const {as, chatOwnedBy} = harness();
      await chatOwnedBy(ALICE);

      const response = await as(BOB).get('/chats/no-such-chat');

      expect({status: response.status, body: response.body}).toEqual({status: 404, body: {error: 'Chat not found'}});
    });

    it('refuses a request whose middleware attached no user, without revealing the chat', async () => {
      const {as, chatOwnedBy} = harness();
      const id = await chatOwnedBy(ALICE);

      const response = await as(undefined).get(`/chats/${id}`);

      expect({status: response.status, body: response.body}).toEqual({status: 401, body: {error: 'Unauthorized'}});
    });

    it('compares owner ids strictly, so numeric 1 and string "1" are different users', async () => {
      const {as, chatOwnedBy} = harness();
      const id = await chatOwnedBy({id: 1});

      const response = await as({id: '1'}).get(`/chats/${id}`);

      expect(response.status).toBe(403);
    });
  });

  describe('POST /chats/:id/messages', () => {
    it('accepts a message from the user who created the chat', async () => {
      const {as, chatOwnedBy} = harness();
      const id = await chatOwnedBy(ALICE);

      const response = await as(ALICE).post(`/chats/${id}/messages`).send({content: 'hello'});

      expect(response.status).toBe(201);
    });

    it('refuses a different user and never reaches the orchestrator', async () => {
      const {as, chatOwnedBy, processMessage} = harness();
      const id = await chatOwnedBy(ALICE);

      const response = await as(BOB).post(`/chats/${id}/messages`).send({content: 'hello'});
      const {calls} = processMessage.mock;

      expect({status: response.status, body: response.body, orchestratorCalls: calls.length}).toEqual({
        status: 403,
        body: {error: 'Forbidden'},
        orchestratorCalls: 0,
      });
    });

    it('answers 404 when the chat a message names does not exist', async () => {
      const {as} = harness();

      const response = await as(ALICE).post('/chats/no-such-chat/messages').send({content: 'hello'});

      expect({status: response.status, body: response.body}).toEqual({status: 404, body: {error: 'Chat not found'}});
    });

    it('refuses a different user before validating the body, so 403 beats 400', async () => {
      const {as, chatOwnedBy} = harness();
      const id = await chatOwnedBy(ALICE);

      const response = await as(BOB).post(`/chats/${id}/messages`).send({});

      expect(response.status).toBe(403);
    });

    // Express leaves req.body undefined when no parser claimed the type, and destructuring it threw.
    it('answers 400 when no body parser claimed the request, rather than 500', async () => {
      const {as, chatOwnedBy} = harness();
      const id = await chatOwnedBy(ALICE);

      const response = await as(ALICE).post(`/chats/${id}/messages`).type('text/plain').send('content=hi');

      expect(response.status).toBe(400);
    });

    it('does not record the rejected message in the chat', async () => {
      const {as, chatOwnedBy} = harness();
      const id = await chatOwnedBy(ALICE);
      await as(BOB).post(`/chats/${id}/messages`).send({content: 'intruder'});

      const response = await as(ALICE).get(`/chats/${id}`);

      expect((response.body as {messages: unknown[]}).messages).toEqual([]);
    });
  });
});

// Pins the deny-by-default: with no middleware configured there is nobody to identify, so nothing is served.
describe('chat routes with no auth middleware', () => {
  const unguarded = () => {
    const processMessage = jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('assistant reply');
    const app = express();
    app.use(express.json());
    app.use('/chats', createChatRoutes({processMessage} as unknown as ChatOrchestrator, {} as SessionStore));
    return {app, processMessage};
  };

  it('refuses to create a chat', async () => {
    const {app} = unguarded();

    const response = await request(app).post('/chats');

    expect({status: response.status, body: response.body}).toEqual({status: 401, body: {error: 'Unauthorized'}});
  });

  it('refuses to read a chat', async () => {
    const {app} = unguarded();

    const response = await request(app).get('/chats/any-id');

    expect({status: response.status, body: response.body}).toEqual({status: 401, body: {error: 'Unauthorized'}});
  });

  it('refuses to post a message, and never reaches the orchestrator', async () => {
    const {app, processMessage} = unguarded();

    const response = await request(app).post('/chats/any-id/messages').send({content: 'hello'});
    const {calls} = processMessage.mock;

    expect({status: response.status, orchestratorCalls: calls.length}).toEqual({
      status: 401,
      orchestratorCalls: 0,
    });
  });

  it('answers 401 before 404, so an unauthenticated caller cannot probe which chat ids exist', async () => {
    const {app} = unguarded();

    const response = await request(app).get('/chats/definitely-not-a-chat');

    expect(response.status).toBe(401);
  });
});

// Pins which `user.id` values count as authenticated. Middleware is consumer-supplied, so this is a trust boundary.
describe('chat routes user identity', () => {
  // The casts are the point: a consumer's middleware is not type-checked against AuthenticatedUser.
  const malformed = (id: unknown) => ({id}) as unknown as TestUser;

  it('accepts the numeric id 0, which is falsy but legal', async () => {
    const {as, chatOwnedBy} = harness();
    const id = await chatOwnedBy({id: 0});

    const response = await as({id: 0}).get(`/chats/${id}`);

    expect(response.status).toBe(200);
  });

  it('refuses an empty-string id', async () => {
    const {as} = harness();

    const response = await as({id: ''}).post('/chats');

    expect({status: response.status, body: response.body}).toEqual({status: 401, body: {error: 'Unauthorized'}});
  });

  it('refuses a user carrying no id', async () => {
    const {as} = harness();

    const response = await as(malformed(undefined)).post('/chats');

    expect(response.status).toBe(401);
  });

  it('refuses a null id', async () => {
    const {as} = harness();

    const response = await as(malformed(null)).post('/chats');

    expect(response.status).toBe(401);
  });

  it('never records a chat for a caller it refused', async () => {
    const {as} = harness();
    await as({id: ''}).post('/chats');

    const response = await as({id: 'alice'}).get('/chats/any-id');

    expect(response.status).toBe(404);
  });
});

// A refusal that leaves no trace is not an access control, and a trace carrying the request is a new leak.
describe('what a refused chat request records', () => {
  const lines: {level: string; category: string; message: string; fields?: Record<string, unknown>}[] = [];

  beforeEach(() => {
    lines.length = 0;
    const capture = (level: string) => (category: string, message: string, fields?: Record<string, unknown>) =>
      void lines.push({level, category, message, fields});
    setLogger({
      debug: capture('DEBUG'),
      info: capture('INFO'),
      warn: capture('WARN'),
      error: capture('ERROR'),
    });
  });

  afterEach(() => {
    setLogger();
  });

  const unguarded = () => {
    const app = express();
    app.use(express.json());
    app.use('/chats', createChatRoutes({} as unknown as ChatOrchestrator, {} as SessionStore));
    return app;
  };

  it('emits exactly one warn on category http when no middleware is configured', async () => {
    await request(unguarded()).post('/chats');

    expect(lines).toEqual([
      {
        level: 'WARN',
        category: 'http',
        message: 'chat request refused',
        fields: {reason: 'no auth middleware is configured'},
      },
    ]);
  });

  it('emits exactly one warn when the middleware attaches no usable user', async () => {
    const {as} = harness();

    await as({id: ''}).post('/chats');

    expect(lines.filter(line => line.level === 'WARN')).toHaveLength(1);
  });

  it('records nothing derived from the request, so a refusal cannot leak what was asked for', async () => {
    const {as} = harness();

    await as(undefined).get('/chats/a-secret-looking-chat-id?token=shhh');

    expect(JSON.stringify(lines)).not.toContain('a-secret-looking-chat-id');
  });

  it('says nothing at all when the request is authorised', async () => {
    const {as} = harness();

    await as(ALICE).post('/chats');

    expect(lines.filter(line => line.level === 'WARN')).toEqual([]);
  });
});
