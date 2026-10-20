import type {
  AIProvider,
  MessageChunk,
  SendMessageParams,
  StructuredOutputParams,
  ToolCall,
  UsageMetadata,
} from '../../types/ai.js';

/** One scripted answer: its text, then its tool calls, then a stop chunk whose reason follows from whether it called a tool. */
export interface MockTurn {
  text?: string;
  toolCalls?: ToolCall[];
  /** Reported on the turn's stop chunk; unset, the fixed usage the echo reports. */
  usage?: UsageMetadata;
}

export interface MockConfig {
  type: 'mock';
  structuredResponses?: Map<string, unknown>;
  /** A queue, one turn per sendMessage call, not per user message; unset, the mock echoes the last user message. */
  turns?: MockTurn[];
  /** Runs once per sendMessage call, before its first chunk, with the parameters the caller built. */
  onSendMessage?: (params: SendMessageParams) => void;
}

const FIXED_USAGE: UsageMetadata = {inputTokens: 10, outputTokens: 20, totalTokens: 30};

export function createMockProvider(config?: MockConfig): AIProvider {
  const structuredResponses = config?.structuredResponses ?? new Map<string, unknown>();
  const turns = config?.turns;
  let calls = 0;

  return {
    async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
      config?.onSendMessage?.(params);
      calls++;
      const chunks = turns ? scriptedChunks(turns, calls) : echoChunks(params);

      // Checked before every chunk, so an abort ends the stream at once and no stop chunk follows it.
      for (const chunk of chunks) {
        if (params.signal?.aborted) return;
        yield chunk;
      }
    },

    async generateStructured<T>(params: StructuredOutputParams<T>): Promise<T> {
      const lastMessage = params.messages[params.messages.length - 1];
      const userText = typeof lastMessage?.content === 'string' ? lastMessage.content : '';

      const preconfigured = structuredResponses.get(userText);
      if (preconfigured !== undefined) return preconfigured as T;

      return buildDefaultResponse(params.responseSchema) as T;
    },
  };
}

function echoChunks(params: SendMessageParams): MessageChunk[] {
  const lastMessage = params.messages[params.messages.length - 1];
  const userText = typeof lastMessage?.content === 'string' ? lastMessage.content : 'Hello';
  const response = `Mock response to: "${userText}"`;
  const words: MessageChunk[] = response.split(' ').map(word => ({type: 'text', text: word + ' '}));
  return [...words, {type: 'stop', stopReason: 'end_turn', usage: FIXED_USAGE}];
}

// An exhausted script throws rather than fall back to the echo, which is how a broken test would still go green.
function scriptedChunks(turns: MockTurn[], call: number): MessageChunk[] {
  const turn = turns[call - 1];
  if (!turn) throw new Error(`mock provider script exhausted: call ${call} of ${turns.length} scripted turns`);
  // Split after each space, so the words join back to exactly the scripted text.
  const words: MessageChunk[] = (turn.text ?? '')
    .split(/(?<= )/)
    .filter(word => word !== '')
    .map(word => ({type: 'text', text: word}));
  // Not checked against params.tools: a hallucinated tool name is a conversation worth reproducing.
  const calls: MessageChunk[] = (turn.toolCalls ?? []).map(toolCall => ({type: 'tool_use', toolCall}));
  const stopReason = calls.length > 0 ? 'tool_use' : 'end_turn';
  return [...words, ...calls, {type: 'stop', stopReason, usage: turn.usage ?? FIXED_USAGE}];
}

// Factories, not values: `array` must hand back a fresh [] to each caller.
const SCALAR_DEFAULTS: Record<string, () => unknown> = {
  array: () => [],
  string: () => '',
  number: () => 0,
  boolean: () => false,
};

function buildDefaultResponse(schema: {type: string; properties?: Record<string, {type: string}>}): unknown {
  if (schema.type === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      result[key] = buildDefaultResponse(prop);
    }
    return result;
  }

  const scalar = SCALAR_DEFAULTS[schema.type];
  return scalar ? scalar() : null;
}
