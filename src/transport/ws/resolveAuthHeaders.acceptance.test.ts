import {jest} from '@jest/globals';
import {createMessageHandler} from './messageHandler.js';
import {recordingSocket} from './recordingSocketTestSupport.js';
import {connectClient, startEngineWith, stopEngines} from '../wsTestSupport.js';
import {InMemorySessionStore} from '../../infrastructure/stores/inMemorySessionStore.js';
import {createChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import type {ChatOrchestrator, OrchestratorHooks} from '../../orchestration/chatOrchestrator.js';
import {ToolRegistry} from '../../orchestration/tools/registry.js';
import {PromptBuilder} from '../../infrastructure/builders/promptBuilder.js';
import type {AIProvider, Message, MessageChunk} from '../../types/ai.js';
import {CredentialExpiredError} from '../../types/session.js';
import type {ChatSession} from '../../types/session.js';
import type {OutgoingMessage} from '../../types/messages.js';
import {setLogger} from '../../shared/logger.js';
import type {Logger} from '../../shared/logger.js';
import {keepEveryLine} from '../../shared/logCaptureTestSupport.js';

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
    async (_input, context) => {
      executedAuthHeaders.push(context?.authHeaders);
      return 'looked up';
    }
  );
  registry.register(
    {name: 'mutating_tool', description: 'Mutates headers.', inputSchema: {type: 'object'}},
    async (_input, context) => {
      if (context?.authHeaders) {
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

async function realTurn(orchestrator: ChatOrchestrator): Promise<OutgoingMessage[]> {
  const {url, hal} = await startEngineWith({
    sessionStore: new InMemorySessionStore(),
    orchestrator,
    forwardHeaders: ['authorization'],
  });
  const serverClosed = new Promise<void>(resolve => {
    hal.wss.once('connection', socket => socket.once('close', () => setImmediate(resolve)));
  });
  const client = connectClient(url, 'upgrade-token-7a1b');
  const frames: OutgoingMessage[] = [];
  await new Promise<void>(resolve => {
    client.on('message', raw => {
      const frame = JSON.parse(String(raw)) as OutgoingMessage;
      frames.push(frame);
      if (frame.type === 'connected') client.send(JSON.stringify({type: 'user_message', content: 'Please notify Ada'}));
      if (frame.type === 'stream_end') resolve();
    });
  });
  client.close();
  await serverClosed;
  return frames;
}

const kinds = (frames: OutgoingMessage[]): string[] =>
  frames.map(frame => (frame.type === 'error' ? `error ${frame.code}` : frame.type));

describe('resolveAuthHeaders hook acceptance', () => {
  beforeEach(() => {
    setLogger({debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn()} as unknown as Logger);
  });

  afterEach(async () => {
    await stopEngines();
    setLogger();
  });

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
    const secret = 'secret-round-0-9f4a';
    const lines = keepEveryLine();
    let round = 0;
    const resolveAuthHeaders = jest.fn(async () => {
      round++;
      if (round === 1) return {authorization: `Bearer ${secret}`};
      throw new CredentialExpiredError('Your token has expired. Please login again.');
    });
    const e = setupEngine(
      [
        [makeCall('l1', 'lookup'), WANTS_TOOLS],
        [makeCall('l2', 'lookup'), WANTS_TOOLS],
      ],
      {resolveAuthHeaders}
    );

    const frames = await realTurn(e.orchestrator);

    expect({
      lastTwo: frames.slice(-2),
      linesLogged: lines.length > 0,
      secretInLogs: JSON.stringify(lines).includes(secret),
      secretInFrames: JSON.stringify(frames).includes(secret),
    }).toEqual({
      lastTwo: [
        {type: 'error', code: 'CREDENTIAL_EXPIRED', message: 'Your token has expired. Please login again.'},
        {type: 'stream_end'},
      ],
      linesLogged: true,
      secretInLogs: false,
      secretInFrames: false,
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

  it('With no resolveAuthHeaders configured, a tool still receives the headers captured at upgrade — tested, not assumed', async () => {
    const initialHeaders = {authorization: 'captured-at-upgrade'};
    const e = setupEngine([[makeCall('l1', 'lookup'), WANTS_TOOLS]], undefined, initialHeaders);

    await e.ask();

    expect(e.executedAuthHeaders).toEqual([{authorization: 'captured-at-upgrade'}]);
  });

  it('A tool executor that mutates context.authHeaders.authorization changes neither session.authHeaders nor the context handed to the next tool in the same round — the aliasing fix', async () => {
    const initialHeaders = {authorization: 'captured-at-upgrade'};
    const e = setupEngine(
      [[makeCall('m1', 'mutating_tool'), makeCall('l2', 'lookup'), WANTS_TOOLS]],
      undefined,
      initialHeaders
    );

    await e.ask();

    expect({
      sess: e.session.authHeaders,
      exec: e.executedAuthHeaders,
    }).toEqual({
      sess: {authorization: 'captured-at-upgrade'},
      exec: [{authorization: 'captured-at-upgrade'}],
    });
  });

  it('writes the resolved header values to no log line at any level and to no wire frame across a real connection', async () => {
    const secret = 'secret-round-token-8c2d';
    const lines = keepEveryLine();
    const e = setupEngine([[makeCall('l1', 'lookup'), WANTS_TOOLS]], {
      resolveAuthHeaders: async () => ({authorization: `Bearer ${secret}`}),
    });

    const frames = await realTurn(e.orchestrator);

    expect({
      received: e.executedAuthHeaders,
      linesLogged: lines.length > 0,
      secretInLogs: JSON.stringify(lines).includes(secret),
      secretInFrames: JSON.stringify(frames).includes(secret),
    }).toEqual({
      received: [{authorization: `Bearer ${secret}`}],
      linesLogged: true,
      secretInLogs: false,
      secretInFrames: false,
    });
  });
});
