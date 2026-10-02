import type {AIProvider, MessageChunk, SendMessageParams, StructuredOutputParams} from '../types/ai.js';
import {AIError} from '../types/ai.js';
import {log} from '../shared/logger.js';

export interface RetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  firstChunkTimeoutMs?: number;
  idleChunkTimeoutMs?: number;
}

const DEFAULTS: Required<RetryPolicy> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  firstChunkTimeoutMs: 30000,
  idleChunkTimeoutMs: 30000,
};

export function withRetry(provider: AIProvider, policy: RetryPolicy = {}): AIProvider {
  const p: Required<RetryPolicy> = {...DEFAULTS, ...policy};

  return {
    async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
      let lastError: AIError | undefined;

      for (let attempt = 1; attempt <= p.maxAttempts; attempt++) {
        if (attempt > 1) await applyBackoff(attempt, lastError, p);

        const attemptControl = new AbortController();
        const iter = provider.sendMessage({...params, signal: attemptSignal(attemptControl, params.signal)});
        let firstChunkHandedOff = false;

        try {
          const firstTimeout = makeTimeout(p.firstChunkTimeoutMs);
          let firstResult: IteratorResult<MessageChunk>;
          try {
            firstResult = await Promise.race([iter.next(), firstTimeout.promise]);
            firstTimeout.cancel();
          } catch (err) {
            firstTimeout.cancel();
            if (!(err instanceof AIError)) throw err;
            if (err.code === 'TIMEOUT') {
              // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
              lastError = new AIError('first chunk timeout', 'TIMEOUT', true);
              continue;
            }
            if (!err.retryable) throw err;
            lastError = err;
            continue;
          }

          if (firstResult.done) return;

          firstChunkHandedOff = true;
          yield firstResult.value;
          yield* streamWithIdleTimeout(iter, p.idleChunkTimeoutMs);
          return;
        } catch (err) {
          if (firstChunkHandedOff) throw err;
          if (!(err instanceof AIError) || !err.retryable) throw err;
          lastError = err;
        } finally {
          // However the attempt ended (failed, timed out, finished or dropped by a consumer that stopped reading), it is released before the next starts.
          abandon(iter, attemptControl);
        }
      }

      throw lastError ?? new AIError('max attempts exhausted', 'RETRY_EXHAUSTED');
    },

    async generateStructured<T>(params: StructuredOutputParams<T>): Promise<T> {
      let lastError: AIError | undefined;

      for (let attempt = 1; attempt <= p.maxAttempts; attempt++) {
        if (attempt > 1) await applyBackoff(attempt, lastError, p);
        try {
          return await provider.generateStructured(params);
        } catch (err) {
          if (!(err instanceof AIError) || !err.retryable) throw err;
          lastError = err;
        }
      }

      throw lastError ?? new AIError('max attempts exhausted', 'RETRY_EXHAUSTED');
    },
  };
}

async function applyBackoff(attempt: number, lastError: AIError | undefined, p: Required<RetryPolicy>): Promise<void> {
  const wait = jitterDelay(attempt - 1, p);
  log.warn('withRetry', 'retrying provider call', {attempt, code: lastError?.code, delay: wait});
  await sleep(wait);
}

// The caller's own signal still reaches the provider: it is composed with the attempt's, never replaced by it.
function attemptSignal(attemptControl: AbortController, callerSignal: AbortSignal | undefined): AbortSignal {
  return callerSignal ? AbortSignal.any([callerSignal, attemptControl.signal]) : attemptControl.signal;
}

// Aborting first stops the vendor request of a provider that honours the signal and fires any once-listener it left; return() then releases the generator.
function abandon(iter: AsyncGenerator<MessageChunk>, attemptControl: AbortController): void {
  attemptControl.abort();
  void iter.return(undefined);
}

async function* streamWithIdleTimeout(
  iter: AsyncGenerator<MessageChunk>,
  idleChunkTimeoutMs: number
): AsyncGenerator<MessageChunk> {
  while (true) {
    const idleTimeout = makeTimeout(idleChunkTimeoutMs);
    let nextResult: IteratorResult<MessageChunk>;
    try {
      nextResult = await Promise.race([iter.next(), idleTimeout.promise]);
      idleTimeout.cancel();
    } catch (err) {
      idleTimeout.cancel();
      throw err;
    }
    if (nextResult.done) return;
    yield nextResult.value;
  }
}

function makeTimeout(ms: number): {promise: Promise<never>; cancel: () => void} {
  let cancel: () => void = () => {};
  const promise = new Promise<never>((_, reject) => {
    // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
    const id = setTimeout(() => reject(new AIError('chunk timeout', 'TIMEOUT', false)), ms);
    cancel = () => clearTimeout(id);
  });
  return {promise, cancel};
}

function jitterDelay(retryIndex: number, p: Required<RetryPolicy>): number {
  const cap = Math.min(p.maxDelayMs, p.baseDelayMs * Math.pow(2, retryIndex - 1));
  return Math.floor(Math.random() * (cap + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
