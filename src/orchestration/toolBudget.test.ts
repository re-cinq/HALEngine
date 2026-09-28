import {createChatOrchestrator, TOOL_BUDGET_EXHAUSTED} from './chatOrchestrator.js';
import type {OrchestratorHooks, ToolBudgetInfo} from './chatOrchestrator.js';
import {ToolRegistry} from './tools/registry.js';
import {PromptBuilder} from '../infrastructure/builders/promptBuilder.js';
import {setLogger} from '../shared/logger.js';
import type {AIProvider, MessageChunk, UsageMetadata} from '../types/ai.js';
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

const budgetEngine = (
  maxToolRounds?: number,
  script: (call: number) => MessageChunk[] = alwaysTools,
  hooks: OrchestratorHooks = {}
) => {
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
  const options = maxToolRounds === undefined ? {hooks} : {maxToolRounds, hooks};
  const orchestrator = createChatOrchestrator(
    provider,
    new PromptBuilder({identity: 'Budget test.'}),
    registry,
    options
  );
  const session: ChatSession = {sessionId: 's', userId: 'u', entries: [{role: 'user', content: 'go', timestamp: 't'}]};
  return {orchestrator, counts, session};
};

const budgetRun = async (...args: Parameters<typeof budgetEngine>) => {
  const {orchestrator, counts, session} = budgetEngine(...args);
  const chunks: MessageChunk[] = [];
  for await (const chunk of orchestrator.processMessageStream(session)) chunks.push(chunk);
  return {...counts, chunks};
};

const BUDGET_STOP: MessageChunk = {type: 'stop', stopReason: TOOL_BUDGET_EXHAUSTED};
const SENTENCE = 'I could not finish looking that up, so a colleague will follow up.';
const USAGE: UsageMetadata = {inputTokens: 7, outputTokens: 3, totalTokens: 10};
const twoTools = (): MessageChunk[] => [
  {type: 'tool_use', toolCall: {id: 'c1', name: 'lookup', input: {}}},
  {type: 'tool_use', toolCall: {id: 'c2', name: 'notify', input: {}}},
  {type: 'stop', stopReason: 'tool_use'},
];
const toolsWithUsage = (): MessageChunk[] => [ASK_FOR_TOOL[0], {type: 'stop', stopReason: 'tool_use', usage: USAGE}];
const saysThenAsks = (): MessageChunk[] => [{type: 'text', text: 'Checking. '}, ...ASK_FOR_TOOL];

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

  it('ends an exhausted run with one synthetic stop and nothing else when no hook is installed', async () => {
    const {chunks} = await budgetRun(2);

    expect(chunks).toEqual([...ASK_FOR_TOOL, ...ASK_FOR_TOOL, ...ASK_FOR_TOOL, BUDGET_STOP]);
  });

  it('never runs a tool whose result nobody reads: one execution at maxToolRounds 1', async () => {
    const {executions} = await budgetRun(1);

    expect(executions).toBe(1);
  });
});

describe('the onToolBudgetExhausted hook', () => {
  beforeEach(() => {
    const quiet = () => undefined;
    setLogger({debug: quiet, info: quiet, warn: quiet, error: quiet});
  });

  afterEach(() => setLogger());

  const recording = (answer: string | undefined) => {
    const seen: ToolBudgetInfo[] = [];
    const hook = async (_session: ChatSession, budget: ToolBudgetInfo) => {
      seen.push(budget);
      return answer;
    };
    return {seen, hooks: {onToolBudgetExhausted: hook}};
  };

  it("fires once with the budget and the refused round's tools at maxToolRounds 2", async () => {
    const {seen, hooks} = recording(SENTENCE);

    await budgetRun(2, alwaysTools, hooks);

    expect(seen).toEqual([{maxToolRounds: 2, requestedTools: ['lookup']}]);
  });

  it('never fires for a conversation that ends on its own, at the default and at 5', async () => {
    const {seen, hooks} = recording(SENTENCE);

    await budgetRun(undefined, toolThenFinish, hooks);
    await budgetRun(5, toolThenFinish, hooks);

    expect(seen).toEqual([]);
  });

  it("fires once at maxToolRounds 0 with the single provider call's requested tools", async () => {
    const {seen, hooks} = recording(SENTENCE);

    await budgetRun(0, twoTools, hooks);

    expect(seen).toEqual([{maxToolRounds: 0, requestedTools: ['lookup', 'notify']}]);
  });

  it("ends the run on the hook's sentence as a text chunk, then the synthetic stop", async () => {
    const {chunks} = await budgetRun(2, alwaysTools, recording(SENTENCE).hooks);

    expect(chunks.slice(-2)).toEqual([{type: 'text', text: SENTENCE}, BUDGET_STOP]);
  });

  it('yields only the synthetic stop when the hook returns undefined or an empty string', async () => {
    const silent = await budgetRun(2, alwaysTools, recording(undefined).hooks);
    const empty = await budgetRun(2, alwaysTools, recording('').hooks);

    expect([silent.chunks.slice(-2), empty.chunks.slice(-2)]).toEqual([
      [{type: 'stop', stopReason: 'tool_use'}, BUDGET_STOP],
      [{type: 'stop', stopReason: 'tool_use'}, BUDGET_STOP],
    ]);
  });

  it('hands afterModelResponse text ending in the sentence, and the usage of a run without the hook', async () => {
    const reports: Array<{text: string; usage?: UsageMetadata}> = [];
    const afterModelResponse = async (_session: ChatSession, text: string, usage?: UsageMetadata) =>
      void reports.push({text, usage});

    await budgetRun(1, toolsWithUsage, {afterModelResponse});
    await budgetRun(1, toolsWithUsage, {...recording(SENTENCE).hooks, afterModelResponse});

    const [withoutHook, withHook] = reports;
    expect({endsInSentence: withHook.text.endsWith(SENTENCE), sameUsage: withHook.usage}).toEqual({
      endsInSentence: true,
      sameUsage: withoutHook.usage,
    });
  });

  it("returns the model's text with the sentence appended from processMessage", async () => {
    const {orchestrator, session} = budgetEngine(1, saysThenAsks, recording(SENTENCE).hooks);

    const text = await orchestrator.processMessage(session);

    expect(text).toBe(`Checking. Checking. ${SENTENCE}`);
  });
});
