import {jest} from '@jest/globals';
import {collectAbortingAfter, collectChunks, userMessage} from '../providerTestSupport.js';
import {setLogger} from '../../shared/logger.js';
import type {SendMessageParams} from '../../types/ai.js';

// @jest/globals types a bare jest.fn() as taking no arguments; this names what the assertions read back.
type Send = (command: unknown, options?: {abortSignal?: AbortSignal}) => Promise<unknown>;
const mockSend = jest.fn<Send>();

class FakeBedrockRuntimeClient {
  send = mockSend;
}

class FakeConverseStreamCommand {
  constructor(readonly input: unknown) {}
}

// createRequire never reaches jest's ESM registry, so the helper is the seam, not the package.
jest.unstable_mockModule('../requireOptionalPeer.js', () => ({
  requireOptionalPeer: () => ({
    BedrockRuntimeClient: FakeBedrockRuntimeClient,
    ConverseStreamCommand: FakeConverseStreamCommand,
  }),
}));

const {createBedrockProvider} = await import('./bedrockProvider.js');

const MODEL_ID = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';

const provider = () =>
  createBedrockProvider({type: 'bedrock', modelId: MODEL_ID, region: 'eu-west-1', maxTokens: 1024});

async function* textEvents(...texts: string[]): AsyncGenerator<Record<string, unknown>> {
  for (const text of texts) {
    yield {contentBlockDelta: {contentBlockIndex: 0, delta: {text}}};
  }
}

// What the SDK's handler does with an abortSignal: the pending send rejects once the signal aborts.
const sendRejectingOnAbort: Send = (_command, options) =>
  new Promise((_resolve, reject) => {
    options?.abortSignal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('Request aborted'), {name: 'AbortError'}))
    );
  });

beforeEach(() => {
  mockSend.mockReset();
});

describe('createBedrockProvider', () => {
  describe('sendMessage', () => {
    it('passes params.signal to client.send as its abortSignal, the exact object it was given', async () => {
      mockSend.mockResolvedValue({});
      const controller = new AbortController();

      await collectChunks(provider().sendMessage({...userMessage('hi'), signal: controller.signal}));

      const [call] = mockSend.mock.calls;
      expect({argumentCount: call?.length, sameSignal: call?.[1]?.abortSignal === controller.signal}).toEqual({
        argumentCount: 2,
        sameSignal: true,
      });
    });

    it('sends a tool_use block carrying signature sig-1 to Bedrock as a toolUse without it', async () => {
      mockSend.mockResolvedValue({});

      await collectChunks(
        provider().sendMessage({
          messages: [
            {role: 'user', content: 'look it up'},
            {
              role: 'assistant',
              content: [{type: 'tool_use', toolUseId: 't1', name: 'lookup', input: {q: 'x'}, signature: 'sig-1'}],
            },
            {role: 'user', content: [{type: 'tool_result', toolUseId: 't1', content: 'found'}]},
          ],
          systemPrompt: 'test',
        })
      );

      const [[command]] = mockSend.mock.calls;
      const {input} = command as {input: {messages: unknown[]}};
      expect(input.messages[1]).toStrictEqual({
        role: 'assistant',
        content: [{toolUse: {toolUseId: 't1', name: 'lookup', input: {q: 'x'}}}],
      });
    });

    it("sends a failed tool_result with status 'error' to a Claude model and with no status to a Llama one", async () => {
      mockSend.mockResolvedValue({});
      const failed: SendMessageParams = {
        systemPrompt: 'test',
        messages: [
          {role: 'user', content: 'look it up'},
          {role: 'assistant', content: [{type: 'tool_use', toolUseId: 't1', name: 'lookup', input: {}}]},
          {role: 'user', content: [{type: 'tool_result', toolUseId: 't1', content: 'lookup failed', isError: true}]},
        ],
      };
      const llama = createBedrockProvider({
        type: 'bedrock',
        modelId: 'meta.llama3-70b-instruct-v1:0',
        region: 'eu-west-1',
        maxTokens: 1024,
      });

      await collectChunks(provider().sendMessage(failed));
      await collectChunks(llama.sendMessage(failed));

      const {calls} = mockSend.mock;
      const sentResults = calls.map(([command]) => {
        const {input} = command as {input: {messages: unknown[]}};
        return input.messages[2];
      });
      expect(sentResults).toStrictEqual([
        {role: 'user', content: [{toolResult: {toolUseId: 't1', content: [{text: 'lookup failed'}], status: 'error'}}]},
        {role: 'user', content: [{toolResult: {toolUseId: 't1', content: [{text: 'lookup failed'}]}}]},
      ]);
    });

    it('calls client.send with the command alone when no signal is given', async () => {
      mockSend.mockResolvedValue({});

      await collectChunks(provider().sendMessage(userMessage('hi')));

      const {calls} = mockSend.mock;
      expect(calls.map(call => call.length)).toEqual([1]);
    });

    it('ends the stream without an AIError when its signal aborts the request in flight, logging only that it aborted', async () => {
      mockSend.mockImplementation(sendRejectingOnAbort);
      const controller = new AbortController();
      const lines: Record<string, unknown>[] = [];
      const record = (level: string) => (category: string, message: string, fields?: Record<string, unknown>) =>
        void lines.push({level, category, message, ...fields});
      setLogger({debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error')});

      try {
        const chunks = collectChunks(provider().sendMessage({...userMessage('hi'), signal: controller.signal}));
        controller.abort();

        expect({chunks: await chunks, lines}).toEqual({
          chunks: [],
          lines: [
            {
              level: 'info',
              category: 'bedrock',
              message: 'sending message',
              modelId: MODEL_ID,
              messageCount: 1,
              hasTools: false,
            },
            {level: 'info', category: 'bedrock', message: 'request aborted'},
          ],
        });
      } finally {
        setLogger();
      }
    });

    it('yields nothing further once its signal aborts mid-stream, so an abort after the first of three leaves one', async () => {
      mockSend.mockResolvedValue({stream: textEvents('one ', 'two ', 'three')});
      const controller = new AbortController();
      const stream = provider().sendMessage({...userMessage('count'), signal: controller.signal});

      expect(await collectAbortingAfter(stream, controller, 1)).toEqual([{type: 'text', text: 'one '}]);
    });

    it('sends nothing to Bedrock when its signal is already aborted', async () => {
      const chunks = await collectChunks(provider().sendMessage({...userMessage('hi'), signal: AbortSignal.abort()}));

      const {calls} = mockSend.mock;
      expect({chunks, requests: calls.length}).toEqual({chunks: [], requests: 0});
    });
  });
});
