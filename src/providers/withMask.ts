import type {
  AIProvider,
  Message,
  MessageChunk,
  SendMessageParams,
  StructuredOutputParams,
  TextMessage,
  ToolUseMessage,
} from '../types/ai.js';

/** A deployer's reversible pseudonymisation: the engine ships this mechanism and no detector of its own. */
export interface PromptMask {
  /** One binding per sendMessage call; its mapping is discarded when that call's stream ends. */
  bind(): MaskBinding;
  /** The longest token this mask can emit, in characters; restored text is held back by up to this many. */
  maxTokenLength: number;
}

/** One call's mapping between real values and the tokens the model sees in their place. */
export interface MaskBinding {
  /** Real value to token, recording the pair. */
  apply(text: string): string;
  /** Token to real value. */
  restore(text: string): string;
}

/** Sends the vendor tokens in place of what the mask recognises, and puts the real values back before anything downstream reads them. */
export function withMask(provider: AIProvider, mask: PromptMask): AIProvider {
  return {
    async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
      const binding = mask.bind();
      // Masked before the request exists, so an apply that throws fails the call with nothing sent.
      const masked: SendMessageParams = {
        ...params,
        messages: params.messages.map(message => maskMessage(message, binding)),
      };
      const restorer = heldBackRestorer(binding, mask.maxTokenLength);

      for await (const chunk of provider.sendMessage(masked)) {
        if (chunk.type === 'text') {
          yield* textChunk(restorer.push(chunk.text));
          continue;
        }
        // Text held back is released before any other chunk, so the order the provider chose survives.
        yield* textChunk(restorer.flush());
        yield chunk.type === 'tool_use'
          ? {...chunk, toolCall: {...chunk.toolCall, input: restoreStrings(chunk.toolCall.input, binding)}}
          : chunk;
      }

      yield* textChunk(restorer.flush());
    },

    // Structured output is the deployer's own evaluation call, delegated untouched.
    generateStructured<T>(params: StructuredOutputParams<T>): Promise<T> {
      return provider.generateStructured(params);
    },
  };
}

// The system prompt and the tool definitions are static instructions and pass through untouched; only conversation carriers are masked.
function maskMessage(message: Message, binding: MaskBinding): Message {
  if (isText(message)) return {...message, content: binding.apply(message.content)};
  if (isToolUse(message)) {
    return {...message, content: message.content.map(block => ({...block, input: applyStrings(block.input, binding)}))};
  }
  return {...message, content: message.content.map(block => ({...block, content: binding.apply(block.content)}))};
}

function isText(message: Message): message is TextMessage {
  return typeof message.content === 'string';
}

// A content array holds one kind of block, so the first one names the message: tool calls from the model, or their results.
function isToolUse(message: Message): message is ToolUseMessage {
  const {content} = message;
  return Array.isArray(content) && content[0]?.type === 'tool_use';
}

// Empty text is no chunk at all, so holding text back never yields a blank delta.
function* textChunk(text: string): Generator<MessageChunk> {
  if (text) yield {type: 'text', text};
}

function applyStrings(input: Record<string, unknown>, binding: MaskBinding): Record<string, unknown> {
  return mapStrings(input, text => binding.apply(text)) as Record<string, unknown>;
}

function restoreStrings(input: Record<string, unknown>, binding: MaskBinding): Record<string, unknown> {
  return mapStrings(input, text => binding.restore(text)) as Record<string, unknown>;
}

// Every string a tool argument holds, at any depth; numbers, booleans and null carry no text to mask.
function mapStrings(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map(element => mapStrings(element, transform));
  if (value instanceof Object) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, mapStrings(nested, transform)]));
  }
  return value;
}

interface Restorer {
  push(text: string): string;
  flush(): string;
}

// A token can be split across chunks, so the last maxTokenLength - 1 characters wait for the next chunk before restoring.
function heldBackRestorer(binding: MaskBinding, maxTokenLength: number): Restorer {
  const keep = Math.max(0, maxTokenLength - 1);
  let held = '';
  return {
    push(text) {
      // Restoring the whole window first: a complete token anywhere in it becomes its real value, and only an incomplete one stays raw at the end.
      const restored = binding.restore(held + text);
      const cut = Math.max(0, restored.length - keep);
      held = restored.slice(cut);
      return restored.slice(0, cut);
    },
    flush() {
      const rest = binding.restore(held);
      held = '';
      return rest;
    },
  };
}
