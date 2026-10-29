import {createChatOrchestrator} from './chatOrchestrator.js';
import type {ChatOrchestratorOptions} from './chatOrchestrator.js';
import {ToolRegistry, normalizeToolResponse} from './tools/registry.js';
import type {ToolExecutor} from './tools/registry.js';
import {PromptBuilder} from '../infrastructure/builders/promptBuilder.js';
import type {AIProvider, MessageChunk, SendMessageParams, ToolCallContent, ToolResultContent} from '../types/ai.js';
import {setLogger} from '../shared/logger.js';

const STOP: MessageChunk = {type: 'stop', stopReason: 'end_turn'};
const TOOL_STOP: MessageChunk = {type: 'stop', stopReason: 'tool_use'};

interface Call {
  name?: string;
  input?: Record<string, unknown>;
  options?: ChatOrchestratorOptions;
}

// The tool_result blocks of the provider's second request, after one round calling `name`; lookup requires an `id`.
async function resultsSentBack(executor: ToolExecutor, {name = 'lookup', input = {id: 'b-1'}, options}: Call = {}) {
  const registry = new ToolRegistry();
  const schema = {type: 'object', properties: {id: {type: 'string'}}, required: ['id']};
  registry.register({name: 'lookup', description: 'Looks a booking up.', inputSchema: schema}, executor);
  const sent: SendMessageParams[] = [];
  const rounds: MessageChunk[][] = [[{type: 'tool_use', toolCall: {id: 'c1', name, input}}, TOOL_STOP], [STOP]];
  const provider: AIProvider = {
    async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
      yield* rounds[Math.min(sent.push(params) - 1, 1)];
    },
    generateStructured: async <T>() => ({}) as T,
  };
  const orchestrator = createChatOrchestrator(provider, new PromptBuilder({identity: 'Errors.'}), registry, options);
  await orchestrator.processMessage({
    sessionId: 's1',
    userId: 'u1',
    entries: [{role: 'user', content: 'go', timestamp: 't'}],
  });
  const [, second] = sent;
  return (second?.messages ?? [])
    .flatMap((message): Array<ToolCallContent | ToolResultContent> =>
      typeof message.content === 'string' ? [] : message.content
    )
    .filter((block): block is ToolResultContent => block.type === 'tool_result');
}

const isErrorOf = async (executor: ToolExecutor, call?: Call): Promise<unknown[]> =>
  (await resultsSentBack(executor, call)).map(block => block.isError);

const quiet = () => undefined;
beforeAll(() => setLogger({debug: quiet, info: quiet, warn: quiet, error: quiet}));
afterAll(() => setLogger());

describe('a tool result marked as an error', () => {
  it("normalizes '18 degrees and clear' to {result} with no isError key", () => {
    const response = normalizeToolResponse('18 degrees and clear');

    expect({response, hasKey: Object.hasOwn(response, 'isError')}).toEqual({
      response: {result: '18 degrees and clear'},
      hasKey: false,
    });
  });

  it("carries isError true from an executor's {result: 'lookup failed', isError: true} onto the tool_result the provider's next call gets", async () => {
    const results = await resultsSentBack(async () => ({result: 'lookup failed', isError: true}));

    expect(results).toEqual([{type: 'tool_result', toolUseId: 'c1', content: 'lookup failed', isError: true}]);
  });

  it('sends a successful result with no isError key at all, as before the field existed', async () => {
    const [result] = await resultsSentBack(async () => 'found');

    expect({result, hasKey: Object.hasOwn(result ?? {}, 'isError')}).toEqual({
      result: {type: 'tool_result', toolUseId: 'c1', content: 'found'},
      hasKey: false,
    });
  });

  it('marks a schema rejection as an error: lookup called without its required id', async () => {
    expect(await isErrorOf(async () => 'never', {input: {}})).toEqual([true]);
  });

  it('marks the answer to an unknown tool name as an error: lookpu, a name the model invented', async () => {
    expect(await isErrorOf(async () => 'never', {name: 'lookpu'})).toEqual([true]);
  });

  it('marks the deadline substitution as an error: lookup never answering within toolTimeoutMs 5', async () => {
    expect(await isErrorOf(() => new Promise(() => undefined), {options: {toolTimeoutMs: 5}})).toEqual([true]);
  });

  it('marks a declined call as an error: a beforeToolCall policy that throws', async () => {
    const beforeToolCall = async () => {
      throw new Error('policy store down');
    };

    expect(await isErrorOf(async () => 'never', {options: {hooks: {beforeToolCall}}})).toEqual([true]);
  });

  it('marks a caught executor throw as an error: lookup rejecting with ECONNREFUSED', async () => {
    expect(
      await isErrorOf(async () => {
        throw new Error('ECONNREFUSED');
      })
    ).toEqual([true]);
  });
});
