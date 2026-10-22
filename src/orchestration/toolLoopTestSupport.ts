import {ToolRegistry} from './tools/registry.js';
import type {ToolResponse} from './tools/registry.js';
import type {ToolCall} from '../types/ai.js';

/** Two registered tools whose executors record the order they started in; what each answers is the caller's. */
export function twoTools(answers: {first: ToolResponse; second: ToolResponse}): {
  registry: ToolRegistry;
  ran: string[];
} {
  const ran: string[] = [];
  const registry = new ToolRegistry();
  for (const name of ['first', 'second'] as const) {
    registry.register({name, description: `the ${name} tool`, inputSchema: {type: 'object'}}, async () => {
      ran.push(name);
      return answers[name];
    });
  }
  return {registry, ran};
}

export const CALL_A: ToolCall = {id: 'call-a', name: 'first', input: {a: 1}};
export const CALL_B: ToolCall = {id: 'call-b', name: 'second', input: {b: 2}};
