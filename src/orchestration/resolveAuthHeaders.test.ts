import {describe, it, expect, jest} from '@jest/globals';
import {createChatOrchestrator} from './chatOrchestrator.js';
import {ToolRegistry} from './tools/registry.js';
import {scriptedProvider} from './scriptedProviderTestSupport.js';
import {PromptBuilder} from '../infrastructure/builders/promptBuilder.js';
import type {ChatSession} from '../types/session.js';
import type {MessageChunk} from '../types/ai.js';

const toolUse = (id: string): MessageChunk => ({
  type: 'tool_use',
  toolCall: {id, name: 'lookup', input: {}},
});
const WANTS_TOOLS: MessageChunk = {type: 'stop', stopReason: 'tool_use'};
const END_TURN: MessageChunk = {type: 'stop', stopReason: 'end_turn'};

function baseSession(): ChatSession {
  return {
    sessionId: 's1',
    userId: 'u1',
    entries: [{role: 'user', content: 'go', timestamp: 't'}],
    authHeaders: {authorization: 'Bearer original'},
  };
}

function lookupRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({name: 'lookup', description: 'Looks up.', inputSchema: {type: 'object'}}, async () => 'ok');
  return r;
}

describe('resolveAuthHeaders hook', () => {
  it('is called exactly once for a round with two parallel tool calls ([validated by specs/hal-engine-architecture/spec.md#L541])', async () => {
    const hook = jest
      .fn<(session: ChatSession) => Promise<ChatSession['authHeaders']>>()
      .mockResolvedValue({authorization: 'Bearer new'});
    const provider = scriptedProvider([toolUse('c1'), toolUse('c2'), WANTS_TOOLS], [END_TURN]);
    const orchestrator = createChatOrchestrator(provider, new PromptBuilder({identity: 'Test.'}), lookupRegistry(), {
      hooks: {resolveAuthHeaders: hook},
    });
    await orchestrator.processMessage(baseSession());
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
