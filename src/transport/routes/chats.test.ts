import {jest} from '@jest/globals';
import express from 'express';
import type {Request} from 'express';
import request from 'supertest';
import {createChatRoutes} from './chats.js';
import type {ChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import type {SessionStore} from '../../types/sessionStore.js';

// Pins the ownership guard, including that a rejected request stops before the route's work.

interface TestUser {
  id: string | number;
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
      if (user) (req as Request & {user?: TestUser}).user = user;
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

    it('does not apply the guard when the request carries no user', async () => {
      const {as, chatOwnedBy} = harness();
      const id = await chatOwnedBy(ALICE);

      const response = await as(undefined).get(`/chats/${id}`);

      expect(response.status).toBe(200);
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

    it('answers 404 for a chat that does not exist', async () => {
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
