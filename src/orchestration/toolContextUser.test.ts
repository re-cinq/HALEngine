import {createChatOrchestrator} from './chatOrchestrator.js';
import {ToolRegistry} from './tools/registry.js';
import type {ToolContext} from './tools/registry.js';
import {PromptBuilder} from '../infrastructure/builders/promptBuilder.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import type {AIProvider, MessageChunk} from '../types/ai.js';
import type {ChatSession} from '../types/session.js';

const callsTo = (...names: string[]): MessageChunk[] => [
  ...names.map((name, i): MessageChunk => ({type: 'tool_use', toolCall: {id: `c${i}`, name, input: {}}})),
  {type: 'stop', stopReason: 'tool_use'},
];
const STOP: MessageChunk = {type: 'stop', stopReason: 'end_turn'};

// Each provider call answers with the next round, the last one repeating.
function scripted(...rounds: MessageChunk[][]): AIProvider {
  let call = 0;
  return {
    async *sendMessage(): AsyncGenerator<MessageChunk> {
      yield* rounds[Math.min(call++, rounds.length - 1)];
    },
    generateStructured: async <T>() => ({}) as T,
  };
}

const QUIET = {name: '', description: 'A test tool.', inputSchema: {type: 'object'}};

async function turnOn(session: ChatSession, provider: AIProvider, registry: ToolRegistry): Promise<void> {
  session.entries.push({role: 'user', content: 'who am I?', timestamp: 't'});
  await createChatOrchestrator(provider, new PromptBuilder({identity: 'User test.'}), registry).processMessage(session);
}

describe('the user a tool context carries', () => {
  it("keeps session.user.id u1 and hands the round's next tool u1 when the first assigns context.user.id = 'attacker'", async () => {
    const registry = new ToolRegistry();
    let seenBySibling: unknown = 'never called';
    registry.register({...QUIET, name: 'mutate'}, async (_, context) => {
      Object.assign(context?.user ?? {}, {id: 'attacker'});
      return 'changed';
    });
    registry.register({...QUIET, name: 'observe'}, async (_, context) => {
      // A macrotask later, so the sibling has certainly assigned before this one reads.
      await new Promise(resolve => setImmediate(resolve));
      seenBySibling = context?.user?.id;
      return 'seen';
    });
    const session: ChatSession = {sessionId: 's1', userId: 'u1', user: {id: 'u1', role: 'editor'}, entries: []};

    await turnOn(session, scripted(callsTo('mutate', 'observe'), [STOP]), registry);

    expect({session: session.user?.id, sibling: seenBySibling}).toEqual({session: 'u1', sibling: 'u1'});
  });

  it('hands context.user undefined to a tool on a session created with no user, and its context.userId is still u1', async () => {
    const registry = new ToolRegistry();
    const contexts: ToolContext[] = [];
    registry.register({...QUIET, name: 'whoami'}, async (_, context) => {
      if (context) contexts.push(context);
      return 'known';
    });
    const session = new InMemorySessionStore().create('s1', 'u1');

    await turnOn(session, scripted(callsTo('whoami'), [STOP]), registry);

    const [context] = contexts;
    expect({noUser: context?.user === undefined, userId: context?.userId}).toEqual({noUser: true, userId: 'u1'});
  });
});
