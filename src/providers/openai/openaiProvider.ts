import type {AIProvider, MessageChunk, SendMessageParams, StructuredOutputParams} from '../../types/ai.js';

export interface OpenAIConfig {
  type: 'openai';
  apiKey: string;
  model: string;
  maxTokens?: number;
}

// Stub: every method throws. Finishing it - docs/implementing-a-provider.md.
export function createOpenAIProvider(_config: OpenAIConfig): AIProvider {
  return {
    // eslint-disable-next-line require-yield
    async *sendMessage(_params: SendMessageParams): AsyncGenerator<MessageChunk> {
      throw new Error(
        'OpenAI provider is not yet implemented. ' +
          'Install openai and implement the streaming logic. ' +
          'See src/providers/bedrock/ for a reference implementation.'
      );
    },

    async generateStructured<T>(_params: StructuredOutputParams<T>): Promise<T> {
      throw new Error(
        'OpenAI provider is not yet implemented. ' +
          'Install openai and implement structured output. ' +
          'See src/providers/vertex/ for a reference implementation.'
      );
    },
  };
}
