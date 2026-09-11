import type {Message, MessageChunk, ToolCall, UsageMetadata} from '../types/ai.js';
import type {ToolRegistry} from './tools/registry.js';

export function shouldContinueToolLoop(
  stopReason: string,
  pendingToolCalls: ToolCall[],
  toolRegistry: ToolRegistry | undefined
): boolean {
  return stopReason === 'tool_use' && pendingToolCalls.length > 0 && toolRegistry !== undefined;
}

export async function collectText(stream: AsyncGenerator<MessageChunk>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text') text += chunk.text;
  }
  return text;
}

export function buildToolCallMessages(pendingToolCalls: ToolCall[]): Message {
  return {
    role: 'assistant',
    content: pendingToolCalls.map(tc => ({
      type: 'tool_use' as const,
      toolUseId: tc.id,
      name: tc.name,
      input: tc.input,
    })),
  };
}

export function collectToolCalls(chunk: MessageChunk, pendingToolCalls: ToolCall[]): void {
  if (chunk.type === 'tool_use') pendingToolCalls.push(chunk.toolCall);
}

export function extractStopReason(chunk: MessageChunk): string | null {
  return chunk.type === 'stop' ? chunk.stopReason : null;
}

export function extractUsage(chunk: MessageChunk): UsageMetadata | undefined {
  return chunk.type === 'stop' ? chunk.usage : undefined;
}
