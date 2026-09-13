import {createProvider} from './providerFactory.js';
import type {ResponseSchema, StructuredOutputParams} from '../types/ai.js';

// An arm that drops its argument stays invisible until compared against the direct factory.
const SCHEMA: ResponseSchema = {type: 'object', properties: {status: {type: 'string'}, count: {type: 'number'}}};

const structuredParams = (content: string): StructuredOutputParams<unknown> => ({
  messages: [{role: 'user', content}],
  systemPrompt: 'system',
  responseSchema: SCHEMA,
});

const configuredMock = () =>
  createProvider({type: 'mock', structuredResponses: new Map([['ping', {status: 'configured', count: 42}]])});

describe('createProvider', () => {
  it('forwards MockConfig, so a configured structured response survives the factory', async () => {
    await expect(configuredMock().generateStructured(structuredParams('ping'))).resolves.toEqual({
      status: 'configured',
      count: 42,
    });
  });

  it('falls back to schema-shaped defaults for a message the map does not name', async () => {
    await expect(configuredMock().generateStructured(structuredParams('unmapped'))).resolves.toEqual({
      status: '',
      count: 0,
    });
  });

  it('accepts a mock config carrying no map at all', async () => {
    const provider = createProvider({type: 'mock'});

    await expect(provider.generateStructured(structuredParams('ping'))).resolves.toEqual({status: '', count: 0});
  });

  it('dispatches each arm to a provider satisfying the full AIProvider interface', () => {
    const shape = (provider: unknown) => {
      const p = provider as Record<string, unknown>;
      return typeof p.sendMessage === 'function' && typeof p.generateStructured === 'function';
    };

    expect([
      shape(createProvider({type: 'mock'})),
      shape(createProvider({type: 'openai', apiKey: 'k', model: 'm'})),
      shape(createProvider({type: 'anthropic', apiKey: 'k', model: 'm'})),
      shape(createProvider({type: 'bedrock', region: 'eu-west-1', modelId: 'm', maxTokens: 16})),
      shape(createProvider({type: 'vertex', projectId: 'p', location: 'europe-west4', modelId: 'm'})),
    ]).toEqual([true, true, true, true, true]);
  });

  it('routes the mock arm to the mock, not to a neighbouring arm', async () => {
    const chunks = [];
    for await (const chunk of createProvider({type: 'mock'}).sendMessage({
      messages: [{role: 'user', content: 'hi'}],
      systemPrompt: 'system',
    })) {
      chunks.push(chunk.type);
    }

    expect(chunks[chunks.length - 1]).toBe('stop');
  });
});
