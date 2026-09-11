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
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
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
