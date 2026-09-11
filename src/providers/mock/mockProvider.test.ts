import {createMockProvider} from './mockProvider.js';
import {collectChunks, userMessage} from '../providerTestSupport.js';
import type {AIProvider, SendMessageParams, ResponseSchema} from '../../types/ai.js';

describe('createMockProvider', () => {
  describe('sendMessage', () => {
    it('streams word-by-word response echoing user input', async () => {
      const provider = createMockProvider();
      const chunks = await collectChunks(provider.sendMessage(userMessage('hello world')));

      const textChunks = chunks.filter(c => c.type === 'text');
      const fullText = textChunks.map(c => (c.type === 'text' ? c.text : '')).join('');
      expect(fullText).toContain('hello world');
    });

    it('ends with stop chunk containing usage metadata', async () => {
      const provider = createMockProvider();
      const chunks = await collectChunks(provider.sendMessage(userMessage('test')));

      const stopChunk = chunks.find(c => c.type === 'stop');
      expect(stopChunk).toEqual({
        type: 'stop',
        stopReason: 'end_turn',
        usage: {inputTokens: 10, outputTokens: 20, totalTokens: 30},
      });
    });

    it('handles non-string content in last message', async () => {
      const provider = createMockProvider();
      const params: SendMessageParams = {
        messages: [{role: 'assistant', content: [{type: 'tool_use', toolUseId: '1', name: 'test', input: {}}]}],
        systemPrompt: 'test',
      };
      const chunks = await collectChunks(provider.sendMessage(params));
      const fullText = chunks
        .filter(c => c.type === 'text')
        .map(c => (c.type === 'text' ? c.text : ''))
        .join('');
      expect(fullText).toContain('Hello');
    });
  });

  describe('generateStructured', () => {
    const objectSchema: ResponseSchema = {
      type: 'object',
      properties: {
        name: {type: 'string'},
        score: {type: 'number'},
        active: {type: 'boolean'},
      },
      required: ['name', 'score'],
    };

    type Evaluation = {name: string; score: number; active: boolean};
    const evaluate = (provider: AIProvider): Promise<Evaluation> =>
      provider.generateStructured<Evaluation>({
        messages: [{role: 'user', content: 'evaluate this'}],
        systemPrompt: 'test',
        responseSchema: objectSchema,
      });

    it('returns default values matching schema shape', async () => {
      const result = await evaluate(createMockProvider());

      expect(result).toEqual({name: '', score: 0, active: false});
    });

    it('returns preconfigured response when user text matches', async () => {
      const expected = {name: 'test', score: 95, active: true};
      const result = await evaluate(
        createMockProvider({type: 'mock', structuredResponses: new Map([['evaluate this', expected]])})
      );

      expect(result).toEqual(expected);
    });

    it('returns empty array for array schema', async () => {
      const provider = createMockProvider();
      const result = await provider.generateStructured<string[]>({
        messages: [{role: 'user', content: 'list items'}],
        systemPrompt: 'test',
        responseSchema: {type: 'array', items: {type: 'string'}},
      });

      expect(result).toEqual([]);
    });

    it('gives each caller its own array, so one mutating it cannot affect another', async () => {
      const provider = createMockProvider();
      const arraySchema: ResponseSchema = {type: 'object', properties: {items: {type: 'array'}}};
      const ask = () =>
        provider.generateStructured<{items: string[]}>({
          messages: [{role: 'user', content: 'x'}],
          systemPrompt: 'test',
          responseSchema: arraySchema,
        });

      const [first, second] = await Promise.all([ask(), ask()]);
      first.items.push('mutated');

      expect(second.items).toEqual([]);
    });

    it('falls back to default when no preconfigured response matches', async () => {
      const provider = createMockProvider({
        type: 'mock',
        structuredResponses: new Map([['other query', {result: true}]]),
      });

      const result = await provider.generateStructured<{name: string}>({
        messages: [{role: 'user', content: 'unmatched query'}],
        systemPrompt: 'test',
        responseSchema: {type: 'object', properties: {name: {type: 'string'}}},
      });

      expect(result).toEqual({name: ''});
    });
  });
});
