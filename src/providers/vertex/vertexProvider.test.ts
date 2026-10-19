import {jest} from '@jest/globals';
import type {MessageChunk, ResponseSchema} from '../../types/ai.js';
import {collectAbortingAfter, collectChunks, userMessage} from '../providerTestSupport.js';

// @jest/globals types a bare jest.fn() as taking no arguments; these name what the assertions read back.
interface GenaiRequest {
  model: string;
  contents: {role: string}[];
  config?: Record<string, unknown>;
}
interface GenaiInit {
  vertexai?: boolean;
  apiVersion?: string;
  project?: string;
  location?: string;
  httpOptions?: {baseUrl?: string};
  googleAuthOptions?: Record<string, unknown>;
}

const mockGenerateContentStream = jest.fn<(request: GenaiRequest) => Promise<unknown>>();
const mockGenerateContent = jest.fn<(request: GenaiRequest) => Promise<unknown>>();
const mockGoogleGenAI = jest.fn<(init: GenaiInit) => unknown>().mockImplementation(() => ({
  models: {generateContentStream: mockGenerateContentStream, generateContent: mockGenerateContent},
}));

// createRequire never reaches jest's ESM registry, so the helper is the seam, not the package.
jest.unstable_mockModule('../requireOptionalPeer.js', () => ({
  requireOptionalPeer: () => ({GoogleGenAI: mockGoogleGenAI}),
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

// The SDK resolves generateContentStream to the stream itself.
const streamResult = (responses: Record<string, unknown>[]) => streamFrom(responses);

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

    it("carries a function-call part's thoughtSignature sig-1 onto its tool_use chunk", async () => {
      mockGenerateContentStream.mockResolvedValue(
        streamResult([{candidates: [{content: {parts: [{...CALL, thoughtSignature: 'sig-1'}]}, finishReason: 'STOP'}]}])
      );

      const [first] = await collectChunks(createVertexProvider(defaultConfig).sendMessage(userMessage('look it up')));

      expect(first).toStrictEqual({
        type: 'tool_use',
        toolCall: {id: 'lookup', name: 'lookup', input: {query: 'status'}, signature: 'sig-1'},
      });
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

    it('passes any other finish reason on lower-cased, SAFETY as safety', async () => {
      mockGenerateContentStream.mockResolvedValue(
        streamResult([{candidates: [{content: {parts: [{text: 'blocked'}]}, finishReason: 'SAFETY'}]}])
      );

      const chunks = await collectChunks(createVertexProvider(defaultConfig).sendMessage(userMessage('hi')));

      expect(chunks.at(-1)).toEqual({type: 'stop', stopReason: 'safety', usage: undefined});
    });

    it('turns a function call that carries no arguments into a tool_use chunk with an empty input', async () => {
      mockGenerateContentStream.mockResolvedValue(
        streamResult([{candidates: [{content: {parts: [{functionCall: {name: 'ping'}}]}, finishReason: 'STOP'}]}])
      );

      const [first] = await collectChunks(createVertexProvider(defaultConfig).sendMessage(userMessage('ping it')));

      expect(first).toStrictEqual({type: 'tool_use', toolCall: {id: 'ping', name: 'ping', input: {}}});
    });

    it("maps a rejection that is no Error, the string 'boom', to PROVIDER_ERROR naming an unknown Vertex AI error", async () => {
      mockGenerateContentStream.mockRejectedValue('boom');

      await expect(
        collectChunks(createVertexProvider(defaultConfig).sendMessage(userMessage('hi')))
      ).rejects.toMatchObject({
        name: 'AIError',
        message: 'Unknown Vertex AI error',
        code: 'PROVIDER_ERROR',
      });
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

      const received = await abortAfterFirstChunk(Promise.resolve(failsAfterFirst()));

      expect(received).toEqual([{type: 'text', text: 'one '}]);
    });

    it('sends nothing to Vertex when its signal is already aborted', async () => {
      const provider = createVertexProvider(defaultConfig);
      const chunks = await collectChunks(provider.sendMessage({...userMessage('hi'), signal: AbortSignal.abort()}));

      const {calls} = mockGenerateContentStream.mock;
      expect({chunks, requests: calls.length}).toEqual({chunks: [], requests: 0});
    });

    it('raises one PROVIDER_ERROR after the chunk already read when the stream fails mid-way, and no unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const record = (reason: unknown) => void unhandled.push(reason);
      process.on('unhandledRejection', record);
      async function* failsMidway(): AsyncGenerator<Record<string, unknown>> {
        yield textChunk('partial');
        throw Object.assign(new Error('{"error":{"code":500,"status":"INTERNAL"}}'), {status: 500});
      }
      mockGenerateContentStream.mockResolvedValueOnce(failsMidway());

      const received: MessageChunk[] = [];
      let raised: unknown;
      try {
        for await (const chunk of createVertexProvider(defaultConfig).sendMessage(userMessage('hi')))
          received.push(chunk);
      } catch (error) {
        raised = error;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
      process.off('unhandledRejection', record);

      expect({received, raised, unhandled: unhandled.length}).toMatchObject({
        received: [{type: 'text', text: 'partial'}],
        raised: {name: 'AIError', code: 'PROVIDER_ERROR'},
        unhandled: 0,
      });
    });

    it('hands its abort signal to the SDK, so an abort closes the request rather than only the read', async () => {
      mockGenerateContentStream.mockResolvedValue(streamResult([textChunk('ok')]));
      const controller = new AbortController();

      await collectChunks(
        createVertexProvider(defaultConfig).sendMessage({...userMessage('hi'), signal: controller.signal})
      );

      const [[request]] = mockGenerateContentStream.mock.calls;
      expect(request.config?.abortSignal).toBe(controller.signal);
    });

    it('sends the model, the system prompt, the tools and the configured max tokens in one request', async () => {
      mockGenerateContentStream.mockResolvedValue(streamResult([textChunk('ok')]));
      const tool = {name: 'lookup', description: 'Looks it up.', inputSchema: {type: 'object', properties: {}}};

      await collectChunks(createVertexProvider(defaultConfig).sendMessage({...userMessage('hi'), tools: [tool]}));

      const [[request]] = mockGenerateContentStream.mock.calls;
      expect(request).toEqual({
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'hi'}]}],
        config: {
          systemInstruction: 'You are helpful.',
          maxOutputTokens: 1024,
          tools: [
            {functionDeclarations: [{name: 'lookup', description: 'Looks it up.', parameters: tool.inputSchema}]},
          ],
        },
      });
    });

    it('maps a failure by its HTTP status when its message names no code: 429 to RATE_LIMITED, 403 to AUTH_ERROR', async () => {
      mockGenerateContentStream
        .mockRejectedValueOnce(Object.assign(new Error('quota'), {status: 429}))
        .mockRejectedValueOnce(Object.assign(new Error('denied'), {status: 403}));
      const provider = createVertexProvider(defaultConfig);

      const codes = [];
      for (const _ of [1, 2]) {
        codes.push(
          await collectChunks(provider.sendMessage(userMessage('hi'))).catch((error: {code: string}) => error.code)
        );
      }

      expect(codes).toEqual(['RATE_LIMITED', 'AUTH_ERROR']);
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
      mockGenerateContent.mockResolvedValue({candidates: [{content: {parts: [{text: JSON.stringify(expected)}]}}]});

      const provider = createVertexProvider(defaultConfig);
      const result = await provider.generateStructured<typeof expected>({
        messages: [{role: 'user', content: 'my answer'}],
        systemPrompt: 'evaluate the answer',
        responseSchema: evaluationSchema,
      });

      expect(result).toEqual(expected);
    });

    it('configures the request with responseMimeType and responseSchema', async () => {
      mockGenerateContent.mockResolvedValue({candidates: [{content: {parts: [{text: '{}'}]}}]});

      const provider = createVertexProvider(defaultConfig);
      await provider.generateStructured({
        messages: [{role: 'user', content: 'test'}],
        systemPrompt: 'test',
        responseSchema: evaluationSchema,
      });

      const [[request]] = mockGenerateContent.mock.calls;
      expect(request.config).toMatchObject({
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
      mockGenerateContent.mockResolvedValue({candidates: [{content: {parts: [{text: 'not json'}]}}]});

      await expect(requestEvaluation()).rejects.toMatchObject({
        name: 'AIError',
        message: 'Failed to parse structured response as JSON',
        code: 'PARSE_ERROR',
      });
    });

    it('raises PARSE_ERROR for a structured response with no candidates, which carries no JSON', async () => {
      mockGenerateContent.mockResolvedValue({});

      await expect(requestEvaluation()).rejects.toMatchObject({name: 'AIError', code: 'PARSE_ERROR'});
    });

    it('passes an enum and an array of items through the response schema, upper-casing the item type', async () => {
      mockGenerateContent.mockResolvedValue({candidates: [{content: {parts: [{text: '{}'}]}}]});

      await createVertexProvider(defaultConfig).generateStructured({
        messages: [{role: 'user', content: 'test'}],
        systemPrompt: 'test',
        responseSchema: {
          type: 'object',
          properties: {
            verdict: {type: 'string', enum: ['yes', 'no']},
            tags: {type: 'array', items: {type: 'string'}},
          },
        },
      });

      const [[request]] = mockGenerateContent.mock.calls;
      expect(request.config?.responseSchema).toEqual({
        type: 'OBJECT',
        properties: {
          verdict: {type: 'STRING', enum: ['yes', 'no']},
          tags: {type: 'ARRAY', items: {type: 'STRING'}},
        },
      });
    });

    it('throws mapped AIError on Vertex API failure', async () => {
      mockGenerateContent.mockRejectedValue(new Error('RESOURCE_EXHAUSTED'));

      await expect(requestEvaluation()).rejects.toMatchObject({
        name: 'AIError',
        message: 'RESOURCE_EXHAUSTED',
        code: 'RATE_LIMITED',
        retryable: true,
      });
    });
  });

  describe('endpoint selection', () => {
    it('creates the client in Vertex mode on the v1 API with the configured project, location and auth options', () => {
      createVertexProvider({...defaultConfig, googleAuthOptions: {keyFilename: 'key.json'}});
      const [[init]] = mockGoogleGenAI.mock.calls;
      expect(init).toEqual({
        vertexai: true,
        project: 'test-project',
        location: 'europe-west4',
        apiVersion: 'v1',
        googleAuthOptions: {keyFilename: 'key.json'},
      });
    });

    it('forwards apiEndpoint to the client as its base URL for the eu multi-region', () => {
      createVertexProvider({
        type: 'vertex',
        projectId: 'test-project',
        location: 'eu',
        apiEndpoint: 'aiplatform.eu.rep.googleapis.com',
        modelId: 'gemini-3-pro',
      });
      const [[euInit]] = mockGoogleGenAI.mock.calls;
      expect(euInit).toMatchObject({
        location: 'eu',
        httpOptions: {baseUrl: 'https://aiplatform.eu.rep.googleapis.com/'},
      });
    });

    it('omits apiEndpoint when unset so single-region deployments are unchanged', () => {
      createVertexProvider(defaultConfig);
      const [[defaultInit]] = mockGoogleGenAI.mock.calls;
      expect(defaultInit).not.toHaveProperty('httpOptions');
    });
  });
});
