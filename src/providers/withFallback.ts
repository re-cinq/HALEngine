import type {AIProvider, MessageChunk, SendMessageParams, StructuredOutputParams} from '../types/ai.js';
import {AIError} from '../types/ai.js';
import {log} from '../shared/logger.js';

/** What a host learns of one failover: the two providers by label or position, the code that routed onward, and the time since the call began. */
export interface FailoverEvent {
  failed: string;
  next: string;
  code: string;
  elapsedMs: number;
}

/** How withFallback names the providers in its chain and whom it tells; nothing here changes which failures route onward. */
export interface FallbackPolicy {
  /** One label per provider, primary first, for the failover log line, such as each one's config `type`; unset, the position is logged alone. */
  labels?: readonly string[];
  /** Called once per failover, after the log line and before the next provider starts; a throw is logged once and changes nothing. */
  onFailover?: (event: FailoverEvent) => void | Promise<void>;
}

// The vendor is down or cannot say why it failed; a second vendor may well answer.
const OUTAGE_CODES: ReadonlySet<string> = new Set([
  'SERVICE_UNAVAILABLE',
  'TIMEOUT',
  'RATE_LIMITED',
  'BEDROCK_ERROR',
  'PROVIDER_ERROR',
  'UNKNOWN_ERROR',
]);
// The request or its credential is wrong, so a second vendor would fail the same way with the conversation sent twice.
const CONFIGURATION_FAULTS: ReadonlySet<string> = new Set(['AUTH_ERROR', 'ACCESS_DENIED', 'VALIDATION_ERROR']);

/** Tries `primary`, then each fallback in order, once each, on a vendor outage; never once a chunk has reached the caller. */
export function withFallback(
  primary: AIProvider,
  fallbacks: readonly AIProvider[],
  policy: FallbackPolicy = {}
): AIProvider {
  const chain = [primary, ...fallbacks];

  return {
    async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
      const startedAt = Date.now();
      let lastError: AIError | undefined;

      for (const [position, provider] of chain.entries()) {
        // An abort is the caller's decision: it never starts the next vendor, and a provider stops without raising.
        if (params.signal?.aborted) return;
        const iter = provider.sendMessage(params);
        try {
          let first: IteratorResult<MessageChunk>;
          try {
            first = await iter.next();
          } catch (error) {
            if (params.signal?.aborted) return;
            if (!failsOver(error)) throw error;
            lastError = error;
            await reportFailover(chain, position, error, policy, startedAt);
            continue;
          }
          if (first.done) return;
          // From here the turn belongs to this vendor: a later failure propagates rather than restarting the answer elsewhere.
          yield first.value;
          yield* iter;
          return;
        } finally {
          void iter.return(undefined);
        }
      }

      throw lastError;
    },

    async generateStructured<T>(params: StructuredOutputParams<T>): Promise<T> {
      const startedAt = Date.now();
      let lastError: AIError | undefined;

      for (const [position, provider] of chain.entries()) {
        try {
          return await provider.generateStructured(params);
        } catch (error) {
          if (!failsOver(error)) throw error;
          lastError = error;
          await reportFailover(chain, position, error, policy, startedAt);
        }
      }

      throw lastError;
    },
  };
}

// A retryable AIError has already spent the retry tier's attempts against this vendor, which is the outage signal itself.
function failsOver(error: unknown): error is AIError {
  if (!(error instanceof AIError)) return false;
  if (CONFIGURATION_FAULTS.has(error.code)) return false;
  return error.retryable || OUTAGE_CODES.has(error.code);
}

// Logged and reported only when a next provider is tried; the last failure reaches the caller instead, as the error it is.
async function reportFailover(
  chain: readonly AIProvider[],
  position: number,
  error: AIError,
  policy: FallbackPolicy,
  startedAt: number
): Promise<void> {
  if (position === chain.length - 1) return;
  log.warn('provider', 'failing over to the next provider', {
    failed: policy.labels?.[position] ?? null,
    code: error.code,
    position: position + 1,
    of: chain.length,
  });
  await notifyFailover(policy, failoverEvent(position, error, policy, startedAt));
}

// Labels when the policy has them, else the 1-based positions the log line prints, so a host and the log name the same provider.
function failoverEvent(position: number, error: AIError, policy: FallbackPolicy, startedAt: number): FailoverEvent {
  const nameOf = (index: number): string => policy.labels?.[index] ?? String(index + 1);
  return {failed: nameOf(position), next: nameOf(position + 1), code: error.code, elapsedMs: Date.now() - startedAt};
}

// A host's hook must not change which provider answers: its throw is logged once, never raised into the turn.
async function notifyFailover(policy: FallbackPolicy, event: FailoverEvent): Promise<void> {
  if (!policy.onFailover) return;
  try {
    await policy.onFailover(event);
  } catch (error) {
    log.error('provider', 'onFailover hook threw', {error: error instanceof Error ? error.name : 'unknown'});
  }
}
