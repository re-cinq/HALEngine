import {jest} from '@jest/globals';
import type {AddressInfo} from 'node:net';
import {createChatOrchestrator} from './orchestration/chatOrchestrator.js';
import type {ChatOrchestratorOptions, OrchestratorHooks} from './orchestration/chatOrchestrator.js';
import {ToolRegistry} from './orchestration/tools/registry.js';
import type {ToolContext, ToolExecutor} from './orchestration/tools/registry.js';
import {PromptBuilder} from './infrastructure/builders/promptBuilder.js';
import {setLogger} from './shared/logger.js';
import {askOnOpen, stopEngines} from './transport/wsTestSupport.js';
import type {AIProvider, Message, MessageChunk, ToolCall, ToolCallContent, ToolResultContent} from './types/ai.js';
import type {WsAuthenticator} from './types/auth.js';
import type {ChatSession} from './types/session.js';

// No provider type createHalEngine builds ever asks for a tool, so its factory is the seam for the engine-level tests.
let engineProvider: AIProvider | undefined;
jest.unstable_mockModule('./providers/providerFactory.js', () => ({createProvider: () => engineProvider}));
const {createHalEngine} = await import('./config.js');

const DEFAULT_DEADLINE_MS = 30_000;

const call = (id: string, name: string, input: Record<string, unknown> = {}): ToolCall => ({id, name, input});
const never = (): Promise<string> => new Promise<string>(() => undefined);
const timeoutResult = (name: string, ms: number): string =>
  `Tool '${name}' did not answer within ${ms} ms, so the call was abandoned and returned no result.`;

const sessionAsking = (): ChatSession => ({
  sessionId: 's',
  userId: 'u',
  authHeaders: {authorization: 'Bearer test'},
  entries: [{role: 'user', content: 'go', timestamp: 't'}],
});

// Asks for `calls` on its first request and answers on the next, keeping a copy of what each request carried.
function toolRound(calls: ToolCall[]): {provider: AIProvider; sent: Message[][]} {
  const sent: Message[][] = [];
  const provider: AIProvider = {
    async *sendMessage({messages}) {
      sent.push(structuredClone(messages));
      const asks: MessageChunk[] = [
        ...calls.map(toolCall => ({type: 'tool_use' as const, toolCall})),
        {type: 'stop', stopReason: 'tool_use'},
      ];
      const answers: MessageChunk[] = [
        {type: 'text', text: 'Done.'},
        {type: 'stop', stopReason: 'end_turn'},
      ];
      yield* sent.length === 1 ? asks : answers;
    },
    async generateStructured<T>(): Promise<T> {
      return {} as T;
    },
  };
  return {provider, sent};
}

function registryOf(tools: Record<string, ToolExecutor>): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [name, execute] of Object.entries(tools)) {
    registry.register({name, description: `The ${name} tool.`, inputSchema: {type: 'object'}}, execute);
  }
  return registry;
}

// One turn whose single tool round asks for `calls`; `state.settled` flips once the turn has ended.
function turn(calls: ToolCall[], tools: Record<string, ToolExecutor>, options: ChatOrchestratorOptions = {}) {
  const {provider, sent} = toolRound(calls);
  const session = sessionAsking();
  const promptBuilder = new PromptBuilder({identity: 'Deadline test.'});
  const reply = createChatOrchestrator(provider, promptBuilder, registryOf(tools), options).processMessage(session);
  const state = {settled: false};
  void reply.then(() => (state.settled = true));
  return {reply, state, session, sent};
}

// The tool results the model was handed on the request after the round.
const resultsSent = (sent: Message[][]): ToolResultContent[] =>
  (sent[1] ?? [])
    .flatMap((message): Array<ToolCallContent | ToolResultContent> =>
      typeof message.content === 'string' ? [] : message.content
    )
    .filter((block): block is ToolResultContent => block.type === 'tool_result');

describe('a deadline per tool call', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('answers a call that never settles at toolTimeoutMs with a result naming the tool and the deadline, and aborts its signal', async () => {
    let context: ToolContext | undefined;
    const hangs: ToolExecutor = async (_input, received) => {
      context = received;
      return never();
    };
    const t = turn([call('c1', 'lookup')], {lookup: hangs});

    await jest.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS);

    expect({reply: await t.reply, aborted: context?.signal?.aborted, results: resultsSent(t.sent)}).toEqual({
      reply: 'Done.',
      aborted: true,
      results: [{type: 'tool_result', toolUseId: 'c1', content: timeoutResult('lookup', DEFAULT_DEADLINE_MS)}],
    });
  });

  it('returns a fast call beside a timed-out one unchanged, ending the round at the deadline', async () => {
    const t = turn([call('c1', 'lookup'), call('c2', 'quick')], {lookup: never, quick: async () => 'quick result'});

    await jest.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS - 1);
    const beforeDeadline = t.state.settled;
    await jest.advanceTimersByTimeAsync(1);

    expect({beforeDeadline, reply: await t.reply, results: resultsSent(t.sent)}).toEqual({
      beforeDeadline: false,
      reply: 'Done.',
      results: [
        {type: 'tool_result', toolUseId: 'c1', content: timeoutResult('lookup', DEFAULT_DEADLINE_MS)},
        {type: 'tool_result', toolUseId: 'c2', content: 'quick result'},
      ],
    });
  });

  it('hands each call in a round its own context and signal, while authHeaders stays one shared object', async () => {
    const contexts: Array<ToolContext | undefined> = [];
    const keep: ToolExecutor = async (_input, context) => {
      contexts.push(context);
      return 'ok';
    };
    const t = turn([call('c1', 'first'), call('c2', 'second')], {first: keep, second: keep});

    await t.reply;

    const [first, second] = contexts;
    expect({
      ownContexts: first !== second,
      ownSignals:
        first?.signal instanceof AbortSignal && second?.signal instanceof AbortSignal && first.signal !== second.signal,
      sharedAuthHeaders: first?.authHeaders === t.session.authHeaders && second?.authHeaders === t.session.authHeaders,
    }).toEqual({ownContexts: true, ownSignals: true, sharedAuthHeaders: true});
  });

  it('bounds a beforeToolCall policy that never answers by the same deadline', async () => {
    const hooks: OrchestratorHooks = {beforeToolCall: () => new Promise<undefined>(() => undefined)};
    const t = turn([call('c1', 'lookup')], {lookup: async () => 'found'}, {hooks});

    await jest.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS);

    expect({reply: await t.reply, results: resultsSent(t.sent)}).toEqual({
      reply: 'Done.',
      results: [{type: 'tool_result', toolUseId: 'c1', content: timeoutResult('lookup', DEFAULT_DEADLINE_MS)}],
    });
  });

  it('never starts the executor of a call abandoned while its beforeToolCall policy was still deciding', async () => {
    let executions = 0;
    const counted: ToolExecutor = async () => {
      executions++;
      return 'found';
    };
    const approvesLate: OrchestratorHooks = {
      beforeToolCall: () =>
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), DEFAULT_DEADLINE_MS + 50)),
    };
    const t = turn([call('c1', 'lookup')], {lookup: counted}, {hooks: approvesLate});

    await jest.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS + 50);

    expect({reply: await t.reply, executions, results: resultsSent(t.sent)}).toEqual({
      reply: 'Done.',
      executions: 0,
      results: [{type: 'tool_result', toolUseId: 'c1', content: timeoutResult('lookup', DEFAULT_DEADLINE_MS)}],
    });
  });

  it('keeps the call input out of the timeout result and every log line, the timeout line naming only the tool and the elapsed time', async () => {
    const written: string[] = [];
    const keepLine = (_category: string, message: string, fields?: Record<string, unknown>) =>
      void written.push(JSON.stringify({message, ...fields}));
    setLogger({debug: keepLine, info: keepLine, warn: keepLine, error: keepLine});

    try {
      const t = turn([call('c1', 'lookup', {customerNumber: '10042', name: 'Jens Hansen'})], {lookup: never});
      await jest.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS);
      const everything = [...written, JSON.stringify(resultsSent(t.sent))];

      expect({
        reply: await t.reply,
        leaked: ['10042', 'Jens Hansen'].filter(value => everything.some(line => line.includes(value))),
        timeoutLines: written.filter(line => line.includes('tool call timed out')),
      }).toEqual({
        reply: 'Done.',
        leaked: [],
        timeoutLines: [
          JSON.stringify({message: 'tool call timed out', tool: 'lookup', elapsedMs: DEFAULT_DEADLINE_MS}),
        ],
      });
    } finally {
      setLogger();
    }
  });

  it('handles a call that rejects after the deadline, so it never becomes an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const keepReason = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', keepReason);

    try {
      const failsLate = () =>
        new Promise<string>((_resolve, reject) =>
          setTimeout(() => reject(new Error('late')), DEFAULT_DEADLINE_MS + 50)
        );
      const t = turn([call('c1', 'lookup')], {lookup: failsLate});
      await jest.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS + 50);
      await t.reply;
      jest.useRealTimers();
      await new Promise(resolve => setTimeout(resolve, 20));

      expect({unhandled}).toEqual({unhandled: []});
    } finally {
      process.off('unhandledRejection', keepReason);
    }
  });

  it('discards a call that resolves after the deadline, its client messages included', async () => {
    const lateEntry = {role: 'assistant' as const, content: 'too late', timestamp: 't', isStreaming: false};
    const resolvesLate: ToolExecutor = () =>
      new Promise(resolve =>
        setTimeout(
          () => resolve({result: 'late', clientMessages: [{type: 'entry_upsert', index: 0, entry: lateEntry}]}),
          DEFAULT_DEADLINE_MS + 50
        )
      );
    const t = turn([call('c1', 'lookup')], {lookup: resolvesLate});

    await jest.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS + 50);
    await t.reply;

    expect({entries: t.session.entries, results: resultsSent(t.sent)}).toEqual({
      entries: sessionAsking().entries,
      results: [{type: 'tool_result', toolUseId: 'c1', content: timeoutResult('lookup', DEFAULT_DEADLINE_MS)}],
    });
  });

  it('clears every deadline timer when the calls settle first', async () => {
    const t = turn([call('c1', 'first'), call('c2', 'second')], {first: async () => 'one', second: async () => 'two'});

    await t.reply;

    expect({timers: jest.getTimerCount()}).toEqual({timers: 0});
  });

  it('waits without a deadline when toolTimeoutMs is 0', async () => {
    const t = turn([call('c1', 'lookup')], {lookup: never}, {toolTimeoutMs: 0});

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect({settled: t.state.settled, timers: jest.getTimerCount()}).toEqual({settled: false, timers: 0});
  });

  it('falls back to the 30000 ms default for a negative or non-finite toolTimeoutMs', async () => {
    const turns = [-1, Number.NaN].map(toolTimeoutMs => turn([call('c1', 'lookup')], {lookup: never}, {toolTimeoutMs}));

    await jest.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS - 1);
    const beforeDefault = turns.map(t => t.state.settled);
    await jest.advanceTimersByTimeAsync(1);

    expect({beforeDefault, replies: await Promise.all(turns.map(t => t.reply))}).toEqual({
      beforeDefault: [false, false],
      replies: ['Done.', 'Done.'],
    });
  });

  it('holds a toolTimeoutMs beyond the longest delay Node can schedule at that ceiling instead of firing at once', async () => {
    const t = turn([call('c1', 'lookup')], {lookup: never}, {toolTimeoutMs: 2 ** 31});

    await jest.advanceTimersByTimeAsync(1_000);

    expect({settled: t.state.settled}).toEqual({settled: false});
  });
});

describe('a deadline set through createHalEngine', () => {
  const engines: Array<{stop: () => Promise<void>}> = [];

  afterEach(async () => {
    await stopEngines();
    for (const engine of engines.splice(0)) await engine.stop();
  });

  const engineWithHangingTool = () => {
    const {provider, sent} = toolRound([call('c1', 'lookup')]);
    engineProvider = provider;
    const engine = createHalEngine({
      provider: {type: 'mock'},
      prompt: {identity: 'Deadline test.'},
      tools: registryOf({lookup: never}),
      auth: {ws: (async () => ({id: 'u1'})) as unknown as WsAuthenticator},
      orchestrator: {toolTimeoutMs: 20},
    });
    engines.push(engine);
    return {engine, sent};
  };

  it('forwards orchestrator.toolTimeoutMs, so a call that never settles is abandoned at the configured deadline', async () => {
    const {engine, sent} = engineWithHangingTool();

    const reply = await engine.orchestrator.processMessage(sessionAsking());

    expect({reply, results: resultsSent(sent)}).toEqual({
      reply: 'Done.',
      results: [{type: 'tool_result', toolUseId: 'c1', content: timeoutResult('lookup', 20)}],
    });
  });

  it('ends a turn whose tool never answers with stream_end over the WebSocket, never an error', async () => {
    const {engine} = engineWithHangingTool();
    await engine.start(0);
    const {port} = engine.server.address() as AddressInfo;

    const seen = await askOnOpen(`ws://127.0.0.1:${port}/hal/ws/c1`).finished;

    expect({last: seen.at(-1), errors: seen.filter(type => type === 'error')}).toEqual({
      last: 'stream_end',
      errors: [],
    });
  });
});
