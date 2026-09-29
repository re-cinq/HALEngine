import {jest} from '@jest/globals';
import type {WebSocket} from 'ws';
import {createMessageHandler} from './messageHandler.js';
import {createChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import type {OrchestratorHooks} from '../../orchestration/chatOrchestrator.js';
import {ToolRegistry} from '../../orchestration/tools/registry.js';
import type {ToolResponse} from '../../orchestration/tools/registry.js';
import {PromptBuilder} from '../../infrastructure/builders/promptBuilder.js';
import {setLogger} from '../../shared/logger.js';
import type {Logger} from '../../shared/logger.js';
import type {AIProvider, Message, MessageChunk, ToolResultContent} from '../../types/ai.js';
import type {ChatSession, SessionEntry} from '../../types/session.js';
import type {OutgoingMessage} from '../../types/messages.js';

// The real orchestrator behind the real handler: a policy is judged by what the model and the browser each receive.

const DECLINED = 'Not performed. A human reviewer has been asked to do it.';
const WANTS_TOOLS: MessageChunk = {type: 'stop', stopReason: 'tool_use'};
const ANSWER: MessageChunk[] = [
  {type: 'text', text: 'All done.'},
  {type: 'stop', stopReason: 'end_turn'},
];

const call = (id: string, name: string, input: Record<string, unknown> = {}): MessageChunk => ({
  type: 'tool_use',
  toolCall: {id, name, input},
});

const declineNotifications = async (_session: ChatSession, request: {name: string}) =>
  request.name === 'send_notification' ? {result: DECLINED} : undefined;

const engine = (rounds: MessageChunk[][], hooks: OrchestratorHooks = {}) => {
  const requests: Message[][] = [];
  const provider: AIProvider = {
    async *sendMessage({messages}) {
      requests.push([...messages]);
      yield* rounds[requests.length - 1] ?? ANSWER;
    },
    async generateStructured<T>(): Promise<T> {
      return {} as T;
    },
  };

  const executed: Record<string, unknown>[] = [];
  const registry = new ToolRegistry();
  registry.register(
    {name: 'lookup', description: 'Looks a booking up.', inputSchema: {type: 'object'}},
    async input => {
      executed.push(input);
      return 'looked up';
    }
  );
  registry.register(
    {name: 'send_notification', description: 'Notifies someone.', inputSchema: {type: 'object'}},
    async input => {
      executed.push(input);
      throw new Error('this executor must never run');
    }
  );

  const orchestrator = createChatOrchestrator(provider, new PromptBuilder({identity: 'A test assistant.'}), registry, {
    hooks,
  });
  const frames: OutgoingMessage[] = [];
  const ws = {send: (raw: string) => void frames.push(JSON.parse(raw) as OutgoingMessage)} as unknown as WebSocket;
  const session: ChatSession = {sessionId: 's1', userId: 'u1', entries: []};
  const handle = createMessageHandler(orchestrator);

  return {
    orchestrator,
    registry,
    requests,
    executed,
    frames,
    ask: (content = 'Please notify Ada') => handle(ws, session, {type: 'user_message', content}),
  };
};

// What the model was told about the round before this request: the tool_result message it closes with.
const toolResultsIn = (request: Message[] = []): ToolResultContent[] => {
  const last = request.at(-1);
  return last?.role === 'user' && Array.isArray(last.content) ? (last.content as ToolResultContent[]) : [];
};

const kinds = (frames: OutgoingMessage[]): string[] =>
  frames.map(frame => (frame.type === 'error' ? `error ${frame.code}` : frame.type));

describe('the beforeToolCall hook', () => {
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    const record = (...parts: unknown[]) => void lines.push(JSON.stringify(parts));
    setLogger({debug: record, info: record, warn: record, error: record} as Logger);
  });

  afterEach(() => setLogger());

  it('runs each pending call exactly once in a two-tool round when no policy is configured', async () => {
    const e = engine([[call('l1', 'lookup'), call('l2', 'lookup'), WANTS_TOOLS]]);
    const execute = jest.spyOn(e.registry, 'execute');

    await e.ask();

    const {calls} = execute.mock;
    expect(calls.map(([name]) => name)).toEqual(['lookup', 'lookup']);
  });

  it('hands the executor the very object the model produced when the policy returns undefined', async () => {
    const input = {booking: 'B-1'};
    const e = engine([[call('l1', 'lookup', input), WANTS_TOOLS]], {beforeToolCall: async () => undefined});

    await e.ask();

    const [received] = e.executed;
    expect(received).toBe(input);
  });

  it("answers a declined call with the policy's result under its own id and never runs the executor", async () => {
    const e = engine([[call('n1', 'send_notification'), WANTS_TOOLS]], {beforeToolCall: declineNotifications});

    await e.ask();

    expect({told: toolResultsIn(e.requests[1]), executed: e.executed}).toEqual({
      told: [{type: 'tool_result', toolUseId: 'n1', content: DECLINED}],
      executed: [],
    });
  });

  it('answers both calls of a round where one is declined and one proceeds, in order', async () => {
    const e = engine([[call('n1', 'send_notification'), call('l1', 'lookup'), WANTS_TOOLS]], {
      beforeToolCall: declineNotifications,
    });

    await e.ask();

    expect(toolResultsIn(e.requests[1])).toEqual([
      {type: 'tool_result', toolUseId: 'n1', content: DECLINED},
      {type: 'tool_result', toolUseId: 'l1', content: 'looked up'},
    ]);
  });

  it('suppresses on a declined response that asks for it, exactly as a tool would', async () => {
    const suppressing = async (): Promise<ToolResponse> => ({result: DECLINED, suppressAssistantResponse: true});
    const e = engine([[call('n1', 'send_notification'), WANTS_TOOLS], [{type: 'stop', stopReason: 'end_turn'}]], {
      beforeToolCall: suppressing,
    });
    const session: ChatSession = {
      sessionId: 's2',
      userId: 'u1',
      entries: [{role: 'user', content: 'ask', timestamp: 't'}],
    };

    const chunks: MessageChunk[] = [];
    for await (const chunk of e.orchestrator.processMessageStream(session)) chunks.push(chunk);

    expect(chunks.map(c => c.type)).toEqual(['tool_use', 'stop', 'suppress_output', 'stop']);
  });

  it('never consults the policy for a tool the registry does not have', async () => {
    const policy = jest.fn(async (): Promise<ToolResponse | undefined> => {
      throw new Error('consulted about an unknown tool');
    });
    const e = engine([[call('x1', 'no_such_tool'), WANTS_TOOLS]], {beforeToolCall: policy});

    await e.ask();

    const {calls} = policy.mock;
    expect({consulted: calls.length, ending: kinds(e.frames).slice(-2)}).toEqual({
      consulted: 0,
      ending: ['error SERVER_ERROR', 'stream_end'],
    });
  });

  it('declines the call when the policy throws, and the turn survives with every hook but onError', async () => {
    const fired: string[] = [];
    const e = engine([[call('n1', 'send_notification'), WANTS_TOOLS]], {
      beforeToolCall: async () => {
        throw new Error('policy service unreachable');
      },
      afterModelResponse: async () => void fired.push('afterModelResponse'),
      onError: async () => void fired.push('onError'),
    });

    await e.ask();

    const [told] = toolResultsIn(e.requests[1]);
    expect({
      executed: e.executed,
      namesTheTool: told?.content.includes('send_notification'),
      last: kinds(e.frames).at(-1),
      fired,
    }).toEqual({executed: [], namesTheTool: true, last: 'stream_end', fired: ['afterModelResponse']});
  });

  it("delivers a declined response's client messages to the browser, then answers the next message", async () => {
    const note: SessionEntry = {
      role: 'assistant',
      content: 'A reviewer will follow up.',
      timestamp: 't',
      isStreaming: false,
    };
    const declined: ToolResponse = {result: DECLINED, clientMessages: [{type: 'entry_upsert', index: 0, entry: note}]};
    const e = engine([[call('n1', 'send_notification'), WANTS_TOOLS]], {beforeToolCall: async () => declined});

    await e.ask();
    await e.ask('And my booking?');

    const noteAt = e.frames.findIndex(
      frame => frame.type === 'entry_upsert' && 'content' in frame.entry && frame.entry.content === note.content
    );
    const ends = kinds(e.frames).flatMap((kind, position) => (kind === 'stream_end' ? [position] : []));
    expect({index: e.frames[noteAt], endsAfterNote: ends.filter(end => end > noteAt).length}).toEqual({
      index: expect.objectContaining({index: 2}),
      endsAfterNote: 2,
    });
  });

  it('consults the policy once per requested call per round across three rounds', async () => {
    const policy = jest.fn(async (): Promise<ToolResponse | undefined> => undefined);
    const oneTool = (id: string) => [call(id, 'lookup'), WANTS_TOOLS];
    const e = engine([oneTool('l1'), oneTool('l2'), oneTool('l3')], {beforeToolCall: policy});

    await e.ask();

    expect(policy).toHaveBeenCalledTimes(3);
  });

  it('consults the policy once for each call of a two-tool round', async () => {
    const policy = jest.fn(async (): Promise<ToolResponse | undefined> => undefined);
    const e = engine([[call('l1', 'lookup'), call('l2', 'lookup'), WANTS_TOOLS]], {beforeToolCall: policy});

    await e.ask();

    expect(policy).toHaveBeenCalledTimes(2);
  });

  it('writes no value from the tool input to any log line, for a declined and an allowed call', async () => {
    // Built from entries so the model's snake_case key survives the camelcase rule unchanged.
    const input = Object.fromEntries([
      ['recipient_name', 'Ada Example'],
      ['location', 'Berlin'],
    ]);
    const e = engine([[call('n1', 'send_notification', input), call('l1', 'lookup', input), WANTS_TOOLS]], {
      beforeToolCall: declineNotifications,
    });

    await e.ask();

    expect({
      logged: lines.length > 0,
      leaked: lines.filter(line => line.includes('Ada Example') || line.includes('Berlin')),
    }).toEqual({logged: true, leaked: []});
  });
});
