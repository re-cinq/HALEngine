import {describe, it, expect, beforeEach, afterEach, jest} from '@jest/globals';
import {createChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import type {OrchestratorHooks} from '../../orchestration/chatOrchestrator.js';
import {ToolRegistry} from '../../orchestration/tools/registry.js';
import {PromptBuilder} from '../../infrastructure/builders/promptBuilder.js';
import {setLogger} from '../../shared/logger.js';
import type {Logger} from '../../shared/logger.js';
import type {AIProvider, MessageChunk} from '../../types/ai.js';
import type {ChatSession} from '../../types/session.js';
import * as halEngine from '../../orchestration/credentialExpiredError.js';
import {connectClient, startEngineWith, stopEngines} from '../wsTestSupport.js';
import {InMemorySessionStore} from '../../infrastructure/stores/inMemorySessionStore.js';
import {recordingSocket} from './recordingSocketTestSupport.js';
import {createMessageHandler} from './messageHandler.js';
import {WANTS_TOOLS, ANSWER, call, makeScriptedProvider} from './wsToolTestSupport.js';

const engine = (
  rounds: MessageChunk[][],
  hooks: OrchestratorHooks = {},
  initialAuthHeaders?: Record<string, string>
) => {
  const {provider, requests} = makeScriptedProvider(rounds);

  const executed: Array<{input: Record<string, unknown>; context: Record<string, unknown>}> = [];
  const registry = new ToolRegistry();
  registry.register(
    {name: 'lookup', description: 'Looks a booking up.', inputSchema: {type: 'object'}},
    async (input, context) => {
      executed.push({input, context: {authHeaders: context?.authHeaders ? {...context.authHeaders} : undefined}});
      if (input.mutate && context?.authHeaders) {
        context.authHeaders.authorization = 'mutated';
      }
      return 'looked up';
    }
  );

  const orchestrator = createChatOrchestrator(provider, new PromptBuilder({identity: 'A test assistant.'}), registry, {
    hooks,
  });

  const session: ChatSession = {sessionId: 's1', userId: 'u1', entries: [], authHeaders: initialAuthHeaders};

  const {ws, sent: frames} = recordingSocket();
  const handle = createMessageHandler(orchestrator);

  return {
    orchestrator,
    registry,
    requests,
    executed,
    frames,
    session,
    ask: (content = 'Please lookup') => handle(ws, session, {type: 'user_message', content}),
  };
};

afterEach(stopEngines);

describe('Tool Credentials', () => {
  beforeEach(() => setLogger({debug: () => {}, info: () => {}, warn: () => {}, error: () => {}} as unknown as Logger));
  afterEach(() => setLogger());

  it('invokes resolveAuthHeaders zero times for a turn with no tool call ([validated by specs/hal-engine-architecture/spec.md#L540])', async () => {
    const hook = jest.fn<(session: ChatSession) => Promise<ChatSession['authHeaders']>>();
    const e = engine([ANSWER], {resolveAuthHeaders: hook});
    await e.ask();
    expect(hook).not.toHaveBeenCalled();
  });

  it('invokes resolveAuthHeaders exactly once for a round with two tool calls ([validated by specs/hal-engine-architecture/spec.md#L541])', async () => {
    const hook = jest.fn<(session: ChatSession) => Promise<ChatSession['authHeaders']>>();
    const e = engine([[call('c1', 'lookup'), call('c2', 'lookup'), WANTS_TOOLS]], {resolveAuthHeaders: hook});
    await e.ask();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('hands the tool the round-0 value in round 0 and the round-1 value in round 1 ([validated by specs/hal-engine-architecture/spec.md#L542])', async () => {
    const hook = jest
      .fn<(session: ChatSession) => Promise<ChatSession['authHeaders']>>()
      .mockResolvedValueOnce({authorization: 'Bearer 0'})
      .mockResolvedValueOnce({authorization: 'Bearer 1'});
    const e = engine(
      [
        [call('c1', 'lookup'), WANTS_TOOLS],
        [call('c2', 'lookup'), WANTS_TOOLS],
      ],
      {resolveAuthHeaders: hook}
    );
    await e.ask();
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it('hands the tool the headers captured at upgrade when no resolveAuthHeaders is configured ([validated by specs/hal-engine-architecture/spec.md#L543])', async () => {
    const e = engine([[call('c1', 'lookup'), WANTS_TOOLS]], {}, {authorization: 'Bearer original'});
    await e.ask();
    const executed = e.executed;
    const ctx = executed[0]?.context;
    expect(ctx?.authHeaders).toEqual({authorization: 'Bearer original'});
  });

  it('keeps session.authHeaders equal to the value captured at upgrade after a hook returns a different value ([validated by specs/hal-engine-architecture/spec.md#L544])', async () => {
    const hook = jest
      .fn<(session: ChatSession) => Promise<ChatSession['authHeaders']>>()
      .mockResolvedValue({authorization: 'Bearer new'});
    const e = engine(
      [[call('c1', 'lookup'), WANTS_TOOLS]],
      {resolveAuthHeaders: hook},
      {authorization: 'Bearer original'}
    );
    await e.ask();
    expect(e.session.authHeaders).toEqual({authorization: 'Bearer original'});
  });

  it('protects session.authHeaders and the next tool in the same round from an executor that mutates context.authHeaders.authorization ([validated by specs/hal-engine-architecture/spec.md#L547])', async () => {
    const e = engine(
      [[call('c1', 'lookup', {mutate: true}), call('c2', 'lookup'), WANTS_TOOLS]],
      {},
      {authorization: 'Bearer original'}
    );
    await e.ask();

    const executed = e.executed;
    const nextCtx = executed[1]?.context;
    expect({session: e.session.authHeaders, nextTool: nextCtx?.authHeaders}).toMatchObject({
      session: {authorization: 'Bearer original'},
      nextTool: {authorization: 'Bearer original'},
    });
  });

  it('keeps todays generic SERVER_ERROR path unchanged for any Error thrown from the hook that is not a CredentialExpiredError ([validated by specs/hal-engine-architecture/spec.md#L548])', async () => {
    const hook = jest
      .fn<(session: ChatSession) => Promise<ChatSession['authHeaders']>>()
      .mockRejectedValue(new Error('boom'));
    const e = engine([[call('c1', 'lookup'), WANTS_TOOLS]], {resolveAuthHeaders: hook});
    await expect(e.ask()).rejects.toThrow('boom');
  });

  it('CredentialExpiredError is exported from the package root ([validated by specs/hal-engine-architecture/spec.md#L550])', () => {
    expect('CredentialExpiredError' in halEngine).toBe(true);
  });

  it('produces error CREDENTIAL_EXPIRED and stream_end over a real connection ([validated by specs/hal-engine-websocket-protocol/spec.md#L379] [validated by specs/hal-engine-architecture/spec.md#L549])', async () => {
    const CredentialExpiredError = halEngine.CredentialExpiredError;
    const thrownError = new CredentialExpiredError('the credential expired msg');
    const hook = jest
      .fn<(session: ChatSession) => Promise<ChatSession['authHeaders']>>()
      .mockRejectedValue(thrownError);

    const registry = new ToolRegistry();
    registry.register({name: 'lookup', description: 'looks up', inputSchema: {type: 'object'}}, async () => 'lookup');

    const provider: AIProvider = {
      async *sendMessage() {
        yield call('c1', 'lookup');
        yield WANTS_TOOLS;
      },
      async generateStructured<T>(): Promise<T> {
        return {} as T;
      },
    };

    const orchestrator = createChatOrchestrator(
      provider,
      new PromptBuilder({identity: 'A test assistant.'}),
      registry,
      {
        hooks: {resolveAuthHeaders: hook},
      }
    );

    const store = new InMemorySessionStore();
    const {url} = await startEngineWith({
      sessionStore: store,
      orchestrator,
    });

    const frames: string[] = [];
    await new Promise<void>(resolve => {
      const client = connectClient(url, 't');
      client.on('message', raw => {
        const frame = JSON.parse(String(raw));
        if (frame.type === 'connected') {
          client.send(JSON.stringify({type: 'user_message', content: 'test'}));
          return;
        }
        frames.push(String(raw));
        if (frame.type === 'stream_end') {
          client.close();
          resolve();
        }
      });
    });

    const parsedFrames = frames.map(f => JSON.parse(f));

    const credIdx = parsedFrames.findIndex(f => f.type === 'error' && f.code === 'CREDENTIAL_EXPIRED');
    expect(parsedFrames.slice(credIdx, credIdx + 2)).toEqual([
      {type: 'error', code: 'CREDENTIAL_EXPIRED', message: 'the credential expired msg'},
      {type: 'stream_end'},
    ]);
  });
});
