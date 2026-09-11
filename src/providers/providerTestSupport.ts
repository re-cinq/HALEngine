import type {MessageChunk, SendMessageParams} from '../types/ai.js';

// Shared by the provider suites, which all drive the same AIProvider interface.
/** Drains an AIProvider stream so a test can assert on the chunks as a value. */
export async function collectChunks(stream: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

/** One user turn with a fixed system prompt - the smallest valid request. */
export function userMessage(content: string): SendMessageParams {
  return {
    messages: [{role: 'user', content}],
    systemPrompt: 'You are helpful.',
  };
}
