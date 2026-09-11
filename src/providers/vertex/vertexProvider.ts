import {VertexAI, SchemaType} from '@google-cloud/vertexai';
import type {
  Content,
  GenerateContentRequest,
  GenerateContentResponse,
  FunctionCallPart,
  FunctionDeclarationSchema,
  Part,
} from '@google-cloud/vertexai';
import {AIError} from '../../types/ai.js';
import type {
  AIProvider,
  Message,
  MessageChunk,
  SendMessageParams,
  StructuredOutputParams,
  ResponseSchema,
  UsageMetadata,
} from '../../types/ai.js';
import {log} from '../../shared/logger.js';

export interface VertexConfig {
  type: 'vertex';
  projectId: string;
  location: string;
  modelId: string;
  maxTokens?: number;
  googleAuthOptions?: Record<string, unknown>;
}
export function createVertexProvider(config: VertexConfig): AIProvider {
  const vertexAI = new VertexAI({
    project: config.projectId,
    location: config.location,
    googleAuthOptions: config.googleAuthOptions,
  });

  const model = vertexAI.getGenerativeModel({
    model: config.modelId,
    generationConfig: {maxOutputTokens: config.maxTokens},
  });

  return {
    async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
      log.info('vertex', 'sending message', {
        modelId: config.modelId,
        messageCount: params.messages.length,
        hasTools: !!params.tools,
      });

      try {
        const request = buildRequest(params);
        if (params.maxTokens) {
          request.generationConfig = {maxOutputTokens: params.maxTokens};
        }

        const streamResult = await model.generateContentStream(request);

        for await (const chunk of streamResult.stream) {
          const candidate = chunk.candidates?.[0];
          if (!candidate?.content?.parts) continue;

          yield* partChunks(candidate.content.parts);

          const finishReason = candidate.finishReason;
          if (finishReason) {
            const stopReason =
              finishReason === 'STOP'
                ? 'end_turn'
                : finishReason === 'MAX_TOKENS'
                  ? 'max_tokens'
                  : finishReason.toLowerCase();
            yield {type: 'stop', stopReason, usage: extractUsage(chunk)};
          }
        }
      } catch (error) {
        log.error('vertex', 'stream error', {error: error instanceof Error ? error.message : 'Unknown'});
        throw mapVertexError(error);
      }
    },

    async generateStructured<T>(params: StructuredOutputParams<T>): Promise<T> {
      log.info('vertex', 'generating structured output', {
        modelId: config.modelId,
        messageCount: params.messages.length,
      });

      try {
        const structuredModel = vertexAI.getGenerativeModel({
          model: config.modelId,
          generationConfig: {
            maxOutputTokens: params.maxTokens ?? config.maxTokens,
            responseMimeType: 'application/json',
            responseSchema: mapResponseSchema(params.responseSchema),
          },
        });

        const request: GenerateContentRequest = {
          contents: params.messages.map(mapMessage),
          systemInstruction: {role: 'user', parts: [{text: params.systemPrompt}]},
        };

        const result = await structuredModel.generateContent(request);
        const text = extractText(result.response);

        return JSON.parse(text) as T;
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new AIError('Failed to parse structured response as JSON', 'PARSE_ERROR');
        }
        log.error('vertex', 'structured output error', {error: error instanceof Error ? error.message : 'Unknown'});
        throw mapVertexError(error);
      }
    },
  };
}

// A part can carry text and a function call at once, so it maps to 0, 1 or 2 chunks.
function* partChunks(parts: Part[]): Generator<MessageChunk> {
  for (const part of parts) {
    if ('text' in part && part.text) {
      yield {type: 'text', text: part.text};
    }

    if ('functionCall' in part) {
      const fc = (part as FunctionCallPart).functionCall;
      yield {
        type: 'tool_use',
        toolCall: {
          id: fc.name,
          name: fc.name,
          input: (fc.args ?? {}) as Record<string, unknown>,
        },
      };
    }
  }
}

function buildRequest(params: SendMessageParams): GenerateContentRequest {
  const request: GenerateContentRequest = {
    contents: params.messages.map(mapMessage),
    systemInstruction: {role: 'user', parts: [{text: params.systemPrompt}]},
  };

  if (params.tools?.length) {
    request.tools = [
      {
        functionDeclarations: params.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema as unknown as FunctionDeclarationSchema,
        })),
      },
    ];
  }

  return request;
}

function mapMessage(m: Message): Content {
  if (typeof m.content === 'string') {
    return {role: m.role === 'assistant' ? 'model' : 'user', parts: [{text: m.content}]};
  }

  const parts = m.content.map(block => {
    if (block.type === 'tool_use') {
      return {
        functionCall: {
          name: block.name,
          args: block.input,
        },
      };
    }
    return {
      functionResponse: {
        name: block.toolUseId,
        response: {result: block.content},
      },
    };
  });

  return {role: m.role === 'assistant' ? 'model' : 'user', parts};
}

function extractUsage(response: GenerateContentResponse): UsageMetadata | undefined {
  const usage = response.usageMetadata;
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    totalTokens: usage.totalTokenCount ?? 0,
  };
}

function mapVertexError(error: unknown): AIError {
  if (error instanceof AIError) return error;
  const message = error instanceof Error ? error.message : 'Unknown Vertex AI error';
  if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED')) {
    // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
    return new AIError(message, 'RATE_LIMITED', true);
  }
  if (message.includes('401') || message.includes('403') || message.includes('PERMISSION_DENIED')) {
    return new AIError(message, 'AUTH_ERROR');
  }
  return new AIError(message, 'PROVIDER_ERROR');
}

function mapResponseSchema(schema: ResponseSchema): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    type: schema.type.toUpperCase() as SchemaType,
  };

  if (schema.description) mapped.description = schema.description;
  if (schema.enum) mapped.enum = schema.enum;

  if (schema.properties) {
    mapped.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, mapResponseSchema(value)])
    );
  }
  if (schema.required) mapped.required = schema.required;
  if (schema.items) mapped.items = mapResponseSchema(schema.items);

  return mapped;
}

function extractText(response: GenerateContentResponse): string {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!parts) return '';
  const texts = parts.filter((p): p is {text: string} => 'text' in p && typeof p.text === 'string').map(p => p.text);
  return texts.join('');
}
