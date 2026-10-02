import {jest} from '@jest/globals';
import type {MessageChunk, ResponseSchema} from '../../types/ai.js';
import {collectAbortingAfter, collectChunks, userMessage} from '../providerTestSupport.js';

// @jest/globals types a bare jest.fn() as taking no arguments; these name what the assertions read back.
interface VertexRequest {
  contents: {role: string}[];
}
interface VertexModelConfig {
  generationConfig?: Record<string, unknown>;
}
interface VertexInit {
  project: string;
  location: string;
  apiEndpoint?: string;
  googleAuthOptions?: Record<string, unknown>;
}

const mockGenerateContentStream = jest.fn<(request: VertexRequest) => Promise<unknown>>();
const mockGenerateContent = jest.fn<(request: VertexRequest) => Promise<unknown>>();
const mockGetGenerativeModel = jest.fn<(config: VertexModelConfig) => unknown>();
const mockVertexAI = jest
  .fn<(init: VertexInit) => unknown>()
  .mockImplementation(() => ({getGenerativeModel: mockGetGenerativeModel}));

const callMock = () => jest.fn<(request: VertexRequest) => Promise<unknown>>();

// createRequire never reaches jest's ESM registry, so the helper is the seam, not the package.
jest.unstable_mockModule('../requireOptionalPeer.js', () => ({
  requireOptionalPeer: () => ({VertexAI: mockVertexAI}),
}));

const {createVertexProvider} = await import('./vertexProvider.js');
type VertexConfig = import('./vertexProvider.js').VertexConfig;

const defaultConfig: VertexConfig = {
  type: 'vertex',
  projectId: 'test-project',
  location: 'europe-west4',
  modelId: 'gemini-2.5-flash',
  maxTokens: 1024,
};

// The SDK's own shape: the stream, plus the promise it drains a copy of that stream into.
function streamResult(responses: Record<string, unknown>[], response: Promise<unknown> = Promise.resolve({})) {
  return {stream: streamFrom(responses), response};
}

async function* streamFrom(responses: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
  for (const r of responses) {
    yield r;
  }
}

const textChunk = (text: string): Record<string, unknown> => ({candidates: [{content: {parts: [{text}]}}]});
const CALL = {functionCall: {name: 'lookup', args: {query: 'status'}}};
const USAGE = {promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15};

// Serves `result` as the SDK's answer to a consumer that aborts as soon as the first chunk arrives.
function abortAfterFirstChunk(result: Promise<unknown>): Promise<MessageChunk[]> {
  mockGenerateContentStream.mockReturnValueOnce(result);
  const controller = new AbortController();
  const stream = createVertexProvider(defaultConfig).sendMessage({...userMessage('count'), signal: controller.signal});
  return collectAbortingAfter(stream, controller, 1);
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
      mockGenerateContentStream.mockResolvedValue(
        streamResult([
          {candidates: [{content: {parts: [{text: 'Hello '}]}}]},
          {
            candidates: [{content: {parts: [{text: 'world'}]}, finishReason: 'STOP'}],
            usageMetadata: {promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7},
          },
        ])
      );

      const provider = createVertexProvider(defaultConfig);
      const chunks = await collectChunks(provider.sendMessage(userMessage('hi')));

      expect(chunks).toEqual([
        {type: 'text', text: 'Hello '},
        {type: 'text', text: 'world'},
        {type: 'stop', stopReason: 'end_turn', usage: {inputTokens: 5, outputTokens: 2, totalTokens: 7}},
      ]);
    });

    it('yields a tool_use chunk for a function call and ends the turn tool_use, with its usage', async () => {
      mockGenerateContentStream.mockResolvedValue(
        streamResult([{candidates: [{content: {parts: [CALL]}, finishReason: 'STOP'}], usageMetadata: USAGE}])
      );

      const chunks = await collectChunks(createVertexProvider(defaultConfig).sendMessage(userMessage('look it up')));

      expect(chunks).toEqual([
        {type: 'tool_use', toolCall: {id: 'lookup', name: 'lookup', input: {query: 'status'}}},
        {type: 'stop', stopReason: 'tool_use', usage: {inputTokens: 10, outputTokens: 5, totalTokens: 15}},
      ]);
    });

    it('maps MAX_TOKENS finish reason', async () => {
      mockGenerateContentStream.mockResolvedValue(
        streamResult([{candidates: [{content: {parts: [{text: 'truncated'}]}, finishReason: 'MAX_TOKENS'}]}])
      );

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
      mockGenerateContentStream.mockResolvedValue(
        streamResult([{candidates: [{}]}, {candidates: [{content: {parts: [{text: 'ok'}]}, finishReason: 'STOP'}]}])
      );

      const provider = createVertexProvider(defaultConfig);
      const chunks = await collectChunks(provider.sendMessage(userMessage('test')));

      expect(chunks).toEqual([
        {type: 'text', text: 'ok'},
        {type: 'stop', stopReason: 'end_turn', usage: undefined},
      ]);
    });

    it('maps assistant role to model for Vertex API', async () => {
      mockGenerateContentStream.mockResolvedValue(
        streamResult([{candidates: [{content: {parts: [{text: 'reply'}]}, finishReason: 'STOP'}]}])
      );

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

    it('stops yielding once its signal aborts between chunks, so an abort after the first of three leaves one', async () => {
      const received = await abortAfterFirstChunk(
        Promise.resolve(streamResult([textChunk('one '), textChunk('two '), textChunk('three')]))
      );

      expect(received).toEqual([{type: 'text', text: 'one '}]);
    });

    it('raises no AIError when the stream fails after its signal aborted', async () => {
      async function* failsAfterFirst(): AsyncGenerator<Record<string, unknown>> {
        yield textChunk('one ');
        throw new Error('socket hang up');
      }

      const received = await abortAfterFirstChunk(
        Promise.resolve({stream: failsAfterFirst(), response: Promise.resolve({})})
      );

      expect(received).toEqual([{type: 'text', text: 'one '}]);
    });

    it('sends nothing to Vertex when its signal is already aborted', async () => {
      const provider = createVertexProvider(defaultConfig);
      const chunks = await collectChunks(provider.sendMessage({...userMessage('hi'), signal: AbortSignal.abort()}));

      const {calls} = mockGenerateContentStream.mock;
      expect({chunks, requests: calls.length}).toEqual({chunks: [], requests: 0});
    });

    it('observes the SDK response promise, so its rejection never becomes an unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const record = (reason: unknown) => void unhandled.push(reason);
      process.on('unhandledRejection', record);
      mockGenerateContentStream.mockImplementationOnce(async () =>
        streamResult([textChunk('partial')], Promise.reject(new Error('the drained copy failed')))
      );

      const provider = createVertexProvider(defaultConfig);
      const chunks = await collectChunks(provider.sendMessage(userMessage('hi')));
      await new Promise(resolve => setTimeout(resolve, 20));
      process.off('unhandledRejection', record);

      expect({chunks, unhandled: unhandled.length}).toEqual({
        chunks: [
          {type: 'text', text: 'partial'},
          {type: 'stop', stopReason: 'end_turn', usage: undefined},
        ],
        unhandled: 0,
      });
    });

    it('ends a truncated function-call turn max_tokens, so the loop never runs its call', async () => {
      mockGenerateContentStream.mockResolvedValue(
        streamResult([{candidates: [{content: {parts: [CALL]}, finishReason: 'MAX_TOKENS'}]}])
      );

      const chunks = await collectChunks(createVertexProvider(defaultConfig).sendMessage(userMessage('look it up')));

      expect(chunks.at(-1)).toEqual({type: 'stop', stopReason: 'max_tokens', usage: undefined});
    });

    it('ends a stream that names no finish reason with one stop chunk: tool_use after a call, end_turn after text', async () => {
      mockGenerateContentStream
        .mockResolvedValueOnce(
          streamResult([{candidates: [{content: {parts: [CALL]}}], usageMetadata: USAGE}, {candidates: [{}]}])
        )
        .mockResolvedValueOnce(streamResult([textChunk('Done.')]));
      const provider = createVertexProvider(defaultConfig);

      const afterCall = await collectChunks(provider.sendMessage(userMessage('look it up')));
      const afterText = await collectChunks(provider.sendMessage(userMessage('say it')));

      expect({afterCall: afterCall.slice(1), afterText: afterText.slice(1)}).toEqual({
        afterCall: [{type: 'stop', stopReason: 'tool_use', usage: {inputTokens: 10, outputTokens: 5, totalTokens: 15}}],
        afterText: [{type: 'stop', stopReason: 'end_turn', usage: undefined}],
      });
    });

    it('ends the turn at the first finish reason, so a second one adds no stop chunk', async () => {
      mockGenerateContentStream.mockResolvedValue(
        streamResult([
          {candidates: [{content: {parts: [{text: 'one'}]}, finishReason: 'STOP'}]},
          {candidates: [{content: {parts: [{text: 'two'}]}, finishReason: 'STOP'}]},
        ])
      );

      const chunks = await collectChunks(createVertexProvider(defaultConfig).sendMessage(userMessage('say it')));

      expect(chunks).toEqual([
        {type: 'text', text: 'one'},
        {type: 'stop', stopReason: 'end_turn', usage: undefined},
      ]);
    });

    it('adds no stop chunk to a stream whose signal aborted as it ended', async () => {
      const received = await abortAfterFirstChunk(Promise.resolve(streamResult([textChunk('only')])));

      expect(received).toEqual([{type: 'text', text: 'only'}]);
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

  describe('endpoint selection', () => {
    it('forwards apiEndpoint to the VertexAI constructor for the eu multi-region', () => {
      createVertexProvider({
        type: 'vertex',
        projectId: 'test-project',
        location: 'eu',
        apiEndpoint: 'aiplatform.eu.rep.googleapis.com',
        modelId: 'gemini-3-pro',
      });
      const [[euInit]] = mockVertexAI.mock.calls;
      expect(euInit).toMatchObject({location: 'eu', apiEndpoint: 'aiplatform.eu.rep.googleapis.com'});
    });

    it('omits apiEndpoint when unset so single-region deployments are unchanged', () => {
      createVertexProvider(defaultConfig);
      const [[defaultInit]] = mockVertexAI.mock.calls;
      expect(defaultInit).not.toHaveProperty('apiEndpoint');
    });
  });
});
