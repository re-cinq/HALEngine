import type {AIProvider, MessageChunk} from '../types/ai.js';

// Shared by the orchestrator suites that script a provider round by round.

/** A provider answering each call with the next round, the last one repeating. */
export function scriptedProvider(...rounds: MessageChunk[][]): AIProvider {
  let call = 0;
  return {
    async *sendMessage(): AsyncGenerator<MessageChunk> {
      yield* rounds[Math.min(call++, rounds.length - 1)];
    },
    generateStructured: async <T>() => ({}) as T,
  };
}
