import {readFileSync} from 'node:fs';
import {mapMessage, supportsToolResultStatus} from './bedrockMessageMapper.js';
import type {ToolResultContent} from '../../types/ai.js';

// The same block mapped for a model that takes toolResult.status, and for one that does not.
const resultMessage = (block: ToolResultContent) =>
  mapMessage({role: 'user', content: [block]}, {toolResultStatus: true});
const resultForOtherModel = (block: ToolResultContent) =>
  mapMessage({role: 'user', content: [block]}, {toolResultStatus: false});

describe('mapMessage, a tool result', () => {
  it("maps a tool_result with isError true to a toolResult whose status is 'error', for a model that takes the field", () => {
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

  it('omits status for a model that does not take the field, the failure still in the text, isError true or not', () => {
    const failed = resultForOtherModel({type: 'tool_result', toolUseId: 't1', content: 'lookup failed', isError: true});

    const [block] = failed.content ?? [];
    expect({failed, hasStatus: Object.hasOwn(block?.toolResult ?? {}, 'status')}).toEqual({
      failed: {role: 'user', content: [{toolResult: {toolUseId: 't1', content: [{text: 'lookup failed'}]}}]},
      hasStatus: false,
    });
  });

  it('takes the field for Amazon Nova and Anthropic Claude 3 and 4 ids, inference profiles included, and for no other model', () => {
    const ids = [
      'anthropic.claude-3-haiku-20240307-v1:0',
      'anthropic.claude-3-5-sonnet-20240620-v1:0',
      'eu.anthropic.claude-3-7-sonnet-20250219-v1:0',
      'anthropic.claude-sonnet-4-20250514-v1:0',
      'us.anthropic.claude-opus-4-1-20250805-v1:0',
      'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'arn:aws:bedrock:eu-central-1:111122223333:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      'amazon.nova-pro-v1:0',
      'eu.amazon.nova-lite-v1:0',
      'anthropic.claude-v2:1',
      'anthropic.claude-instant-v1',
      'meta.llama3-70b-instruct-v1:0',
      'mistral.mistral-large-2407-v1:0',
      'cohere.command-r-plus-v1:0',
      'arn:aws:bedrock:eu-central-1:111122223333:application-inference-profile/a1b2c3d4e5f6',
    ];

    expect(Object.fromEntries(ids.map(id => [id, supportsToolResultStatus(id)]))).toEqual({
      'anthropic.claude-3-haiku-20240307-v1:0': true,
      'anthropic.claude-3-5-sonnet-20240620-v1:0': true,
      'eu.anthropic.claude-3-7-sonnet-20250219-v1:0': true,
      'anthropic.claude-sonnet-4-20250514-v1:0': true,
      'us.anthropic.claude-opus-4-1-20250805-v1:0': true,
      'eu.anthropic.claude-sonnet-4-5-20250929-v1:0': true,
      'arn:aws:bedrock:eu-central-1:111122223333:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0': true,
      'amazon.nova-pro-v1:0': true,
      'eu.amazon.nova-lite-v1:0': true,
      'anthropic.claude-v2:1': false,
      'anthropic.claude-instant-v1': false,
      'meta.llama3-70b-instruct-v1:0': false,
      'mistral.mistral-large-2407-v1:0': false,
      'cohere.command-r-plus-v1:0': false,
      'arn:aws:bedrock:eu-central-1:111122223333:application-inference-profile/a1b2c3d4e5f6': false,
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
