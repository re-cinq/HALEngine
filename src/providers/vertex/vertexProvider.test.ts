import {jest} from '@jest/globals';
import type {ResponseSchema} from '../../types/ai.js';
import {collectChunks, userMessage} from '../providerTestSupport.js';

// @jest/globals types a bare jest.fn() as taking no arguments; these name what the assertions read back.
interface VertexRequest {
  contents: {role: string}[];
}
interface VertexModelConfig {
  generationConfig?: Record<string, unknown>;
}

const mockGenerateContentStream = jest.fn<(request: VertexRequest) => Promise<unknown>>();
const mockGenerateContent = jest.fn<(request: VertexRequest) => Promise<unknown>>();
const mockGetGenerativeModel = jest.fn<(config: VertexModelConfig) => unknown>();

const callMock = () => jest.fn<(request: VertexRequest) => Promise<unknown>>();

// createRequire never reaches jest's ESM registry, so the helper is the seam, not the package.
jest.unstable_mockModule('../requireOptionalPeer.js', () => ({
  requireOptionalPeer: () => ({
    VertexAI: jest.fn().mockImplementation(() => ({
      getGenerativeModel: mockGetGenerativeModel,
    })),
  }),
}));

const {createVertexProvider} = await import('./vertexProvider.js');
type VertexConfig = import('./vertexProvider.js').VertexConfig;

const defaultConfig: VertexConfig = {
  type: 'vertex',
  projectId: 'test-project',
  location: 'us-central1',
  modelId: 'gemini-1.5-flash',
  maxTokens: 1024,
};

async function* streamFrom(responses: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
  for (const r of responses) {
    yield r;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetGenerativeModel.mockReturnValue({
    generateContentStream: mockGenerateContentStream,
    generateContent: mockGenerateContent,
  });
});

describe('createVertexProvider', () => {
  describe('sendMessage', () => {
    it('streams text chunks from Vertex AI response', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: streamFrom([
          {candidates: [{content: {parts: [{text: 'Hello '}]}}]},
          {
            candidates: [{content: {parts: [{text: 'world'}]}, finishReason: 'STOP'}],
            usageMetadata: {promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7},
          },
        ]),
      });

      const provider = createVertexProvider(defaultConfig);
      const chunks = await collectChunks(provider.sendMessage(userMessage('hi')));

      expect(chunks).toEqual([
        {type: 'text', text: 'Hello '},
        {type: 'text', text: 'world'},
        {type: 'stop', stopReason: 'end_turn', usage: {inputTokens: 5, outputTokens: 2, totalTokens: 7}},
      ]);
    });

    it('yields tool_use chunks for function calls', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: streamFrom([
          {
            candidates: [
              {
                content: {
                  parts: [{functionCall: {name: 'get_weather', args: {city: 'Berlin'}}}],
                },
                finishReason: 'STOP',
                usageMetadata: {promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15},
              },
            ],
          },
        ]),
      });

      const provider = createVertexProvider(defaultConfig);
      const params = userMessage('weather in Berlin');
      params.tools = [
        {
          name: 'get_weather',
          description: 'Get weather',
          inputSchema: {type: 'object', properties: {city: {type: 'string'}}},
        },
      ];
      const chunks = await collectChunks(provider.sendMessage(params));

      expect(chunks[0]).toEqual({
        type: 'tool_use',
        toolCall: {id: 'get_weather', name: 'get_weather', input: {city: 'Berlin'}},
      });
    });

    it('maps MAX_TOKENS finish reason', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: streamFrom([{candidates: [{content: {parts: [{text: 'truncated'}]}, finishReason: 'MAX_TOKENS'}]}]),
      });

      const provider = createVertexProvider(defaultConfig);
      const chunks = await collectChunks(provider.sendMessage(userMessage('long request')));

      const stopChunk = chunks.find(c => c.type === 'stop');
      expect(stopChunk).toMatchObject({type: 'stop', stopReason: 'max_tokens'});
    });

    it('throws AIError with RATE_LIMITED on 429', async () => {
      mockGenerateContentStream.mockRejectedValue(new Error('429 Too Many Requests'));

      const provider = createVertexProvider(defaultConfig);
      await expect(collectChunks(provider.sendMessage(userMessage('test')))).rejects.toMatchObject({
        name: 'AIError',
        message: '429 Too Many Requests',
        code: 'RATE_LIMITED',
        retryable: true,
      });
    });

    it('throws AIError with AUTH_ERROR on permission denied', async () => {
      mockGenerateContentStream.mockRejectedValue(new Error('PERMISSION_DENIED'));

      const provider = createVertexProvider(defaultConfig);
      await expect(collectChunks(provider.sendMessage(userMessage('test')))).rejects.toMatchObject({
        name: 'AIError',
        message: 'PERMISSION_DENIED',
        code: 'AUTH_ERROR',
        retryable: false,
      });
    });

    it('falls back to PROVIDER_ERROR for a failure it cannot classify', async () => {
      mockGenerateContentStream.mockRejectedValue(new Error('something else went wrong'));

      const provider = createVertexProvider(defaultConfig);
      await expect(collectChunks(provider.sendMessage(userMessage('test')))).rejects.toMatchObject({
        name: 'AIError',
        message: 'something else went wrong',
        code: 'PROVIDER_ERROR',
        retryable: false,
      });
    });

    it('skips chunks with no candidate parts', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: streamFrom([
          {candidates: [{}]},
          {candidates: [{content: {parts: [{text: 'ok'}]}, finishReason: 'STOP'}]},
        ]),
      });

      const provider = createVertexProvider(defaultConfig);
      const chunks = await collectChunks(provider.sendMessage(userMessage('test')));

      expect(chunks).toEqual([
        {type: 'text', text: 'ok'},
        {type: 'stop', stopReason: 'end_turn', usage: undefined},
      ]);
    });

    it('maps assistant role to model for Vertex API', async () => {
      mockGenerateContentStream.mockResolvedValue({
        stream: streamFrom([{candidates: [{content: {parts: [{text: 'reply'}]}, finishReason: 'STOP'}]}]),
      });

      const provider = createVertexProvider(defaultConfig);
      await collectChunks(
        provider.sendMessage({
          messages: [
            {role: 'user', content: 'hello'},
            {role: 'assistant', content: 'hi there'},
            {role: 'user', content: 'follow up'},
          ],
          systemPrompt: 'test',
        })
      );

      const [[request]] = mockGenerateContentStream.mock.calls;
      const roles = request.contents.map((content: {role: string}) => content.role);
      expect(roles).toEqual(['user', 'model', 'user']);
    });
  });

  describe('generateStructured', () => {
    const evaluationSchema: ResponseSchema = {
      type: 'object',
      properties: {
        followUpQuestion: {type: 'string', description: 'A follow-up question'},
        confidenceScore: {type: 'number', description: 'Score from 0 to 100'},
      },
      required: ['followUpQuestion', 'confidenceScore'],
    };

    it('returns parsed JSON from Vertex response', async () => {
      const expected = {followUpQuestion: 'Tell me more?', confidenceScore: 85};
      mockGetGenerativeModel.mockReturnValue({
        generateContent: callMock().mockResolvedValue({
          response: {
            candidates: [{content: {parts: [{text: JSON.stringify(expected)}]}}],
          },
        }),
      });

      const provider = createVertexProvider(defaultConfig);
      const result = await provider.generateStructured<typeof expected>({
        messages: [{role: 'user', content: 'my answer'}],
        systemPrompt: 'evaluate the answer',
        responseSchema: evaluationSchema,
      });

      expect(result).toEqual(expected);
    });

    it('configures model with responseMimeType and responseSchema', async () => {
      mockGetGenerativeModel.mockReturnValue({
        generateContent: callMock().mockResolvedValue({
          response: {candidates: [{content: {parts: [{text: '{}'}]}}]},
        }),
      });

      const provider = createVertexProvider(defaultConfig);
      await provider.generateStructured({
        messages: [{role: 'user', content: 'test'}],
        systemPrompt: 'test',
        responseSchema: evaluationSchema,
      });

      const [, [modelConfig]] = mockGetGenerativeModel.mock.calls;
      expect(modelConfig.generationConfig).toMatchObject({
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            followUpQuestion: {type: 'STRING', description: 'A follow-up question'},
            confidenceScore: {type: 'NUMBER', description: 'Score from 0 to 100'},
          },
          required: ['followUpQuestion', 'confidenceScore'],
        },
      });
    });

    const requestEvaluation = (): Promise<unknown> =>
      createVertexProvider(defaultConfig).generateStructured({
        messages: [{role: 'user', content: 'test'}],
        systemPrompt: 'test',
        responseSchema: evaluationSchema,
      });

    it('throws AIError with PARSE_ERROR on invalid JSON', async () => {
      mockGetGenerativeModel.mockReturnValue({
        generateContent: callMock().mockResolvedValue({
          response: {candidates: [{content: {parts: [{text: 'not json'}]}}]},
        }),
      });

      await expect(requestEvaluation()).rejects.toMatchObject({
        name: 'AIError',
        message: 'Failed to parse structured response as JSON',
        code: 'PARSE_ERROR',
      });
    });

    it('throws mapped AIError on Vertex API failure', async () => {
      mockGetGenerativeModel.mockReturnValue({
        generateContent: callMock().mockRejectedValue(new Error('RESOURCE_EXHAUSTED')),
      });

      await expect(requestEvaluation()).rejects.toMatchObject({
        name: 'AIError',
        message: 'RESOURCE_EXHAUSTED',
        code: 'RATE_LIMITED',
        retryable: true,
      });
    });
  });
});
