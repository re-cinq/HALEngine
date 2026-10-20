import express from 'express';
import request from 'supertest';
import {createChatRoutes} from './chats.js';
import {InMemorySessionStore} from '../../infrastructure/stores/inMemorySessionStore.js';
import type {AuthenticatedRequest} from '../../types/auth.js';
import {whoamiOrchestrator} from '../whoamiTestSupport.js';

describe('a tool reached through the REST chat routes', () => {
  it("receives context.user undefined and context.userId alice, the chat's user id, though the middleware attached more claims", async () => {
    const {orchestrator, contexts} = whoamiOrchestrator();
    const app = express();
    app.use(express.json());
    app.use(
      '/chats',
      createChatRoutes(orchestrator, new InMemorySessionStore(), (req, _res, next) => {
        (req as AuthenticatedRequest).user = {id: 'alice', workspaceId: 'w-9', role: 'editor'};
        next();
      })
    );

    const created = await request(app).post('/chats');
    await request(app)
      .post(`/chats/${(created.body as {id: string}).id}/messages`)
      .send({content: 'who am I?'});

    const [context] = contexts;
    expect({noUser: context?.user === undefined, userId: context?.userId}).toEqual({noUser: true, userId: 'alice'});
  });
});
