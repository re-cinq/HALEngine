import type {AddressInfo} from 'node:net';
import {WebSocket} from 'ws';
import {composeProvider, createHalEngine} from './config.js';
import {fixtureMask, recording, STOP, text} from './providers/maskTestSupport.js';
import {withMask} from './providers/withMask.js';
import {createChatOrchestrator} from './orchestration/chatOrchestrator.js';
import {ToolRegistry} from './orchestration/tools/registry.js';
import {PromptBuilder} from './infrastructure/builders/promptBuilder.js';
import {InMemorySessionStore} from './infrastructure/stores/inMemorySessionStore.js';
import {HAL_WS_SUBPROTOCOL} from './transport/ws/subprotocol.js';
import {AIError} from './types/ai.js';
import type {AIProvider, MessageChunk} from './types/ai.js';
import type {WsAuthenticator} from './types/auth.js';
import {setLogger} from './shared/logger.js';

// The mask as createHalEngine composes it: outermost, one binding per call, and nothing a token in what is stored.

const quiet = () => undefined;
beforeAll(() => setLogger({debug: quiet, info: quiet, warn: quiet, error: quiet}));
afterAll(() => setLogger());

it("restores a masked reference in a model tool call before the tool's executor receives it", async () => {
  const {provider} = recording(
    [
      {type: 'tool_use', toolCall: {id: 'c1', name: 'lookup', input: {reference: '[[REF_1]]'}}},
      {type: 'stop', stopReason: 'tool_use'},
    ],
    [text('done'), STOP]
  );
  const received: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register({name: 'lookup', description: 'Looks it up.', inputSchema: {type: 'object'}}, async input => {
    received.push(input);
    return 'found';
  });
  const orchestrator = createChatOrchestrator(
    withMask(provider, fixtureMask().mask),
    new PromptBuilder({identity: 'Mask test.'}),
    registry
  );

  await orchestrator.processMessage({
    sessionId: 's',
    userId: 'u',
    entries: [{role: 'user', content: 'go', timestamp: 't'}],
  });

  expect(received).toEqual([{reference: 'OLT-2026-0001'}]);
});
it('hands afterModelResponse the real value, so an audit hook records what the user read', async () => {
  const {provider} = recording([text('[[NAME_1]] approved it'), STOP]);
  const recorded: string[] = [];
  const orchestrator = createChatOrchestrator(
    withMask(provider, fixtureMask().mask),
    new PromptBuilder({identity: 'Mask test.'}),
    undefined,
    {hooks: {afterModelResponse: async (_session, responseText) => void recorded.push(responseText)}}
  );

  await orchestrator.processMessage({
    sessionId: 's',
    userId: 'u',
    entries: [{role: 'user', content: 'go', timestamp: 't'}],
  });

  expect(recorded).toEqual(['Ada Example approved it']);
});

it('binds the mask once for a turn the retry tier attempts twice, so both attempts send text from one binding', async () => {
  const {mask, binds} = fixtureMask();
  let attempts = 0;
  const flaky: AIProvider = {
    async *sendMessage(): AsyncGenerator<MessageChunk> {
      attempts++;
      // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
      if (attempts === 1) throw new AIError('blip', 'SERVICE_UNAVAILABLE', true);
      yield {type: 'stop', stopReason: 'end_turn'};
    },
    generateStructured: async <T>() => ({}) as T,
  };

  const provider = composeProvider(
    {provider: {type: 'mock'}, resilience: {maxAttempts: 2, baseDelayMs: 0}, privacy: {mask}},
    () => flaky
  );
  for await (const chunk of provider.sendMessage({messages: [{role: 'user', content: 'hi'}], systemPrompt: 's'})) {
    void chunk;
  }

  expect({attempts, binds: binds()}).toEqual({attempts: 2, binds: 1});
});

it('stores no token after a WebSocket turn through createHalEngine: the session and the wire carry Ada Example', async () => {
  const sessionStore = new InMemorySessionStore();
  const engine = createHalEngine({
    provider: {type: 'mock'},
    prompt: {identity: 'Mask test.'},
    session: sessionStore,
    privacy: {mask: fixtureMask().mask},
    auth: {ws: (async () => ({id: 'u1'})) as WsAuthenticator},
  });
  await engine.start(0);
  const {port} = engine.server.address() as AddressInfo;
  const disconnected = new Promise<void>(resolve => {
    engine.wss.once('connection', socket => socket.once('close', () => setImmediate(resolve)));
  });

  const client = new WebSocket(`ws://127.0.0.1:${port}/hal/ws/c1`, [HAL_WS_SUBPROTOCOL]);
  const {sessionId, frames} = await new Promise<{sessionId: string; frames: string}>(resolve => {
    const received: string[] = [];
    let id = '';
    client.on('message', raw => {
      const frame = JSON.parse(String(raw)) as {type: string; sessionId?: string};
      received.push(String(raw));
      if (frame.type === 'connected') {
        id = frame.sessionId ?? '';
        client.send(JSON.stringify({type: 'user_message', content: 'Is the booking for Ada Example delivered?'}));
      }
      if (frame.type === 'stream_end') resolve({sessionId: id, frames: received.join('\n')});
    });
  });
  // Read before the client closes, since a closed session's entries leave the store with it.
  const stored = JSON.stringify((await sessionStore.get(sessionId))?.entries);
  client.close();
  // The server logs the disconnect on its own close; waiting for it keeps that line inside this test.
  await disconnected;
  await engine.stop();

  expect({
    storedToken: stored.includes('[['),
    storedName: stored.includes('Mock response to: \\"Is the booking for Ada Example delivered?\\"'),
    wireToken: frames.includes('[['),
  }).toEqual({storedToken: false, storedName: true, wireToken: false});
});
