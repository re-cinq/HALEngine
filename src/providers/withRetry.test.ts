import {jest} from '@jest/globals';
import {withRetry} from './withRetry.js';
import type {AIProvider, MessageChunk, SendMessageParams, StructuredOutputParams} from '../types/ai.js';
import {AIError} from '../types/ai.js';
import {collectChunks, userMessage} from './providerTestSupport.js';

// The rejection is needed as a value rather than a matcher for a single structured assertion.
const rejectionOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => null,
    error => error
  );

const textOf = (chunks: MessageChunk[]): string =>
  chunks
    .filter(c => c.type === 'text')
    .map(c => (c.type === 'text' ? c.text : ''))
    .join('');

async function* successStream(): AsyncGenerator<MessageChunk> {
  yield {type: 'text', text: 'recovered'};
  yield {type: 'stop', stopReason: 'end_turn'};
}

const noopGenerateStructured = async <T>(_params: StructuredOutputParams<T>): Promise<T> => {
  throw new AIError('unused', 'UNUSED');
};

describe('withRetry', () => {
  it('retries a retryable failure and streams the eventual success, calling the provider three times', async () => {
    let calls = 0;
    const provider: AIProvider = {
      async *sendMessage(_params: SendMessageParams): AsyncGenerator<MessageChunk> {
        calls++;
        // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
        if (calls < 3) throw new AIError('rate limited', 'RATE_LIMIT', true);
        yield* successStream();
      },
      generateStructured: noopGenerateStructured,
    };

    const wrapped = withRetry(provider, {baseDelayMs: 0, maxDelayMs: 0});
    const chunks = await collectChunks(wrapped.sendMessage(userMessage('hi')));

    expect({text: textOf(chunks), calls}).toEqual({text: 'recovered', calls: 3});
  });

  it('does not retry a non-retryable failure and propagates the same error unchanged', async () => {
    let calls = 0;
    // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
    const boom = new AIError('bad request', 'INVALID', false);
    const provider: AIProvider = {
      async *sendMessage(_params: SendMessageParams): AsyncGenerator<MessageChunk> {
        yield* [] as MessageChunk[];
        calls++;
        throw boom;
      },
      async generateStructured<T>(): Promise<T> {
        throw boom;
      },
    };

    const wrapped = withRetry(provider, {baseDelayMs: 0});
    const caught = await rejectionOf(collectChunks(wrapped.sendMessage(userMessage('hi'))));

    expect({
      isAiError: caught instanceof AIError,
      code: caught instanceof AIError ? caught.code : null,
      sameInstance: caught === boom,
      calls,
    }).toEqual({isAiError: true, code: 'INVALID', sameInstance: true, calls: 1});
  });

  it('does not retry once the first chunk has been handed off, even on a retryable failure', async () => {
    let calls = 0;
    const provider: AIProvider = {
      async *sendMessage(_params: SendMessageParams): AsyncGenerator<MessageChunk> {
        calls++;
        yield {type: 'text', text: 'partial'};
        // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
        throw new AIError('stream broke mid-flight', 'STREAM', true);
      },
      generateStructured: noopGenerateStructured,
    };

    const wrapped = withRetry(provider, {baseDelayMs: 0});
    const received: string[] = [];
    let thrown: unknown = null;
    try {
      for await (const chunk of wrapped.sendMessage(userMessage('hi'))) {
        if (chunk.type === 'text') received.push(chunk.text);
      }
    } catch (error) {
      thrown = error;
    }

    expect({received, calls, retryable: thrown instanceof AIError && thrown.retryable}).toEqual({
      received: ['partial'],
      calls: 1,
      retryable: true,
    });
  });

  it('gives up after maxAttempts and throws an AIError carrying the last attempt code', async () => {
    let calls = 0;
    const provider: AIProvider = {
      async *sendMessage(_params: SendMessageParams): AsyncGenerator<MessageChunk> {
        yield* [] as MessageChunk[];
        calls++;
        // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
        throw new AIError(`attempt ${calls} failed`, `CODE_${calls}`, true);
      },
      generateStructured: noopGenerateStructured,
    };

    const wrapped = withRetry(provider, {maxAttempts: 3, baseDelayMs: 0});
    const caught = await rejectionOf(collectChunks(wrapped.sendMessage(userMessage('hi'))));

    expect({
      isError: caught instanceof Error,
      isAiError: caught instanceof AIError,
      code: caught instanceof AIError ? caught.code : null,
      calls,
    }).toEqual({isError: true, isAiError: true, code: 'CODE_3', calls: 3});
  });

  it('abandons an attempt whose first chunk never arrives, calls return on it, and retries', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      let returned = false;
      let release = (): void => {};
      const firstChunkArrives = new Promise<void>(resolve => {
        release = resolve;
      });
      const provider: AIProvider = {
        async *sendMessage(_params: SendMessageParams): AsyncGenerator<MessageChunk> {
          calls++;
          if (calls === 1) {
            try {
              await firstChunkArrives;
              yield {type: 'text', text: 'late'};
            } finally {
              returned = true;
            }
            return;
          }
          yield* successStream();
        },
        generateStructured: noopGenerateStructured,
      };

      const wrapped = withRetry(provider, {firstChunkTimeoutMs: 1000, baseDelayMs: 0});
      const collected = collectChunks(wrapped.sendMessage(userMessage('hi')));
      await jest.advanceTimersByTimeAsync(1000);
      release();
      await jest.runAllTimersAsync();
      const chunks = await collected;

      expect({text: textOf(chunks), calls, returned}).toEqual({text: 'recovered', calls: 2, returned: true});
    } finally {
      jest.useRealTimers();
    }
  });

  it('throws a TIMEOUT AIError without retrying when the stream stalls after its first chunk', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const provider: AIProvider = {
        async *sendMessage(_params: SendMessageParams): AsyncGenerator<MessageChunk> {
          calls++;
          yield {type: 'text', text: 'first'};
          await new Promise<never>(() => {});
          yield {type: 'text', text: 'never'};
        },
        generateStructured: noopGenerateStructured,
      };

      const wrapped = withRetry(provider, {idleChunkTimeoutMs: 1000, baseDelayMs: 0});
      const received: string[] = [];
      let thrown: unknown = null;
      const run = (async () => {
        try {
          for await (const chunk of wrapped.sendMessage(userMessage('hi'))) {
            if (chunk.type === 'text') received.push(chunk.text);
          }
        } catch (error) {
          thrown = error;
        }
      })();
      await jest.runAllTimersAsync();
      await run;

      expect({
        received,
        calls,
        isAiError: thrown instanceof AIError,
        code: thrown instanceof AIError ? thrown.code : null,
      }).toEqual({received: ['first'], calls: 1, isAiError: true, code: 'TIMEOUT'});
    } finally {
      jest.useRealTimers();
    }
  });

  it('backs off with full jitter, bounding attempt two to baseDelay and attempt three to twice it', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    try {
      let calls = 0;
      const provider: AIProvider = {
        async *sendMessage(_params: SendMessageParams): AsyncGenerator<MessageChunk> {
          yield* [] as MessageChunk[];
          calls++;
          // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
          throw new AIError('rate limited', 'RATE_LIMIT', true);
        },
        generateStructured: noopGenerateStructured,
      };

      const wrapped = withRetry(provider, {maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5000});
      const settled = rejectionOf(collectChunks(wrapped.sendMessage(userMessage('hi'))));
      await jest.runAllTimersAsync();
      const error = await settled;

      // Timeout timers use the 30000ms default; only the backoff waits fall at or below maxDelayMs.
      const backoff = setTimeoutSpy.mock.calls
        .map(call => call[1])
        .filter((ms): ms is number => typeof ms === 'number' && ms <= 5000);

      expect({
        isAiError: error instanceof AIError,
        attempts: calls,
        backoffCount: backoff.length,
        attempt1Within: backoff[0] !== undefined && backoff[0] >= 0 && backoff[0] <= 500,
        attempt2Within: backoff[1] !== undefined && backoff[1] >= 0 && backoff[1] <= 1000,
        noneOverMax: backoff.length === 0 || Math.max(...backoff) <= 5000,
      }).toEqual({
        isAiError: true,
        attempts: 3,
        backoffCount: 2,
        attempt1Within: true,
        attempt2Within: true,
        noneOverMax: true,
      });
    } finally {
      setTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('retries generateStructured under the same attempt-and-backoff loop', async () => {
    let calls = 0;
    const provider: AIProvider = {
      async *sendMessage(_params: SendMessageParams): AsyncGenerator<MessageChunk> {
        yield {type: 'stop', stopReason: 'end_turn'};
      },
      async generateStructured<T>(_params: StructuredOutputParams<T>): Promise<T> {
        calls++;
        // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
        if (calls < 3) throw new AIError('rate limited', 'RATE_LIMIT', true);
        return {ok: true} as T;
      },
    };

    const wrapped = withRetry(provider, {baseDelayMs: 0});
    const result = await wrapped.generateStructured<{ok: boolean}>({
      messages: [{role: 'user', content: 'decide'}],
      systemPrompt: 'test',
      responseSchema: {type: 'object', properties: {ok: {type: 'boolean'}}},
    });

    expect({result, calls}).toEqual({result: {ok: true}, calls: 3});
  });
});
