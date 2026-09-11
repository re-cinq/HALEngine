import type {AIProvider} from '../types/ai.js';
import {createBedrockProvider} from './bedrock/index.js';
import type {BedrockConfig} from './bedrock/index.js';
import {createVertexProvider} from './vertex/index.js';
import type {VertexConfig} from './vertex/index.js';
import {createOpenAIProvider} from './openai/index.js';
import type {OpenAIConfig} from './openai/index.js';
import {createAnthropicProvider} from './anthropic/index.js';
import type {AnthropicConfig} from './anthropic/index.js';
import {createMockProvider} from './mock/index.js';
import type {MockConfig} from './mock/index.js';

export type ProviderType = 'bedrock' | 'vertex' | 'openai' | 'anthropic' | 'mock';

export type ProviderConfig = BedrockConfig | VertexConfig | OpenAIConfig | AnthropicConfig | MockConfig;

export function createProvider(config: ProviderConfig): AIProvider {
  // eslint-disable-next-line re-lint/prefer-polymorphism -- the switch narrows a discriminated union onto five differently-typed factories (adrs/ADR-006-lint-suppressions.md)
  switch (config.type) {
    case 'bedrock':
      return createBedrockProvider(config);
    case 'vertex':
      return createVertexProvider(config);
    case 'openai':
      return createOpenAIProvider(config);
    case 'anthropic':
      return createAnthropicProvider(config);
    case 'mock':
      return createMockProvider(config);
  }
}
