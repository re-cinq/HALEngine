import {createMockProvider} from './mockProvider.js';
import {createProvider} from '../providerFactory.js';
import {collectAbortingAfter, collectChunks, userMessage} from '../providerTestSupport.js';
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

    it('stops yielding once its signal aborts, so an abort after two words leaves two chunks and no stop chunk', async () => {
      const controller = new AbortController();
      const stream = createMockProvider().sendMessage({...userMessage('hi'), signal: controller.signal});

      expect(await collectAbortingAfter(stream, controller, 2)).toEqual([
        {type: 'text', text: 'Mock '},
        {type: 'text', text: 'response '},
      ]);
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

  describe('scripted turns', () => {
    const lookup = {id: 't1', name: 'lookup', input: {q: 'hi'}};
    // The stop chunk of each of `calls` consecutive calls, in order.
    const stopsOf = async (provider: AIProvider, calls: number) => {
      const stops = [];
      for (let call = 0; call < calls; call++)
        stops.push((await collectChunks(provider.sendMessage(userMessage('go')))).at(-1));
      return stops;
    };
    const typesOf = async (provider: AIProvider) =>
      (await collectChunks(provider.sendMessage(userMessage('go')))).map(chunk => chunk.type);

    it('ends a turn that calls a tool with stopReason tool_use, and one that does not with end_turn', async () => {
      const provider = createMockProvider({type: 'mock', turns: [{toolCalls: [lookup]}, {text: 'done'}]});

      expect(await stopsOf(provider, 2)).toMatchObject([
        {type: 'stop', stopReason: 'tool_use'},
        {type: 'stop', stopReason: 'end_turn'},
      ]);
    });

    it("emits a turn's text, then its tool calls, then its stop, the text joining back to exactly what was scripted", async () => {
      const chunks = await collectChunks(
        createMockProvider({type: 'mock', turns: [{text: 'one moment please', toolCalls: [lookup]}]}).sendMessage(
          userMessage('go')
        )
      );

      expect({
        types: chunks.map(chunk => chunk.type),
        text: chunks.map(chunk => (chunk.type === 'text' ? chunk.text : '')).join(''),
      }).toEqual({types: ['text', 'text', 'text', 'tool_use', 'stop'], text: 'one moment please'});
    });

    it('throws on the third call against a two-turn script, naming call 3 of 2 scripted turns', async () => {
      const provider = createMockProvider({type: 'mock', turns: [{text: 'a'}, {text: 'b'}]});
      await typesOf(provider);
      await typesOf(provider);

      await expect(typesOf(provider)).rejects.toThrow('mock provider script exhausted: call 3 of 2 scripted turns');
    });

    it('reports the fixed usage on a scripted turn that sets none, and exactly the usage a turn sets', async () => {
      const usage = {inputTokens: 1, outputTokens: 2, totalTokens: 3};
      const provider = createMockProvider({type: 'mock', turns: [{text: 'a'}, {text: 'b', usage}]});

      expect(await stopsOf(provider, 2)).toMatchObject([
        {usage: {inputTokens: 10, outputTokens: 20, totalTokens: 30}},
        {usage},
      ]);
    });

    it('runs onSendMessage once per call, before the first chunk, with the parameters the caller passed', async () => {
      const seen: Array<{params: SendMessageParams; chunksSoFar: number}> = [];
      let chunksSoFar = 0;
      const provider = createMockProvider({
        type: 'mock',
        turns: [{text: 'a'}],
        onSendMessage: params => void seen.push({params, chunksSoFar}),
      });
      const params = userMessage('go');

      for await (const chunk of provider.sendMessage(params)) {
        void chunk;
        chunksSoFar++;
      }

      expect(seen).toEqual([{params, chunksSoFar: 0}]);
    });

    it('emits a tool_use for a tool no registry holds, checking nothing against params.tools', async () => {
      const invented = {id: 't9', name: 'invented_tool', input: {}};

      const chunks = await collectChunks(
        createMockProvider({type: 'mock', turns: [{toolCalls: [invented]}]}).sendMessage({
          ...userMessage('go'),
          tools: [],
        })
      );

      expect(chunks[0]).toEqual({type: 'tool_use', toolCall: invented});
    });

    it('answers generateStructured from structuredResponses exactly as before when turns are also set', async () => {
      const answer = {score: 1};
      const provider = createMockProvider({
        type: 'mock',
        turns: [{text: 'a'}],
        structuredResponses: new Map([['rate this', answer]]),
      });

      const result = await provider.generateStructured({
        messages: [{role: 'user', content: 'rate this'}],
        systemPrompt: 's',
        responseSchema: {type: 'object'},
      });

      expect(result).toBe(answer);
    });

    it('takes turns through createProvider as well as createMockProvider', async () => {
      expect(await typesOf(createProvider({type: 'mock', turns: [{toolCalls: [lookup]}]}))).toEqual([
        'tool_use',
        'stop',
      ]);
    });
  });
});
