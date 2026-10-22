import type {NextFunction, RequestHandler, Response} from 'express';
import type {AuthenticatedRequest} from '../types/auth.js';
import {ErrorCodes} from '../types/session.js';
import {log} from '../shared/logger.js';

/** One user's request budget: `limit` requests per `windowMs` sustained, `burst` of them at once (specs/hal-engine-rate-limit/spec.md). */
export interface RateLimitConfig {
  limit?: number;
  windowMs?: number;
  burst?: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Milliseconds until one more request would be allowed; 0 when allowed. */
  retryAfterMs: number;
}

export interface RateLimiter {
  consume(key: string): RateLimitVerdict;
}

/** One message every three seconds sustained and five at once: above a human typing, below a loop. No production evidence behind it yet. */
export const DEFAULT_RATE_LIMIT: Required<RateLimitConfig> = {limit: 20, windowMs: 60_000, burst: 5};

export const TOO_MANY_REQUESTS_MESSAGE = 'Too many requests, please slow down';

const MS_PER_SECOND = 1000;

interface Bucket {
  tokens: number;
  refilledAt: number;
}

/** A token bucket per key, in memory only: a key idle for a whole window is dropped, since a full bucket and a missing one answer alike. */
export function createRateLimiter(config: RateLimitConfig = {}, now: () => number = Date.now): RateLimiter {
  const {limit, windowMs, burst} = {...DEFAULT_RATE_LIMIT, ...config};
  if (!(limit > 0 && windowMs > 0 && burst > 0)) {
    throw new Error('transport.rateLimit: limit, windowMs and burst must each be a positive number');
  }
  const msPerToken = windowMs / limit;
  const buckets = new Map<string, Bucket>();
  let prunedAt = now();

  const pruneIdle = (at: number): void => {
    if (at - prunedAt < windowMs) return;
    prunedAt = at;
    for (const [key, bucket] of buckets) {
      if (at - bucket.refilledAt >= windowMs) buckets.delete(key);
    }
  };

  return {
    consume(key) {
      const at = now();
      pruneIdle(at);
      const held = buckets.get(key) ?? {tokens: burst, refilledAt: at};
      const tokens = Math.min(burst, held.tokens + (at - held.refilledAt) / msPerToken);
      if (tokens >= 1) {
        buckets.set(key, {tokens: tokens - 1, refilledAt: at});
        return {allowed: true, retryAfterMs: 0};
      }
      buckets.set(key, {tokens, refilledAt: at});
      return {allowed: false, retryAfterMs: Math.ceil((1 - tokens) * msPerToken)};
    },
  };
}

/** The engine's limiter from `transport.rateLimit`: the defaults when unset, none when `false`. */
export function rateLimiterFrom(setting: RateLimitConfig | false | undefined): RateLimiter | undefined {
  return setting === false ? undefined : createRateLimiter(setting);
}

/** The user when auth ran before the limiter, else the remote address; never the address for a known user, since an office shares one. */
export function rateLimitKey(req: AuthenticatedRequest): string {
  const user = req.user?.id;
  return user === undefined ? `address:${req.ip ?? 'unknown'}` : `user:${String(user)}`;
}

/** Answers a refused request 429 with `Retry-After` in whole seconds; the log line carries the wait alone, never the key. */
export function rateLimitMiddleware(limiter: RateLimiter): RequestHandler {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const verdict = limiter.consume(rateLimitKey(req));
    if (verdict.allowed) return next();
    log.warn('rateLimit', 'request refused: too many requests', {retryAfterMs: verdict.retryAfterMs});
    res.set('Retry-After', String(Math.ceil(verdict.retryAfterMs / MS_PER_SECOND)));
    res.status(429).json({
      error: TOO_MANY_REQUESTS_MESSAGE,
      code: ErrorCodes.TOO_MANY_REQUESTS,
      retryAfterMs: verdict.retryAfterMs,
    });
  };
}
