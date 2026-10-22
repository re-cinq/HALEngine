import {jest} from '@jest/globals';
import {createRateLimiter, rateLimiterFrom} from './rateLimit.js';

// specs/hal-engine-rate-limit

const DEFAULTS = {limit: 20, windowMs: 60_000, burst: 5};
const REFILL_MS = 3000;
const FIVE_ALLOWED = [true, true, true, true, true];
const RATE_LIMIT_OFF = false as const;

const consumeTimes = (limiter: ReturnType<typeof createRateLimiter>, key: string, times: number) =>
  Array.from({length: times}, () => limiter.consume(key));

describe('createRateLimiter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-22T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows five immediate calls at {limit: 20, windowMs: 60000, burst: 5}, refuses the sixth with retryAfterMs 3000, and allows one more 3000 ms later', () => {
    const limiter = createRateLimiter(DEFAULTS);

    const first = consumeTimes(limiter, 'user:u1', 6);
    jest.advanceTimersByTime(REFILL_MS);
    const later = limiter.consume('user:u1');

    expect({first, later}).toEqual({
      first: [...Array(5).fill({allowed: true, retryAfterMs: 0}), {allowed: false, retryAfterMs: REFILL_MS}],
      later: {allowed: true, retryAfterMs: 0},
    });
  });

  it('keeps one key out of another: u2 is allowed right after u1 was refused', () => {
    const limiter = createRateLimiter(DEFAULTS);
    consumeTimes(limiter, 'user:u1', 6);

    expect(limiter.consume('user:u2')).toEqual({allowed: true, retryAfterMs: 0});
  });

  it('answers a key idle for a whole window as a new one: five allowed again after 60000 ms of silence', () => {
    const limiter = createRateLimiter(DEFAULTS);
    consumeTimes(limiter, 'user:u1', 6);
    jest.advanceTimersByTime(DEFAULTS.windowMs);

    expect(consumeTimes(limiter, 'user:u1', 6).map(verdict => verdict.allowed)).toEqual([...FIVE_ALLOWED, false]);
  });

  it('refuses a limit, window or burst that is not a positive number', () => {
    expect(() => createRateLimiter({burst: 0})).toThrow(
      'transport.rateLimit: limit, windowMs and burst must each be a positive number'
    );
  });
});

describe('rateLimiterFrom', () => {
  it('builds the default limiter, five at once, when transport.rateLimit is unset, and none when it is false', () => {
    const fromUnset = rateLimiterFrom(undefined);

    expect({
      unset: fromUnset && consumeTimes(fromUnset, 'user:u1', 6).map(verdict => verdict.allowed),
      off: rateLimiterFrom(RATE_LIMIT_OFF),
    }).toEqual({unset: [...FIVE_ALLOWED, false], off: undefined});
  });

  it('merges a partial setting with the defaults: {burst: 2} refuses the third immediate call', () => {
    const limiter = rateLimiterFrom({burst: 2});

    expect(limiter && consumeTimes(limiter, 'user:u1', 3).map(verdict => verdict.allowed)).toEqual([true, true, false]);
  });
});
