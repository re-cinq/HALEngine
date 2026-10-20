import {readFileSync} from 'node:fs';
import {mapMessage} from './bedrockMessageMapper.js';
import type {ToolResultContent} from '../../types/ai.js';

const resultMessage = (block: ToolResultContent) => mapMessage({role: 'user', content: [block]});

describe('mapMessage, a tool result', () => {
  it("maps a tool_result with isError true to a toolResult whose status is 'error'", () => {
    const mapped = resultMessage({type: 'tool_result', toolUseId: 't1', content: 'lookup failed', isError: true});

    expect(mapped).toEqual({
      role: 'user',
      content: [{toolResult: {toolUseId: 't1', content: [{text: 'lookup failed'}], status: 'error'}}],
    });
  });

  it('maps the same tool_result with isError omitted to a toolResult with no status key', () => {
    const mapped = resultMessage({type: 'tool_result', toolUseId: 't1', content: 'found'});

    const [block] = mapped.content ?? [];
    expect({mapped, hasStatus: Object.hasOwn(block?.toolResult ?? {}, 'status')}).toEqual({
      mapped: {role: 'user', content: [{toolResult: {toolUseId: 't1', content: [{text: 'found'}]}}]},
      hasStatus: false,
    });
  });

  it('imports @aws-sdk/client-bedrock-runtime as types only, so the optional peer is never loaded by mapping', () => {
    const source = readFileSync(new URL('./bedrockMessageMapper.ts', import.meta.url), 'utf8');

    const imports = source.split('\n').filter(line => line.includes("'@aws-sdk/client-bedrock-runtime'"));
    expect({count: imports.length, typeOnly: imports.every(line => line.startsWith('import type '))}).toEqual({
      count: 1,
      typeOnly: true,
    });
  });
});
