import {jest} from '@jest/globals';
import {createMessageHandler} from './messageHandler.js';
import {recordingSocket} from './recordingSocketTestSupport.js';
import {createChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import type {OrchestratorHooks} from '../../orchestration/chatOrchestrator.js';
import {ToolRegistry} from '../../orchestration/tools/registry.js';
import {PromptBuilder} from '../../infrastructure/builders/promptBuilder.js';
import type {AIProvider, Message, MessageChunk} from '../../types/ai.js';
class CredentialExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialExpiredError';
  }
}
import type {ChatSession} from '../../types/session.js';
import type {OutgoingMessage} from '../../types/messages.js';
import {setLogger} from '../../shared/logger.js';
import type {Logger} from '../../shared/logger.js';

const WANTS_TOOLS: MessageChunk = {type: 'stop', stopReason: 'tool_use'};
const ANSWER: MessageChunk[] = [
  {type: 'text', text: 'All done.'},
  {type: 'stop', stopReason: 'end_turn'},
];

function makeCall(callId: string, toolName: string, callInput: Record<string, unknown> = {}): MessageChunk {
  return {type: 'tool_use', toolCall: {id: callId, name: toolName, input: callInput}};
}

function setupEngine(
  rounds: MessageChunk[][],
  hooks: OrchestratorHooks = {},
  initialAuthHeaders?: Record<string, string>
) {
  const sentRequests: Message[][] = [];
  const mockAiProvider: AIProvider = {
    sendMessage: async function* ({messages}) {
      sentRequests.push([...messages]);
      yield* rounds[sentRequests.length - 1] ?? ANSWER;
    },
    generateStructured: async <T>() => ({}) as T,
  };

  const executedAuthHeaders: (Record<string, string> | undefined)[] = [];
  const registry = new ToolRegistry();
  registry.register(
    {name: 'lookup', description: 'Looks a booking up.', inputSchema: {type: 'object'}},
    async (input, context) => {
      executedAuthHeaders.push(context.authHeaders);
      return 'looked up';
    }
  );
  registry.register(
    {name: 'mutating_tool', description: 'Mutates headers.', inputSchema: {type: 'object'}},
    async (input, context) => {
      if (context.authHeaders) {
        context.authHeaders.authorization = 'mutated';
      }
      return 'mutated';
    }
  );

  const orchestrator = createChatOrchestrator(
    mockAiProvider,
    new PromptBuilder({identity: 'A test assistant.'}),
    registry,
    {hooks}
  );
  const {ws, sent: frames} = recordingSocket();
  const session: ChatSession = {
    sessionId: 's1',
    userId: 'u1',
    entries: [],
    authHeaders: initialAuthHeaders ? {...initialAuthHeaders} : undefined,
  };
  const handle = createMessageHandler(orchestrator);

  return {
    orchestrator,
    registry,
    requests: sentRequests,
    executedAuthHeaders,
    frames,
    session,
    ws,
    ask: (content = 'Please notify Ada') => handle(ws, session, {type: 'user_message', content}),
  };
}

const kinds = (frames: OutgoingMessage[]): string[] =>
  frames.map(frame => (frame.type === 'error' ? `error ${frame.code}` : frame.type));

describe('resolveAuthHeaders hook acceptance', () => {
  beforeEach(() => {
    setLogger({debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn()} as unknown as Logger);
  });

  afterEach(() => setLogger());

  it('A two-round tool conversation whose hook returns different headers per round reaches the tool with the round-0 value in round 0 and the round-1 value in round 1', async () => {
    let roundCount = 0;
    const resolveAuthHeaders = jest.fn(async () => {
      roundCount++;
      return {authorization: `round-${roundCount - 1}`};
    });
    const e = setupEngine(
      [
        [makeCall('l1', 'lookup'), WANTS_TOOLS],
        [makeCall('l2', 'lookup'), WANTS_TOOLS],
      ],
      {resolveAuthHeaders}
    );

    await e.ask();

    expect(e.executedAuthHeaders).toEqual([{authorization: 'round-0'}, {authorization: 'round-1'}]);
  });

  it('A round with two tool calls invokes the hook exactly once; a turn with no tool call invokes it zero times', async () => {
    const resolveAuthHeaders = jest.fn(async () => ({authorization: 'resolved'}));
    const e1 = setupEngine([[makeCall('l1', 'lookup'), makeCall('l2', 'lookup'), WANTS_TOOLS]], {resolveAuthHeaders});
    await e1.ask();

    const {calls: c1} = resolveAuthHeaders.mock;
    const count1 = c1.length;
    resolveAuthHeaders.mockClear();
    const e2 = setupEngine([[]], {resolveAuthHeaders});
    await e2.ask();
    const {calls: c2} = resolveAuthHeaders.mock;
    const count2 = c2.length;
    expect({count1, count2}).toEqual({count1: 1, count2: 0});
  });

  it('After a run whose hook returned a different value, session.authHeaders still equals the value captured at upgrade — only the context is affected', async () => {
    const initialHeaders = {authorization: 'captured-at-upgrade'};
    const resolveAuthHeaders = jest.fn(async () => ({authorization: 'different-value'}));
    const e = setupEngine([[makeCall('l1', 'lookup'), WANTS_TOOLS]], {resolveAuthHeaders}, initialHeaders);

    await e.ask();

    expect({sess: e.session.authHeaders, exec: e.executedAuthHeaders}).toEqual({
      sess: {authorization: 'captured-at-upgrade'},
      exec: [{authorization: 'different-value'}],
    });
  });

  it("A hook throwing CredentialExpiredError('<message>') produces, in order: {type: 'error', code: 'CREDENTIAL_EXPIRED', message: '<that message>'} then {type: 'stream_end'}, over a real connection", async () => {
    const resolveAuthHeaders = jest.fn(async () => {
      throw new CredentialExpiredError('Your token has expired. Please login again.');
    });
    const e = setupEngine([[makeCall('l1', 'lookup'), WANTS_TOOLS]], {resolveAuthHeaders});

    await e.ask();

    const frameTypes = kinds(e.frames);
    const lastTwo = frameTypes.slice(-2);
    const errorFrame = e.frames[e.frames.length - 2];
    const msg = errorFrame.type === 'error' ? errorFrame.message : '';
    expect({lastTwo, msg}).toEqual({
      lastTwo: ['error CREDENTIAL_EXPIRED', 'stream_end'],
      msg: 'Your token has expired. Please login again.',
    });
  });

  it('onError fires exactly once, with the same error instance, before the error frame is sent', async () => {
    const errorInstance = new CredentialExpiredError('Your token has expired.');
    const resolveAuthHeaders = jest.fn(async () => {
      throw errorInstance;
    });
    let capturedError: Error | undefined;
    let framesAtOnError: number = -1;
    const onError = jest.fn(async (_session: ChatSession, error: Error) => {
      capturedError = error;
    });

    const e2 = setupEngine([[makeCall('l1', 'lookup'), WANTS_TOOLS]], {resolveAuthHeaders, onError});
    onError.mockImplementation(async (_session: ChatSession, error: Error) => {
      capturedError = error;
      framesAtOnError = e2.frames.length;
    });

    await e2.ask();

    const finalFramesCount = e2.frames.length;
    const {calls: oc} = onError.mock;
    expect({calls: oc.length, err: capturedError, f: framesAtOnError}).toEqual({
      calls: 1,
      err: errorInstance,
      f: finalFramesCount - 2,
    });
  });

  it("Any other Error thrown from the hook keeps today's generic SERVER_ERROR path unchanged", async () => {
    const resolveAuthHeaders = jest.fn(async () => {
      throw new Error('Database connection failed');
    });
    const e = setupEngine([[makeCall('l1', 'lookup'), WANTS_TOOLS]], {resolveAuthHeaders});

    await e.ask();

    const lastTwo = kinds(e.frames).slice(-2);
    expect(lastTwo).toEqual(['error SERVER_ERROR', 'stream_end']);
  });
});
