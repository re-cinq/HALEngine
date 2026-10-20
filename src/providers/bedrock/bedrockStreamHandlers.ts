import type {ConverseStreamOutput} from '@aws-sdk/client-bedrock-runtime';
import {AIError} from '../../types/ai.js';
import type {MessageChunk, UsageMetadata} from '../../types/ai.js';

export interface ToolAccumulator {
  currentToolCall: {id: string; name: string} | null;
  toolInput: string;
}

export function emptyToolAccumulator(): ToolAccumulator {
  return {currentToolCall: null, toolInput: ''};
}

export function handleTextDelta(event: ConverseStreamOutput): MessageChunk | null {
  const delta = event.contentBlockDelta?.delta;
  const text = delta?.text;
  return text ? {type: 'text', text} : null;
}

export function handleToolStart(event: ConverseStreamOutput, acc: ToolAccumulator): ToolAccumulator {
  const start = event.contentBlockStart?.start;
  const toolStart = start?.toolUse;
  if (!toolStart) return acc;
  return {
    currentToolCall: {id: toolStart.toolUseId ?? '', name: toolStart.name ?? ''},
    toolInput: '',
  };
}

export function handleToolInputDelta(event: ConverseStreamOutput, acc: ToolAccumulator): ToolAccumulator {
  const delta = event.contentBlockDelta?.delta;
  const input = delta?.toolUse?.input;
  if (!input) return acc;
  return {...acc, toolInput: acc.toolInput + input};
}

export function handleContentBlockStop(
  event: ConverseStreamOutput,
  acc: ToolAccumulator
): [ToolAccumulator, MessageChunk | null] {
  if (!event.contentBlockStop || !acc.currentToolCall) return [acc, null];
  const chunk: MessageChunk = {
    type: 'tool_use',
    toolCall: {...acc.currentToolCall, input: parseToolInput(acc.toolInput)},
  };
  return [emptyToolAccumulator(), chunk];
}

export function handleMessageStop(event: ConverseStreamOutput): MessageChunk | null {
  if (!event.messageStop) return null;
  return {type: 'stop', stopReason: event.messageStop.stopReason ?? 'end_turn'};
}

/** The token counts a metadata event reports, and nothing else from it: its trace can carry content derived from user input. */
export function extractUsageFromMetadata(event: ConverseStreamOutput): UsageMetadata | undefined {
  const usage = event.metadata?.usage;
  if (!usage) return undefined;
  const {inputTokens, outputTokens, totalTokens} = usage;
  // No numbers at all is an honest absence, not a confident zero in a cost column.
  if ([inputTokens, outputTokens, totalTokens].every(count => count === undefined)) return undefined;
  // The vendor's own total, never a recomputed sum: it may count cache tokens this engine does not model.
  return {inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, totalTokens: totalTokens ?? 0};
}

function parseToolInput(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AIError(`Malformed tool input JSON: ${raw}`, 'TOOL_INPUT_PARSE_ERROR');
  }
}
