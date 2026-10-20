import {createChatOrchestrator} from './chatOrchestrator.js';
import type {OrchestratorHooks} from './chatOrchestrator.js';
import {ToolRegistry} from './tools/registry.js';
import type {ToolContext, ToolExecutor} from './tools/registry.js';
import {PromptBuilder} from '../infrastructure/builders/promptBuilder.js';
import type {MessageChunk} from '../types/ai.js';
import type {ChatSession} from '../types/session.js';
import {scriptedProvider} from './scriptedProviderTestSupport.js';

const UPGRADE = {authorization: 'Bearer from-the-upgrade'};
const TOOL_STOP: MessageChunk = {type: 'stop', stopReason: 'tool_use'};
const STOP: MessageChunk = {type: 'stop', stopReason: 'end_turn'};
const lookup = (id: string, input: Record<string, unknown> = {}): MessageChunk => ({
  type: 'tool_use',
  toolCall: {id, name: 'lookup', input},
});

interface Turn {
  session: ChatSession;
  seen: Array<ToolContext['authHeaders']>;
}

// One turn on a session holding the upgrade's headers; unless given an executor, lookup records the headers it was handed.
async function turn(
  rounds: MessageChunk[][],
  {hooks, executor, signal}: {hooks?: OrchestratorHooks; executor?: ToolExecutor; signal?: AbortSignal} = {}
): Promise<Turn> {
  const seen: Turn['seen'] = [];
  const recording: ToolExecutor = async (_, context) => {
    seen.push(context?.authHeaders);
    return 'found';
  };
  const registry = new ToolRegistry();
  registry.register(
    {name: 'lookup', description: 'Looks it up.', inputSchema: {type: 'object'}},
    executor ?? recording
  );
  const session: ChatSession = {
    sessionId: 's1',
    userId: 'u1',
    authHeaders: {...UPGRADE},
    entries: [{role: 'user', content: 'go', timestamp: 't'}],
  };
  const orchestrator = createChatOrchestrator(
    scriptedProvider(...rounds),
    new PromptBuilder({identity: 'Renewal.'}),
    registry,
    {
      hooks,
    }
  );
  const chunks: MessageChunk[] = [];
  for await (const chunk of orchestrator.processMessageStream(session, {signal})) chunks.push(chunk);
  return {session, seen};
}

describe('resolveAuthHeaders', () => {
  it("hands round 0's call Bearer round-0 and round 1's call Bearer round-1 when the hook answers each round anew", async () => {
    let resolved = 0;
    const resolveAuthHeaders = async () => ({authorization: `Bearer round-${resolved++}`});

    const {seen} = await turn([[lookup('c1'), TOOL_STOP], [lookup('c2'), TOOL_STOP], [STOP]], {
      hooks: {resolveAuthHeaders},
    });

    expect(seen).toEqual([{authorization: 'Bearer round-0'}, {authorization: 'Bearer round-1'}]);
  });

  it('is called once for a round of two tool calls and never for a turn with no tool call', async () => {
    const calls = {twoCalls: 0, noCall: 0};

    await turn([[lookup('c1'), lookup('c2'), TOOL_STOP], [STOP]], {
      hooks: {resolveAuthHeaders: async () => (calls.twoCalls++, UPGRADE)},
    });
    await turn([[STOP]], {hooks: {resolveAuthHeaders: async () => (calls.noCall++, UPGRADE)}});

    expect(calls).toEqual({twoCalls: 1, noCall: 0});
  });

  it("hands a tool the upgrade's headers when no resolveAuthHeaders is configured", async () => {
    const {seen} = await turn([[lookup('c1'), TOOL_STOP], [STOP]]);

    expect(seen).toEqual([UPGRADE]);
  });

  it("leaves session.authHeaders equal to the upgrade's after a run whose hook resolved Bearer renewed", async () => {
    const {session, seen} = await turn([[lookup('c1'), TOOL_STOP], [STOP]], {
      hooks: {resolveAuthHeaders: async () => ({authorization: 'Bearer renewed'})},
    });

    expect({session: session.authHeaders, seen}).toEqual({session: UPGRADE, seen: [{authorization: 'Bearer renewed'}]});
  });

  it('keeps a header one call rewrote out of session.authHeaders and out of the next call in the same round', async () => {
    const seen: Array<string | undefined> = [];
    const rewriteOrRead: ToolExecutor = async (input, context) => {
      if (input.rewrite)
        return Object.assign(context?.authHeaders ?? {}, {authorization: 'Bearer forged'}) && 'rewrote';
      // A macrotask later, so the sibling has certainly rewritten before this one reads.
      await new Promise(resolve => setImmediate(resolve));
      seen.push(context?.authHeaders?.authorization);
      return 'read';
    };

    const {session} = await turn([[lookup('c1', {rewrite: true}), lookup('c2'), TOOL_STOP], [STOP]], {
      executor: rewriteOrRead,
    });

    expect({session: session.authHeaders, sibling: seen}).toEqual({session: UPGRADE, sibling: [UPGRADE.authorization]});
  });

  it('runs no tool, and ends without an error, when the turn is abandoned while resolveAuthHeaders runs', async () => {
    const controller = new AbortController();
    const resolveAuthHeaders = async () => (controller.abort(), UPGRADE);

    const {seen} = await turn([[lookup('c1'), TOOL_STOP], [STOP]], {
      hooks: {resolveAuthHeaders},
      signal: controller.signal,
    });

    expect(seen).toEqual([]);
  });
});
