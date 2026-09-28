import {createChatOrchestrator} from './chatOrchestrator.js';
import {ToolRegistry} from './tools/registry.js';
import {PromptBuilder} from '../infrastructure/builders/promptBuilder.js';
import {setLogger} from '../shared/logger.js';
import type {AIProvider, MessageChunk} from '../types/ai.js';
import type {ChatSession} from '../types/session.js';

// Counts are the contract: how many provider calls a turn makes, and how many tool rounds it actually executes.

const ASK_FOR_TOOL: MessageChunk[] = [
  {type: 'tool_use', toolCall: {id: 'c', name: 'lookup', input: {}}},
  {type: 'stop', stopReason: 'tool_use'},
];
const FINISH: MessageChunk[] = [
  {type: 'text', text: 'Done.'},
  {type: 'stop', stopReason: 'end_turn'},
];
const alwaysTools = (): MessageChunk[] => ASK_FOR_TOOL;
const toolThenFinish = (call: number): MessageChunk[] => (call === 0 ? ASK_FOR_TOOL : FINISH);

const budgetRun = async (maxToolRounds?: number, script: (call: number) => MessageChunk[] = alwaysTools) => {
  const counts = {providerCalls: 0, executions: 0};
  const provider: AIProvider = {
    async *sendMessage() {
      yield* script(counts.providerCalls++);
    },
    async generateStructured<T>(): Promise<T> {
      return {} as T;
    },
  };
  const registry = new ToolRegistry();
  registry.register({name: 'lookup', description: 'Looks something up.', inputSchema: {type: 'object'}}, async () => {
    counts.executions++;
    return 'found';
  });
  const options = maxToolRounds === undefined ? {} : {maxToolRounds};
  const orchestrator = createChatOrchestrator(
    provider,
    new PromptBuilder({identity: 'Budget test.'}),
    registry,
    options
  );
  const session: ChatSession = {sessionId: 's', userId: 'u', entries: [{role: 'user', content: 'go', timestamp: 't'}]};

  const chunks: MessageChunk[] = [];
  for await (const chunk of orchestrator.processMessageStream(session)) chunks.push(chunk);
  return {...counts, chunks};
};

// A hang fails in this long instead of stalling the suite; its tests stay on one line so a spec citation can name them.
const FAIL_FAST_MS = 2_000;

describe('the tool budget', () => {
  const warnings: Array<{category: string; message: string; fields?: Record<string, unknown>}> = [];

  beforeEach(() => {
    warnings.length = 0;
    const quiet = () => undefined;
    setLogger({
      debug: quiet,
      info: quiet,
      error: quiet,
      warn: (category, message, fields) => void warnings.push({category, message, fields}),
    });
  });

  afterEach(() => setLogger());

  it('executes 2 tool rounds and makes 3 provider calls at maxToolRounds 2', async () => {
    const {providerCalls, executions} = await budgetRun(2);

    expect({providerCalls, executions}).toEqual({providerCalls: 3, executions: 2});
  });

  it('executes 5 tool rounds and makes 6 provider calls at the default budget', async () => {
    const {providerCalls, executions} = await budgetRun();

    expect({providerCalls, executions}).toEqual({providerCalls: 6, executions: 5});
  });

  it('makes one provider call and executes no tool at maxToolRounds 0', async () => {
    const {providerCalls, executions} = await budgetRun(0);

    expect({providerCalls, executions}).toEqual({providerCalls: 1, executions: 0});
  });

  // prettier-ignore
  it('treats a negative budget as 0 and still terminates', async () => {
    const {providerCalls, executions} = await budgetRun(-3);

    expect({providerCalls, executions}).toEqual({providerCalls: 1, executions: 0});
  }, FAIL_FAST_MS);

  // prettier-ignore
  it('treats a NaN budget as the default and still terminates', async () => {
    const {providerCalls, executions} = await budgetRun(Number.NaN);

    expect({providerCalls, executions}).toEqual({providerCalls: 6, executions: 5});
  }, FAIL_FAST_MS);

  it('leaves a conversation that ends on its own unchanged, at the default and at 5', async () => {
    const atDefault = await budgetRun(undefined, toolThenFinish);
    const atFive = await budgetRun(5, toolThenFinish);

    expect([atDefault, atFive].map(({providerCalls, executions}) => ({providerCalls, executions}))).toEqual([
      {providerCalls: 2, executions: 1},
      {providerCalls: 2, executions: 1},
    ]);
  });

  it('warns once, under orchestrator, with the budget and the tools it did not run', async () => {
    await budgetRun(2);

    expect(warnings).toEqual([
      {
        category: 'orchestrator',
        message: 'tool budget exhausted',
        fields: {maxToolRounds: 2, requestedTools: ['lookup']},
      },
    ]);
  });

  it('yields exactly the chunks it did before for an exhausted run, with nothing added', async () => {
    const {chunks} = await budgetRun(2);

    expect(chunks).toEqual([...ASK_FOR_TOOL, ...ASK_FOR_TOOL, ...ASK_FOR_TOOL]);
  });

  it('never runs a tool whose result nobody reads: one execution at maxToolRounds 1', async () => {
    const {executions} = await budgetRun(1);

    expect(executions).toBe(1);
  });
});
