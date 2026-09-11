import type {AIProvider, MessageChunk, SendMessageParams, StructuredOutputParams} from '../../types/ai.js';

export interface AnthropicConfig {
  type: 'anthropic';
  apiKey: string;
  model: string;
  maxTokens?: number;
}

// Stub: every method throws. Finishing it - docs/implementing-a-provider.md.
export function createAnthropicProvider(_config: AnthropicConfig): AIProvider {
  return {
    // eslint-disable-next-line require-yield
    async *sendMessage(_params: SendMessageParams): AsyncGenerator<MessageChunk> {
      throw new Error(
        'Anthropic provider is not yet implemented. ' +
          'Install @anthropic-ai/sdk and implement the streaming logic. ' +
          'See src/providers/bedrock/ for a reference implementation.'
      );
    },

    async generateStructured<T>(_params: StructuredOutputParams<T>): Promise<T> {
      throw new Error(
        'Anthropic provider is not yet implemented. ' +
          'Install @anthropic-ai/sdk and implement structured output. ' +
          'See src/providers/vertex/ for a reference implementation.'
      );
    },
  };
}
