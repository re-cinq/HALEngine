import type {ConverseStreamOutput} from '@aws-sdk/client-bedrock-runtime';
import {createRequire} from 'node:module';
import {AIError} from '../../types/ai.js';
import type {AIProvider, MessageChunk, SendMessageParams, StructuredOutputParams} from '../../types/ai.js';
import {
  emptyToolAccumulator,
  handleTextDelta,
  handleToolStart,
  handleToolInputDelta,
  handleContentBlockStop,
  handleMessageStop,
} from './bedrockStreamHandlers.js';
import {mapBedrockError} from './bedrockErrorMap.js';
import {mapMessage, mapToolConfig} from './bedrockMessageMapper.js';
import {log} from '../../shared/logger.js';

export interface BedrockConfig {
  type: 'bedrock';
  modelId: string;
  region: string;
  maxTokens: number;
}

export function createBedrockProvider(config: BedrockConfig): AIProvider {
  const {BedrockRuntimeClient, ConverseStreamCommand} = createRequire(import.meta.url)(
    '@aws-sdk/client-bedrock-runtime'
  ) as typeof import('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({region: config.region});

  return {
    async generateStructured<T>(_params: StructuredOutputParams<T>): Promise<T> {
      throw new Error('Bedrock structured output is not yet implemented.');
    },

    async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
      const {messages, systemPrompt, tools, maxTokens} = params;

      log.info('bedrock', 'sending message', {
        modelId: config.modelId,
        messageCount: messages.length,
        hasTools: !!tools,
      });

      try {
        const command = new ConverseStreamCommand({
          modelId: config.modelId,
          system: [{text: systemPrompt}],
          messages: messages.map(mapMessage),
          inferenceConfig: {maxTokens: maxTokens ?? config.maxTokens},
          ...(tools && {toolConfig: mapToolConfig(tools)}),
        });

        const response = await client.send(command);

        if (response.stream) {
          log.info('bedrock', 'stream started');
          yield* parseStreamEvents(response.stream);
        }
      } catch (error) {
        log.error('bedrock', 'error', {error: error instanceof Error ? error.message : 'Unknown'});
        if (error instanceof AIError) throw error;
        throw mapBedrockError(error);
      }
    },
  };
}

async function* parseStreamEvents(stream: AsyncIterable<ConverseStreamOutput>): AsyncGenerator<MessageChunk> {
  let acc = emptyToolAccumulator();

  for await (const event of stream) {
    const text = handleTextDelta(event);
    if (text) yield text;

    acc = handleToolStart(event, acc);
    acc = handleToolInputDelta(event, acc);

    const [nextAcc, toolChunk] = handleContentBlockStop(event, acc);
    acc = nextAcc;
    if (toolChunk) yield toolChunk;

    const stop = handleMessageStop(event);
    if (stop) yield stop;
  }
}
