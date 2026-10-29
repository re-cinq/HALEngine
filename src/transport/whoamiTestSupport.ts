import {createChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import type {ChatOrchestrator, OrchestratorHooks} from '../orchestration/chatOrchestrator.js';
import {ToolRegistry} from '../orchestration/tools/registry.js';
import type {ToolContext} from '../orchestration/tools/registry.js';
import {PromptBuilder} from '../infrastructure/builders/promptBuilder.js';
import type {AIProvider, MessageChunk} from '../types/ai.js';

// Shared by the suites that check what a tool is handed, over a socket and over the REST routes.

/** A real orchestrator whose turn runs one whoami call, beside every context whoami has been handed so far. */
export function whoamiOrchestrator(hooks?: OrchestratorHooks): {
  orchestrator: ChatOrchestrator;
  contexts: ToolContext[];
} {
  const contexts: ToolContext[] = [];
  const registry = new ToolRegistry();
  registry.register(
    {name: 'whoami', description: 'Says who asks.', inputSchema: {type: 'object'}},
    async (_, context) => {
      if (context) contexts.push(context);
      return 'known';
    }
  );
  const orchestrator = createChatOrchestrator(askingForWhoami(), new PromptBuilder({identity: 'Whoami.'}), registry, {
    hooks,
  });
  return {orchestrator, contexts};
}

// The first provider call asks for whoami and every later one answers, so a turn runs the tool exactly once.
function askingForWhoami(): AIProvider {
  let calls = 0;
  const rounds: MessageChunk[][] = [
    [
      {type: 'tool_use', toolCall: {id: 'c1', name: 'whoami', input: {}}},
      {type: 'stop', stopReason: 'tool_use'},
    ],
    [
      {type: 'text', text: 'done'},
      {type: 'stop', stopReason: 'end_turn'},
    ],
  ];
  return {
    async *sendMessage(): AsyncGenerator<MessageChunk> {
      yield* rounds[Math.min(calls++, 1)];
    },
    generateStructured: async <T>() => ({}) as T,
  };
}
