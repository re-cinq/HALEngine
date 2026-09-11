import type {SessionEntry} from '../types/session.js';
import type {Message, ToolCallContent, ToolResultContent} from '../types/ai.js';

const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_MAX_CONTENT_LENGTH = 100_000;

export interface ContextConfig {
  maxMessages: number;
  maxContentLength: number;
}
export function createContextConfig(overrides?: Partial<ContextConfig>): ContextConfig {
  return {
    maxMessages: overrides?.maxMessages ?? DEFAULT_MAX_MESSAGES,
    maxContentLength: overrides?.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH,
  };
}

export function toMessages(entries: SessionEntry[], config: ContextConfig = createContextConfig()): Message[] {
  const messages = toContentMessages(entries);
  return applyMessageWindow(messages, config);
}

function toContentMessages(entries: SessionEntry[]): Message[] {
  const messages: Message[] = [];
  let toolCallCounter = 0;

  for (const e of entries) {
    if (e.role === 'tool') {
      const syntheticId = `hist-${toolCallCounter++}`;
      const toolUseContent: ToolCallContent = {
        type: 'tool_use',
        toolUseId: syntheticId,
        name: e.toolName,
        input: e.toolInput,
      };
      messages.push({role: 'assistant', content: [toolUseContent]});

      const toolResultContent: ToolResultContent = {
        type: 'tool_result',
        toolUseId: syntheticId,
        content: '[result was returned to user]',
      };
      messages.push({role: 'user', content: [toolResultContent]});
      continue;
    }

    if (e.role === 'user' || e.role === 'assistant') {
      messages.push({role: e.role, content: e.content});
    }
  }
  return messages;
}

function applyMessageWindow(messages: Message[], config: ContextConfig): Message[] {
  let result = messages.slice(-config.maxMessages);

  let totalLength = result.reduce((sum, m) => sum + contentLength(m), 0);
  while (totalLength > config.maxContentLength && result.length > 1) {
    const removed = result.shift()!;
    totalLength -= contentLength(removed);
  }

  while (result.length > 0 && result[0].role !== 'user') {
    result = result.slice(1);
  }

  return result;
}

function contentLength(m: Message): number {
  if (typeof m.content === 'string') return m.content.length;
  return JSON.stringify(m.content).length;
}
