import {jest} from '@jest/globals';
import request from 'supertest';
import type {RequestHandler} from 'express';
import {createApp} from './createApp.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import type {AuthenticatedRequest, HttpAuthMiddleware} from '../types/auth.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';

// Pins the wiring: which routes mount, what an unauthenticated caller reaches, and what the store is for.

const orchestrator = () =>
  ({
    processMessage: jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('reply'),
  }) as unknown as ChatOrchestrator;

const app = (options: Parameters<typeof createApp>[0] = {}) =>
  createApp({orchestrator: orchestrator(), sessionStore: new InMemorySessionStore(), ...options});

describe('createApp with no auth middleware', () => {
  it('refuses to create a chat', async () => {
    const response = await request(app()).post('/hal/chats');

    expect(response.status).toBe(401);
  });

  // The deny-by-default must not take the rest of the app with it.
  it('still answers health, so a denied chat route is not a broken app', async () => {
    const response = await request(app()).get('/hal/health');

    expect(response.status).toBe(200);
  });

  it('still answers 404 off the base path', async () => {
    const response = await request(app()).get('/anything-else');

    expect(response.status).toBe(404);
  });
});

describe('createApp auth middleware', () => {
  it('invokes the middleware it was given', async () => {
    const middleware = jest.fn<HttpAuthMiddleware>((req, _res, next) => {
      (req as AuthenticatedRequest).user = {id: 'alice'};
      next();
    });

    await request(app({authMiddleware: middleware})).post('/hal/chats');

    expect(middleware).toHaveBeenCalledTimes(1);
  });

  it('serves the route once that middleware attaches a user', async () => {
    const attach: HttpAuthMiddleware = (req, _res, next) => {
      (req as AuthenticatedRequest).user = {id: 'alice'};
      next();
    };

    const response = await request(app({authMiddleware: attach})).post('/hal/chats');

    expect(response.status).toBe(201);
  });

  // A consumer's existing Express middleware has to keep type-checking against the option.
  it('accepts a plain express RequestHandler, which is what a consumer already has', () => {
    const existing: RequestHandler = (_req, _res, next) => next();
    const assigned: HttpAuthMiddleware = existing;

    expect(typeof assigned).toBe('function');
  });

  it('is itself usable as an express RequestHandler, which is how the router mounts it', () => {
    const ours: HttpAuthMiddleware = (_req, _res, next) => next();
    const mounted: RequestHandler = ours;

    expect(typeof mounted).toBe('function');
  });
});

describe('createApp chat route mounting', () => {});

describe('createApp chat route mounting', () => {
  it('mounts no chat routes without a session store', async () => {
    const response = await request(createApp({orchestrator: orchestrator()})).post('/hal/chats');

    expect(response.status).toBe(404);
  });

  // sessionStore gates whether the routes mount; the routes themselves keep their own Map.
  it('leaves the session store empty after a chat is created through it', async () => {
    const store = new InMemorySessionStore();
    const attach: HttpAuthMiddleware = (req, _res, next) => {
      (req as AuthenticatedRequest).user = {id: 'alice'};
      next();
    };
    await request(createApp({orchestrator: orchestrator(), sessionStore: store, authMiddleware: attach})).post(
      '/hal/chats'
    );

    expect(store.count()).toBe(0);
  });

  it('does not share chats between two apps built on one session store', async () => {
    const store = new InMemorySessionStore();
    const attach: HttpAuthMiddleware = (req, _res, next) => {
      (req as AuthenticatedRequest).user = {id: 'alice'};
      next();
    };
    const options = {orchestrator: orchestrator(), sessionStore: store, authMiddleware: attach};
    const created = await request(createApp(options)).post('/hal/chats');
    const id = (created.body as {id: string}).id;

    const response = await request(createApp(options)).get(`/hal/chats/${id}`);

    expect(response.status).toBe(404);
  });
});
