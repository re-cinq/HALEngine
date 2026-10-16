import {buildToolCallMessages, shouldContinueToolLoop} from './orchestratorHelpers.js';
import type {ToolRegistry} from './tools/registry.js';
import type {ToolCall} from '../types/ai.js';

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
