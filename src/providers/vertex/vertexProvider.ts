import type {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentResponse,
  GoogleGenAIOptions,
  Part,
  Schema,
} from '@google/genai';
import {AIError} from '../../types/ai.js';
import type {
  AIProvider,
  Message,
  MessageChunk,
  SendMessageParams,
  StructuredOutputParams,
  ResponseSchema,
  ToolCallContent,
  ToolDefinition,
  UsageMetadata,
} from '../../types/ai.js';
import {log} from '../../shared/logger.js';
import {requireOptionalPeer} from '../requireOptionalPeer.js';

export interface VertexConfig {
  type: 'vertex';
  projectId: string;
  location: string;
  modelId: string;
  maxTokens?: number;
  /** Base Vertex AI host, such as `aiplatform.eu.rep.googleapis.com`; unset, the SDK derives it from `location`, `eu` included. */
  apiEndpoint?: string;
  googleAuthOptions?: Record<string, unknown>;
}

export function createVertexProvider(config: VertexConfig): AIProvider {
  const {GoogleGenAI} = requireOptionalPeer<typeof import('@google/genai')>('@google/genai');
  const client = new GoogleGenAI(clientOptions(config));

  return {
    async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
      // Checked before the request exists, so an abort here keeps the conversation from the vendor altogether.
      if (params.signal?.aborted) return;

      log.info('vertex', 'sending message', {
        modelId: config.modelId,
        messageCount: params.messages.length,
        hasTools: !!params.tools,
      });

      try {
        const stream = await client.models.generateContentStream({
          model: config.modelId,
          contents: params.messages.map(mapMessage),
          config: streamConfig(params, config.maxTokens),
        });

        yield* turnChunks(stream, params.signal);
      } catch (error) {
        // An abort is the engine's own decision, not a vendor failure, so it ends the stream instead of raising.
        if (params.signal?.aborted) {
          log.info('vertex', 'request aborted');
          return;
        }
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
        const response = await client.models.generateContent({
          model: config.modelId,
          contents: params.messages.map(mapMessage),
          config: {
            systemInstruction: params.systemPrompt,
            maxOutputTokens: params.maxTokens ?? config.maxTokens,
            responseMimeType: 'application/json',
            responseSchema: mapResponseSchema(params.responseSchema) as Schema,
          },
        });

        return JSON.parse(extractText(response)) as T;
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

// Vertex mode, never the Gemini API: a project and location select Vertex, and its data-residency terms with it.
function clientOptions(config: VertexConfig): GoogleGenAIOptions {
  return {
    vertexai: true,
    project: config.projectId,
    location: config.location,
    // The GA surface @google-cloud/vertexai called; the SDK would otherwise default to v1beta1.
    apiVersion: 'v1',
    googleAuthOptions: config.googleAuthOptions as GoogleGenAIOptions['googleAuthOptions'],
    ...(config.apiEndpoint ? {httpOptions: {baseUrl: `https://${config.apiEndpoint}/`}} : {}),
  };
}

function streamConfig(params: SendMessageParams, maxTokens: number | undefined): GenerateContentConfig {
  return {
    systemInstruction: params.systemPrompt,
    maxOutputTokens: params.maxTokens ?? maxTokens,
    // Handed to fetch, so an abort closes the connection; the SDK notes the service may still finish and bill it.
    ...(params.signal ? {abortSignal: params.signal} : {}),
    ...(params.tools?.length ? {tools: [{functionDeclarations: params.tools.map(declarationOf)}]} : {}),
  };
}

// The SDK turns this JSON Schema into Gemini's own schema shape, upper-casing types and dropping additionalProperties.
function declarationOf(tool: ToolDefinition): FunctionDeclaration {
  return {name: tool.name, description: tool.description, parameters: tool.inputSchema as Schema};
}

// Exactly one stop chunk, last: at the first finish reason, or derived once the stream ends without one.
async function* turnChunks(
  stream: AsyncIterable<GenerateContentResponse>,
  signal: AbortSignal | undefined
): AsyncGenerator<MessageChunk> {
  let endOfTurn = 'end_turn';
  let usage: UsageMetadata | undefined;
  for await (const chunk of stream) {
    if (signal?.aborted) return;
    usage = extractUsage(chunk) ?? usage;
    const candidate = chunk.candidates?.[0];
    const chunks = [...partChunks(candidate?.content?.parts ?? [])];
    if (chunks.some(part => part.type === 'tool_use')) endOfTurn = 'tool_use';
    yield* chunks;
    if (candidate?.finishReason) {
      yield {type: 'stop', stopReason: stopReasonOf(candidate.finishReason, endOfTurn), usage};
      return;
    }
  }
  if (signal?.aborted) return;
  yield {type: 'stop', stopReason: endOfTurn, usage};
}

// The API marks a tool call with functionCall parts and finishes the turn STOP like any other, so STOP ends it as its parts did.
function stopReasonOf(finishReason: string, endOfTurn: string): string {
  if (finishReason === 'STOP') return endOfTurn;
  if (finishReason === 'MAX_TOKENS') return 'max_tokens';
  return finishReason.toLowerCase();
}

// A part can carry text and a function call at once, so it maps to 0, 1 or 2 chunks.
function* partChunks(parts: Part[]): Generator<MessageChunk> {
  for (const part of parts) {
    if (part.text) {
      yield {type: 'text', text: part.text};
    }

    if (part.functionCall) {
      const name = part.functionCall.name ?? '';
      yield {
        type: 'tool_use',
        toolCall: {id: name, name, input: part.functionCall.args ?? {}, ...signatureOf(part)},
      };
    }
  }
}

// No key at all for a call that came unsigned, so nothing is invented on the way back.
function signatureOf(part: Part): {signature?: string} {
  return part.thoughtSignature === undefined ? {} : {signature: part.thoughtSignature};
}

function mapMessage(m: Message): Content {
  if (typeof m.content === 'string') {
    return {role: m.role === 'assistant' ? 'model' : 'user', parts: [{text: m.content}]};
  }

  const parts = m.content.map((block): Part => {
    if (block.type === 'tool_use') return functionCallPart(block);
    return {
      functionResponse: {
        name: block.toolUseId,
        response: {result: block.content},
      },
    };
  });

  return {role: m.role === 'assistant' ? 'model' : 'user', parts};
}

// Gemini 3 refuses a turn's next request when a call it signed comes back without that signature.
function functionCallPart(block: ToolCallContent): Part {
  return {
    functionCall: {name: block.name, args: block.input},
    ...(block.signature === undefined ? {} : {thoughtSignature: block.signature}),
  };
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

// The SDK's ApiError carries the HTTP status; its message, the vendor's JSON body, is the fallback for anything else.
function mapVertexError(error: unknown): AIError {
  if (error instanceof AIError) return error;
  const message = error instanceof Error ? error.message : 'Unknown Vertex AI error';
  const status = statusOf(error);
  if (status === 429 || message.includes('429') || message.includes('RESOURCE_EXHAUSTED')) {
    // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
    return new AIError(message, 'RATE_LIMITED', true);
  }
  if (status === 401 || status === 403 || /401|403|PERMISSION_DENIED/.test(message)) {
    return new AIError(message, 'AUTH_ERROR');
  }
  return new AIError(message, 'PROVIDER_ERROR');
}

function statusOf(error: unknown): number | undefined {
  if (!(error instanceof Object)) return undefined;
  const {status} = error as {status?: unknown};
  return typeof status === 'number' ? status : undefined;
}

function mapResponseSchema(schema: ResponseSchema): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    type: schema.type.toUpperCase(),
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
  const parts = candidate?.content?.parts ?? [];
  return parts.map(part => part.text ?? '').join('');
}
