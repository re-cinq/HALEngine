import net from 'node:net';
import request from 'supertest';
import {createHalEngine} from './config.js';
import {log, setLogger} from './shared/logger.js';
import type {Logger} from './shared/logger.js';
import type {ChatSession} from './types/session.js';
import type {WsAuthenticator} from './types/auth.js';

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

    expect({status: response.status, body: response.body}).toEqual({status: 200, body: {ok: true}});
  });
});
