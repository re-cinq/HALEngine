import {
  buildToolCallMessages,
  collectText,
  collectToolCalls,
  extractStopReason,
  extractUsage,
  shouldContinueToolLoop,
} from './orchestratorHelpers.js';
import type {ToolRegistry} from './tools/registry.js';
import type {MessageChunk, ToolCall} from '../types/ai.js';

// All three conditions matter; dropping the registry check spins the tool loop.

const A_TOOL: ToolCall[] = [{id: 't1', name: 'lookup', input: {}}];
const REGISTRY = {} as ToolRegistry;

describe('shouldContinueToolLoop', () => {
  it('continues when the model requested a tool and a registry can run it', () => {
    expect(shouldContinueToolLoop('tool_use', A_TOOL, REGISTRY)).toBe(true);
  });

  it('stops when no registry is configured, whatever the model asked for', () => {
    expect(shouldContinueToolLoop('tool_use', A_TOOL, undefined)).toBe(false);
  });

  it('stops when the model named no tool', () => {
    expect(shouldContinueToolLoop('tool_use', [], REGISTRY)).toBe(false);
  });

  it('stops when the model finished for a reason other than tool use', () => {
    expect(shouldContinueToolLoop('end_turn', A_TOOL, REGISTRY)).toBe(false);
  });
});

describe('buildToolCallMessages', () => {
  it("puts sig-1 on the signed call's tool_use block and no signature key on the unsigned one", () => {
    const calls: ToolCall[] = [
      {id: 'a', name: 'lookup', input: {}, signature: 'sig-1'},
      {id: 'b', name: 'weather', input: {}},
    ];

    expect(buildToolCallMessages(calls)).toStrictEqual({
      role: 'assistant',
      content: [
        {type: 'tool_use', toolUseId: 'a', name: 'lookup', input: {}, signature: 'sig-1'},
        {type: 'tool_use', toolUseId: 'b', name: 'weather', input: {}},
      ],
    });
  });
});

const STOP_FOR_TOOL: MessageChunk = {type: 'stop', stopReason: 'tool_use'};
const STOP_DONE: MessageChunk = {type: 'stop', stopReason: 'end_turn'};
const TEXT: MessageChunk = {type: 'text', text: 'word '};

const streamOf = async function* (chunks: MessageChunk[]): AsyncGenerator<MessageChunk> {
  yield* chunks;
};

describe('shouldContinueToolLoop truth table', () => {
  it('continues for tool_use with a pending call and a registry alone, and stops for the other seven rows', () => {
    const rows = [
      ['tool_use', A_TOOL, REGISTRY],
      ['tool_use', A_TOOL, undefined],
      ['tool_use', [], REGISTRY],
      ['tool_use', [], undefined],
      ['end_turn', A_TOOL, REGISTRY],
      ['end_turn', A_TOOL, undefined],
      ['end_turn', [], REGISTRY],
      ['end_turn', [], undefined],
    ] as const;

    expect(rows.map(([reason, calls, registry]) => shouldContinueToolLoop(reason, [...calls], registry))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('collectText', () => {
  it('joins the text chunks of a stream in order and ignores every other chunk type', async () => {
    const tool: MessageChunk = {type: 'tool_use', toolCall: {id: 't1', name: 'lookup', input: {}}};

    expect(await collectText(streamOf([TEXT, tool, {type: 'text', text: 'by word'}, STOP_DONE]))).toBe('word by word');
  });
});

describe('collectToolCalls', () => {
  it('appends the call of a tool_use chunk to the pending list and leaves it alone for text and stop chunks', () => {
    const pending: ToolCall[] = [];
    const call: ToolCall = {id: 't2', name: 'weather', input: {city: 'here'}};

    collectToolCalls(TEXT, pending);
    collectToolCalls({type: 'tool_use', toolCall: call}, pending);
    collectToolCalls(STOP_FOR_TOOL, pending);

    expect(pending).toEqual([call]);
  });
});

describe('extractStopReason', () => {
  it('reads the reason off a stop chunk and answers null for a text chunk', () => {
    expect([extractStopReason(STOP_FOR_TOOL), extractStopReason(STOP_DONE), extractStopReason(TEXT)]).toEqual([
      'tool_use',
      'end_turn',
      null,
    ]);
  });
});

describe('extractUsage', () => {
  it('reads the usage off a stop chunk that reports one, and answers undefined for a stop without usage and for a text chunk', () => {
    const usage = {inputTokens: 3, outputTokens: 4, totalTokens: 7};

    expect([extractUsage({...STOP_DONE, usage}), extractUsage(STOP_DONE), extractUsage(TEXT)]).toEqual([
      usage,
      undefined,
      undefined,
    ]);
  });
});
