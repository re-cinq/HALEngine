import {createMockProvider} from './providers/mock/index.js';
import {createChatOrchestrator} from './orchestration/chatOrchestrator.js';
import {ToolRegistry} from './orchestration/tools/registry.js';
import {PromptBuilder} from './infrastructure/builders/promptBuilder.js';
import type {AIProvider, MessageChunk, SendMessageParams} from './types/ai.js';

// A scripted mock through the real orchestrator: a tool round with no cloud account.

it("drives a tool round through createChatOrchestrator in two calls, the second carrying the echo tool's result", async () => {
  const sent: SendMessageParams[] = [];
  const mock = createMockProvider({
    type: 'mock',
    turns: [{toolCalls: [{id: 't1', name: 'echo', input: {q: 'hi'}}]}, {text: 'done'}],
    onSendMessage: params => void sent.push(structuredClone(params)),
  });
  const types: string[] = [];
  const tapped: AIProvider = {
    ...mock,
    async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
      for await (const chunk of mock.sendMessage(params)) {
        types.push(chunk.type);
        yield chunk;
      }
    },
  };
  const registry = new ToolRegistry();
  registry.register(
    {name: 'echo', description: 'Echoes its input.', inputSchema: {type: 'object'}},
    async input => `echoed ${String(input.q)}`
  );

  await createChatOrchestrator(tapped, new PromptBuilder({identity: 'Scripted mock.'}), registry).processMessage({
    sessionId: 's',
    userId: 'u',
    entries: [{role: 'user', content: 'go', timestamp: 't'}],
  });

  const [, second] = sent;
  expect({calls: sent.length, types, lastSent: second?.messages.at(-1)}).toEqual({
    calls: 2,
    types: ['tool_use', 'stop', 'text', 'stop'],
    lastSent: {role: 'user', content: [{type: 'tool_result', toolUseId: 't1', content: 'echoed hi'}]},
  });
});
