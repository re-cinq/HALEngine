import type {AIProvider} from '../types/ai.js';
import type {BedrockConfig} from './bedrock/index.js';
import type {VertexConfig} from './vertex/index.js';
import type {OpenAIConfig} from './openai/index.js';
import type {AnthropicConfig} from './anthropic/index.js';
import type {MockConfig} from './mock/index.js';

export type ProviderType = 'bedrock' | 'vertex' | 'openai' | 'anthropic' | 'mock';

export type ProviderConfig = BedrockConfig | VertexConfig | OpenAIConfig | AnthropicConfig | MockConfig;

export function createProvider(config: ProviderConfig): AIProvider {
  // eslint-disable-next-line re-lint/prefer-polymorphism -- the arms lazy-require their SDK; a value table loads all five (adrs/ADR-006-lint-suppressions.md)
  switch (config.type) {
    case 'bedrock': {
      const {createBedrockProvider} = require('./bedrock/index.js') as typeof import('./bedrock/index.js');
      return createBedrockProvider(config);
    }
    case 'vertex': {
      const {createVertexProvider} = require('./vertex/index.js') as typeof import('./vertex/index.js');
      return createVertexProvider(config);
    }
    case 'openai': {
      const {createOpenAIProvider} = require('./openai/index.js') as typeof import('./openai/index.js');
      return createOpenAIProvider(config);
    }
    case 'anthropic': {
      const {createAnthropicProvider} = require('./anthropic/index.js') as typeof import('./anthropic/index.js');
      return createAnthropicProvider(config);
    }
    case 'mock': {
      const {createMockProvider} = require('./mock/index.js') as typeof import('./mock/index.js');
      return createMockProvider();
    }
  }
}
