import {AIError} from '../../types/ai.js';
import {requireOptionalPeer} from '../requireOptionalPeer.js';
import type {AIProvider, MessageChunk, SendMessageParams, StructuredOutputParams} from '../../types/ai.js';
import {parseStreamEvents} from './bedrockStreamHandlers.js';
import {mapBedrockError} from './bedrockErrorMap.js';
import {mapMessage, mapToolConfig, supportsToolResultStatus} from './bedrockMessageMapper.js';
import {log} from '../../shared/logger.js';

export interface BedrockConfig {
  type: 'bedrock';
  modelId: string;
  region: string;
  maxTokens: number;
}

export function createBedrockProvider(config: BedrockConfig): AIProvider {
  const {BedrockRuntimeClient, ConverseStreamCommand} = requireOptionalPeer<
    typeof import('@aws-sdk/client-bedrock-runtime')
  >('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({region: config.region});
  const wire = {toolResultStatus: supportsToolResultStatus(config.modelId)};

  return {
    async generateStructured<T>(_params: StructuredOutputParams<T>): Promise<T> {
      throw new Error('Bedrock structured output is not yet implemented.');
    },

    async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
      const {messages, systemPrompt, tools, maxTokens, signal} = params;
      if (signal?.aborted) return;

      log.info('bedrock', 'sending message', {
        modelId: config.modelId,
        messageCount: messages.length,
        hasTools: !!tools,
      });

      try {
        const command = new ConverseStreamCommand({
          modelId: config.modelId,
          system: [{text: systemPrompt}],
          messages: messages.map(message => mapMessage(message, wire)),
          inferenceConfig: {maxTokens: maxTokens ?? config.maxTokens},
          ...(tools && {toolConfig: mapToolConfig(tools)}),
        });

        // Without a signal, send gets the command alone, exactly as before the signal existed.
        const response = await (signal ? client.send(command, {abortSignal: signal}) : client.send(command));

        if (response.stream) {
          log.info('bedrock', 'stream started');
          yield* parseStreamEvents(response.stream, signal);
        }
      } catch (error) {
        // An abort is the engine's own decision, not a vendor failure, so it ends the stream instead of raising.
        if (signal?.aborted) {
          log.info('bedrock', 'request aborted');
          return;
        }
        log.error('bedrock', 'error', {error: error instanceof Error ? error.message : 'Unknown'});
        if (error instanceof AIError) throw error;
        throw mapBedrockError(error);
      }
    },
  };
}
