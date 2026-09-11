import {createHalEngine} from './config.js';
import {setLogger} from './shared/logger.js';
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

  it('leaves the built-in logger in place when none is supplied', async () => {
    const lines: string[] = [];
    setLogger({
      debug: (_c: string, m: string) => void lines.push(m),
      info: (_c: string, m: string) => void lines.push(m),
      warn: (_c: string, m: string) => void lines.push(m),
      error: (_c: string, m: string) => void lines.push(m),
    });

    createHalEngine({...base});

    expect(lines).toEqual([]);
  });
});
