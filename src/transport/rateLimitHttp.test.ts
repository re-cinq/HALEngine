import {jest} from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import {createApp} from './createApp.js';
import {createRateLimiter, rateLimitMiddleware} from './rateLimit.js';
import type {RateLimiter} from './rateLimit.js';
import type {AuthenticatedRequest, HttpAuthMiddleware} from '../types/auth.js';

// specs/hal-engine-rate-limit

const FROZEN_CLOCK = () => 0;

const PINGS = (router: express.Router) => router.get('/ping', (_req, res) => res.json({ok: true}));

const appWith = (rateLimit: RateLimiter | undefined) =>
  createApp({rateLimit, additionalRoutes: PINGS, rootRoutes: router => router.get('/', (_req, res) => res.send('hi'))});

const userFromHeader: HttpAuthMiddleware = (req, _res, next) => {
  req.user = {id: String(req.header('x-user'))};
  next();
};

const chatApp = (rateLimit: RateLimiter) =>
  createApp({
    rateLimit,
    authMiddleware: userFromHeader,
    sessionStore: new InMemorySessionStore(),
    orchestrator: {
      processMessage: jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('reply'),
    } as unknown as ChatOrchestrator,
  });

const chatStatusesOf = async (app: express.Express, user: string, times: number): Promise<number[]> => {
  const statuses: number[] = [];
  for (let index = 0; index < times; index += 1) {
    statuses.push((await request(app).post('/hal/chats').set('x-user', user).send({})).status);
  }
  return statuses;
};

const statusesOf = async (app: express.Express, path: string, times: number): Promise<number[]> => {
  const statuses: number[] = [];
  for (let index = 0; index < times; index += 1) statuses.push((await request(app).get(path)).status);
  return statuses;
};

const recordingLimiter = () => {
  const keys: string[] = [];
  const limiter: RateLimiter = {
    consume: key => {
      keys.push(key);
      return {allowed: true, retryAfterMs: 0};
    },
  };
  return {keys, limiter};
};

describe('createApp with the default rate limit', () => {
  it('answers the sixth immediate request to an additional route 429 with Retry-After 3 and code TOO_MANY_REQUESTS, after five 200s', async () => {
    const app = appWith(createRateLimiter({}, FROZEN_CLOCK));

    const first = await statusesOf(app, '/hal/ping', 5);
    const refused = await request(app).get('/hal/ping');

    expect({first, status: refused.status, retryAfter: refused.headers['retry-after'], body: refused.body}).toEqual({
      first: [200, 200, 200, 200, 200],
      status: 429,
      retryAfter: '3',
      body: {error: 'Too many requests, please slow down', code: 'TOO_MANY_REQUESTS', retryAfterMs: 3000},
    });
  });

  it('covers a root route too: a caller refused on /hal/ping is refused on /', async () => {
    const app = appWith(createRateLimiter({}, FROZEN_CLOCK));
    await statusesOf(app, '/hal/ping', 5);

    expect((await request(app).get('/')).status).toEqual(429);
  });

  it('keys the chat routes on the authenticated user: two users behind one address each get five POST /hal/chats before a 429', async () => {
    const app = chatApp(createRateLimiter({}, FROZEN_CLOCK));

    expect({first: await chatStatusesOf(app, 'a', 6), second: await chatStatusesOf(app, 'b', 6)}).toEqual({
      first: [201, 201, 201, 201, 201, 429],
      second: [201, 201, 201, 201, 201, 429],
    });
  });

  it('never refuses /hal/health, which answers liveness probes, however often it is called', async () => {
    const app = appWith(createRateLimiter({burst: 1}, FROZEN_CLOCK));

    expect(await statusesOf(app, '/hal/health', 10)).toEqual(Array(10).fill(200));
  });
});

describe('createApp without a rate limiter', () => {
  it('mounts none: thirty immediate requests to /hal/ping all answer 200', async () => {
    expect(await statusesOf(appWith(undefined), '/hal/ping', 30)).toEqual(Array(30).fill(200));
  });
});

describe('rateLimitMiddleware keys', () => {
  it('keys on req.user.id when a middleware before it set a usable one, and on the remote address when none did or the id is empty', async () => {
    const {keys, limiter} = recordingLimiter();
    const app = express();
    app.use('/signed-in', (req: AuthenticatedRequest, _res, next) => {
      req.user = {id: 'u1'};
      next();
    });
    app.use('/empty-id', (req: AuthenticatedRequest, _res, next) => {
      req.user = {id: ''};
      next();
    });
    app.use(rateLimitMiddleware(limiter));
    app.get(['/signed-in', '/anonymous', '/empty-id'], (_req, res) => res.json({ok: true}));

    await request(app).get('/signed-in');
    await request(app).get('/anonymous');
    await request(app).get('/empty-id');

    expect(keys).toEqual(['user:u1', expect.stringMatching(/^address:.+/), expect.stringMatching(/^address:.+/)]);
  });
});
