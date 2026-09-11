import type {AIProvider, MessageChunk, SendMessageParams, StructuredOutputParams} from '../../types/ai.js';

export interface MockConfig {
  type: 'mock';
  structuredResponses?: Map<string, unknown>;
}

export function createMockProvider(config?: MockConfig): AIProvider {
  const structuredResponses = config?.structuredResponses ?? new Map<string, unknown>();

  return {
    async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
      const lastMessage = params.messages[params.messages.length - 1];
      const userText = typeof lastMessage?.content === 'string' ? lastMessage.content : 'Hello';

      const response = `Mock response to: "${userText}"`;

      for (const word of response.split(' ')) {
        yield {type: 'text', text: word + ' '};
      }

      yield {type: 'stop', stopReason: 'end_turn', usage: {inputTokens: 10, outputTokens: 20, totalTokens: 30}};
    },

    async generateStructured<T>(params: StructuredOutputParams<T>): Promise<T> {
      const lastMessage = params.messages[params.messages.length - 1];
      const userText = typeof lastMessage?.content === 'string' ? lastMessage.content : '';

      const preconfigured = structuredResponses.get(userText);
      if (preconfigured !== undefined) return preconfigured as T;

      return buildDefaultResponse(params.responseSchema) as T;
    },
  };
}

// Factories, not values: `array` must hand back a fresh [] to each caller.
const SCALAR_DEFAULTS: Record<string, () => unknown> = {
  array: () => [],
  string: () => '',
  number: () => 0,
  boolean: () => false,
};

function buildDefaultResponse(schema: {type: string; properties?: Record<string, {type: string}>}): unknown {
  if (schema.type === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      result[key] = buildDefaultResponse(prop);
    }
    return result;
  }

  const scalar = SCALAR_DEFAULTS[schema.type];
  return scalar ? scalar() : null;
}
