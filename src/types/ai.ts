import type {OutgoingMessage} from './messages.js';

export interface TextMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCallContent {
  type: 'tool_use';
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  /** The opaque token its ToolCall arrived with, which the provider that issued it sends back unchanged. */
  signature?: string;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  /** Set only when the result describes a failure; a provider mapper encodes it on its own wire. */
  isError?: boolean;
}

export interface ToolUseMessage {
  role: 'assistant';
  content: ToolCallContent[];
}

export interface ToolResultMessage {
  role: 'user';
  content: ToolResultContent[];
}

export type Message = TextMessage | ToolUseMessage | ToolResultMessage;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  promptInstructions?: string;
  examplePrompts?: string[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** An opaque vendor token tied to this call, such as Gemini's thought signature, owed back on the turn's next request. */
  signature?: string;
}

export type MessageChunk =
  | {type: 'text'; text: string}
  | {type: 'tool_use'; toolCall: ToolCall}
  | {type: 'tool_result'; clientMessages: OutgoingMessage[]}
  | {type: 'suppress_output'}
  | {type: 'stop'; stopReason: string; usage?: UsageMetadata};

export interface SendMessageParams {
  messages: Message[];
  systemPrompt: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  /** Once aborted, the provider yields nothing more and ends without an error; whether the vendor stops too depends on its SDK (specs/hal-engine-providers/spec.md § Cancellation). */
  signal?: AbortSignal;
}

export interface StructuredOutputParams<_T> {
  messages: Message[];
  systemPrompt: string;
  responseSchema: ResponseSchema;
  maxTokens?: number;
}

export interface ResponseSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  properties?: Record<string, ResponseSchema>;
  items?: ResponseSchema;
  required?: string[];
  description?: string;
  enum?: string[];
}

export interface UsageMetadata {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AIProviderResponse {
  usage?: UsageMetadata;
}

export interface AIProvider {
  sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk>;
  generateStructured<T>(params: StructuredOutputParams<T>): Promise<T>;
}

export class AIError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    // eslint-disable-next-line re-lint/no-flag-params -- public API; splitting AIError is a breaking change (adrs/ADR-006-lint-suppressions.md)
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = 'AIError';
  }
}
