import net from 'node:net';
import request from 'supertest';
import type {Request, Response} from 'express';
import {createHalEngine} from './config.js';
import {log, setLogger} from './shared/logger.js';
import type {Logger} from './shared/logger.js';
import type {ChatSession} from './types/session.js';
import type {HttpAuthMiddleware, WsAuthenticator} from './types/auth.js';
import {recordingSessionStore} from './infrastructure/writeSignalTestSupport.js';

// Both options below are declared on HalEngineConfig and were dropped at the forwarding site.

const base = {
  provider: {type: 'mock' as const},
  prompt: {identity: 'test'},
  auth: {ws: (async () => null) as unknown as WsAuthenticator},
};

describe('createHalEngine forwarding', () => {
  it('forwards an orchestrator hook, so one passed through the config actually fires', async () => {
    const seen: string[] = [];
    const engine = createHalEngine({
      ...base,
      orchestrator: {hooks: {beforeSession: async () => void seen.push('beforeSession')}},
    });
    const session: ChatSession = {
      sessionId: 's1',
      userId: 'u1',
      entries: [{role: 'user', content: 'hi', timestamp: ''}],
    };

    await engine.orchestrator.processMessage(session);

    expect(seen).toEqual(['beforeSession']);
  });

  it('forwards transport.port, so the server listens where the config said', async () => {
    const engine = createHalEngine({...base, transport: {port: 0}});

    await engine.start();
    const address = engine.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : -1;
    await engine.stop();

    expect({usedTheConfig: port !== 8086, real: port > 0}).toEqual({usedTheConfig: true, real: true});
  });

  it('lets an explicit start(port) win over the configured one', async () => {
    const engine = createHalEngine({...base, transport: {port: 8099}});

    await engine.start(0);
    const address = engine.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : -1;
    await engine.stop();

    expect({usedTheArgument: port !== 8099, real: port > 0}).toEqual({usedTheArgument: true, real: true});
  });
});

// The option was declared on HalEngineConfig and read by nothing, so a supplied logger received no lines.
describe('createHalEngine logger forwarding', () => {
  afterEach(() => {
    setLogger();
  });

  it("delivers the package's own log lines to a supplied logger", async () => {
    const lines: {category: string; message: string}[] = [];
    const collect = (category: string, message: string) => void lines.push({category, message});
    const logger: Logger = {debug: collect, info: collect, warn: collect, error: collect};

    const engine = createHalEngine({...base, logger, transport: {port: 0}});
    await engine.start();
    await engine.stop();

    expect(lines).toContainEqual({category: 'server', message: 'HAL Engine started'});
  });

  // Asserts on a line logged AFTER construction: nothing logs during it, so an emptiness check cannot fail.
  it('leaves an already-supplied logger in place when the config names none', async () => {
    const lines: string[] = [];
    setLogger({
      debug: (_c: string, m: string) => void lines.push(m),
      info: (_c: string, m: string) => void lines.push(m),
      warn: (_c: string, m: string) => void lines.push(m),
      error: (_c: string, m: string) => void lines.push(m),
    });

    createHalEngine({...base});
    log.info('test', 'after construction');

    expect(lines).toEqual(['after construction']);
  });
});

describe('createHalEngine orchestrator hooks reach the orchestrator', () => {
  it('processes a message when the config declares no orchestrator key at all', async () => {
    const engine = createHalEngine({...base});
    const session: ChatSession = {
      sessionId: 's-noorch',
      userId: 'u1',
      entries: [{role: 'user', content: 'ping', timestamp: ''}],
    };

    const reply = await engine.orchestrator.processMessage(session);

    expect(reply).toContain('ping');
  });

  const replyThrough = async (engine: ReturnType<typeof createHalEngine>, sessionId: string): Promise<string> =>
    engine.orchestrator.processMessage({
      sessionId,
      userId: 'u1',
      entries: [{role: 'user', content: 'unwrapped', timestamp: ''}],
    });

  it('processes a message unchanged when the config declares no resilience block', async () => {
    const reply = await replyThrough(createHalEngine({...base}), 's-no-resilience');

    expect(reply).toEqual('Mock response to: "unwrapped" ');
  });

  it('processes a message to the same reply when the config declares a resilience block', async () => {
    const engine = createHalEngine({...base, resilience: {maxAttempts: 3, baseDelayMs: 0}});

    const reply = await replyThrough(engine, 's-resilience');

    expect(reply).toEqual('Mock response to: "unwrapped" ');
  });

  it('hands a config-installed beforeModelResponse hook the built base system prompt, not merely storing it', async () => {
    let received = 'never called';
    const engine = createHalEngine({
      ...base,
      orchestrator: {
        hooks: {
          beforeModelResponse: async (_session, systemPrompt) => {
            received = systemPrompt;
            return systemPrompt;
          },
        },
      },
    });
    const session: ChatSession = {
      sessionId: 's-prompt',
      userId: 'u1',
      entries: [{role: 'user', content: 'hi', timestamp: ''}],
    };

    await engine.orchestrator.processMessage(session);

    expect(received).toBe('test');
  });

  it('fires the lifecycle hooks in documented order for a session that completes without error', async () => {
    const order: string[] = [];
    const engine = createHalEngine({
      ...base,
      orchestrator: {
        hooks: {
          beforeSession: async () => void order.push('beforeSession'),
          beforeUserInput: async (_session, message) => {
            order.push('beforeUserInput');
            return message;
          },
          afterUserInput: async () => void order.push('afterUserInput'),
          beforeModelResponse: async (_session, systemPrompt) => {
            order.push('beforeModelResponse');
            return systemPrompt;
          },
          afterModelResponse: async () => void order.push('afterModelResponse'),
          afterSession: async () => void order.push('afterSession'),
        },
      },
    });
    const session: ChatSession = {
      sessionId: 's-order',
      userId: 'u1',
      entries: [{role: 'user', content: 'hello', timestamp: ''}],
    };

    await engine.orchestrator.processMessage(session);

    expect(order).toEqual([
      'beforeSession',
      'beforeUserInput',
      'afterUserInput',
      'beforeModelResponse',
      'afterModelResponse',
      'afterSession',
    ]);
  });
});

// An unavailable port is a condition a consumer can handle, but only if start() lets them see it.
describe('createHalEngine on a port it cannot bind', () => {
  it('rejects instead of taking the process down with an unhandled error event', async () => {
    const blocker = net.createServer();
    await new Promise<void>(resolve => blocker.listen(0, resolve));
    const taken = (blocker.address() as net.AddressInfo).port;
    const engine = createHalEngine({...base, transport: {port: taken}});

    await expect(engine.start()).rejects.toMatchObject({code: 'EADDRINUSE'});

    await new Promise<void>(resolve => blocker.close(() => resolve()));
  });
});

// transport.additionalRoutes and transport.rootRoutes were declared but never forwarded to createApp.
describe('createHalEngine transport extension forwarding', () => {
  it('forwards transport.additionalRoutes to createApp so the route mounts under basePath', async () => {
    const engine = createHalEngine({
      ...base,
      transport: {
        additionalRoutes: (r: import('express').Router) => r.get('/ping', (_req, res) => res.json({ok: true})),
      },
    });

    const response = await request(engine.app).get('/hal/ping');
    const atRoot = await request(engine.app).get('/ping');

    expect({status: response.status, body: response.body, rootStatus: atRoot.status, rootBody: atRoot.body}).toEqual({
      status: 200,
      body: {ok: true},
      rootStatus: 404,
      rootBody: {error: 'Not Found'},
    });
  });

  it('leaves additionalRoutes and rootRoutes open while auth.http still guards the chat routes', async () => {
    const guarded: string[] = [];
    const refuse: HttpAuthMiddleware = (req, res) => {
      guarded.push(`${req.method} ${req.originalUrl}`);
      res.status(401).json({error: 'refused'});
    };
    const ok = (_req: Request, res: Response) => res.json({ok: true});
    const engine = createHalEngine({
      ...base,
      auth: {...base.auth, http: refuse},
      transport: {additionalRoutes: router => router.get('/ping', ok), rootRoutes: router => router.get('/status', ok)},
    });

    const statuses = await Promise.all(
      ['/hal/ping', '/status'].map(async path => (await request(engine.app).get(path)).status)
    );
    const chat = await request(engine.app).post('/hal/chats');

    expect({statuses, chat: chat.status, guarded}).toEqual({
      statuses: [200, 200],
      chat: 401,
      guarded: ['POST /hal/chats'],
    });
  });

  it('gives additionalRoutes and rootRoutes the parsed JSON body, the cookies and the CORS headers', async () => {
    const echo = (req: Request, res: Response) =>
      res.json({body: req.body as unknown, cookies: req.cookies as unknown});
    const engine = createHalEngine({
      ...base,
      transport: {
        corsOrigin: 'https://shop.example',
        additionalRoutes: router => router.post('/echo', echo),
        rootRoutes: router => router.post('/echo', echo),
      },
    });
    const call = async (path: string) => {
      const pending = request(engine.app).post(path);
      const response = await pending.set({Origin: 'https://shop.example', Cookie: 'theme=dark'}).send({city: 'Berlin'});
      return {body: response.body as unknown, origin: response.headers['access-control-allow-origin']};
    };

    const answered = await Promise.all([call('/hal/echo'), call('/echo')]);

    const expected = {body: {body: {city: 'Berlin'}, cookies: {theme: 'dark'}}, origin: 'https://shop.example'};
    expect(answered).toEqual([expected, expected]);
  });

  it("hands transport.errorHandler a route's synchronous throw and its rejected promise, and answers with its response", async () => {
    const engine = createHalEngine({
      ...base,
      transport: {
        rootRoutes: router => {
          router.get('/thrown', () => {
            throw new Error('thrown');
          });
          router.get('/rejected', () => Promise.reject(new Error('rejected')));
        },
        errorHandler: (error: unknown, _req, res, _next) =>
          void res.status(500).json({handled: error instanceof Error ? error.message : String(error)}),
      },
    });

    const thrown = await request(engine.app).get('/thrown');
    const rejected = await request(engine.app).get('/rejected');

    expect([thrown.body, rejected.body]).toEqual([{handled: 'thrown'}, {handled: 'rejected'}]);
  });

  it('answers 404 for a route added to engine.app after createHalEngine returns', async () => {
    const engine = createHalEngine({...base});
    engine.app.get('/late', (_req, res) => res.json({late: true}));

    const response = await request(engine.app).get('/late');

    expect({status: response.status, body: response.body}).toEqual({status: 404, body: {error: 'Not Found'}});
  });
});

// The transport reads `history.preview`, so the warning it logs for an inert one is evidence the field crossed over.
describe('createHalEngine conversation history forwarding', () => {
  afterEach(() => setLogger());

  it('forwards every field of transport.history, not only the switch the engine reads first', () => {
    const lines: string[] = [];
    const collect = (_category: string, message: string) => void lines.push(message);
    setLogger({debug: collect, info: collect, warn: collect, error: collect});

    createHalEngine({...base, transport: {history: {enabled: false, preview: true}}});

    expect(lines).toEqual([
      'conversation previews are on but conversation history is off, so no list is served at all',
    ]);
  });
});

// The store was declared on HalEngineConfig and reached the transport, but never the orchestrator.
describe('createHalEngine session store forwarding', () => {
  it('forwards the session store, so its write signal reaches the orchestrator', async () => {
    const saved: string[] = [];
    const session = recordingSessionStore(written => void saved.push(written.sessionId));
    const engine = createHalEngine({...base, session});

    await engine.orchestrator.processMessage(session.create('s1', 'u1') as ChatSession);

    expect(saved).toEqual(['s1']);
  });
});
