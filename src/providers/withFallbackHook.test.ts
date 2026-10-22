import {jest} from '@jest/globals';
import {withFallback} from './withFallback.js';
import type {FailoverEvent} from './withFallback.js';
import {AIError} from '../types/ai.js';
import type {AIProvider, MessageChunk, SendMessageParams} from '../types/ai.js';
import {setLogger} from '../shared/logger.js';
import {collectChunks, userMessage} from './providerTestSupport.js';

// specs/hal-engine-architecture § withFallback

const text = (value: string): MessageChunk => ({type: 'text', text: value});
const STOP: MessageChunk = {type: 'stop', stopReason: 'end_turn'};
const PRIMARY_MS = 250;

const outage = (code: string) => new AIError(`${code} at the vendor`, code);

// A provider that spends PRIMARY_MS of fake time and then throws `failWith`, or answers `chunks` at once.
function scripted(chunks: MessageChunk[], failWith?: unknown, structured = 'structured answer'): AIProvider {
  const sendMessage = jest.fn(async function* (_params: SendMessageParams): AsyncGenerator<MessageChunk> {
    if (failWith !== undefined) {
      jest.advanceTimersByTime(PRIMARY_MS);
      throw failWith;
    }
    yield* chunks;
  });
  const generateStructured = jest.fn(async () => {
    if (failWith !== undefined) throw failWith;
    return structured;
  });
  return {sendMessage, generateStructured} as unknown as AIProvider;
}

const events: FailoverEvent[] = [];
const errors: Array<Record<string, unknown>> = [];
const quiet = () => undefined;
const recordEvent = (event: FailoverEvent) => void events.push(event);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-22T12:00:00.000Z'));
  events.length = 0;
  errors.length = 0;
  setLogger({
    debug: quiet,
    info: quiet,
    warn: quiet,
    error: (category, message, fields) => void errors.push({category, message, ...fields}),
  });
});

afterEach(() => {
  jest.useRealTimers();
  setLogger();
});

describe('FallbackPolicy.onFailover', () => {
  it('is called once with failed vertex, next bedrock, code SERVICE_UNAVAILABLE and elapsedMs 250 when the primary throws before its first chunk', async () => {
    const stream = withFallback(scripted([], outage('SERVICE_UNAVAILABLE')), [scripted([text('ok'), STOP])], {
      labels: ['vertex', 'bedrock'],
      onFailover: recordEvent,
    }).sendMessage(userMessage('hej'));

    const chunks = await collectChunks(stream);

    expect({events, chunks}).toEqual({
      events: [{failed: 'vertex', next: 'bedrock', code: 'SERVICE_UNAVAILABLE', elapsedMs: PRIMARY_MS}],
      chunks: [text('ok'), STOP],
    });
  });

  it('names the providers by 1-based position when the policy has no labels: failed 1, next 2', async () => {
    const stream = withFallback(scripted([], outage('TIMEOUT')), [scripted([STOP])], {
      onFailover: recordEvent,
    }).sendMessage(userMessage('hej'));

    await collectChunks(stream);

    expect(events).toEqual([{failed: '1', next: '2', code: 'TIMEOUT', elapsedMs: PRIMARY_MS}]);
  });

  it("keeps the fallback's answer and logs one error line under provider when the hook throws", async () => {
    const stream = withFallback(scripted([], outage('SERVICE_UNAVAILABLE')), [scripted([text('ok'), STOP])], {
      onFailover: () => {
        throw new TypeError('hook broke');
      },
    }).sendMessage(userMessage('hej'));

    const chunks = await collectChunks(stream);

    expect({chunks, errors}).toEqual({
      chunks: [text('ok'), STOP],
      errors: [{category: 'provider', message: 'onFailover hook threw', error: 'TypeError'}],
    });
  });

  it('is called zero times on AUTH_ERROR, a configuration fault that never fails over', async () => {
    const stream = withFallback(scripted([], outage('AUTH_ERROR')), [scripted([STOP])], {
      onFailover: recordEvent,
    }).sendMessage(userMessage('hej'));

    const outcome = await collectChunks(stream).then(
      () => 'answered',
      (error: AIError) => error.code
    );

    expect({outcome, events}).toEqual({outcome: 'AUTH_ERROR', events: []});
  });

  it('is called under the same rule by generateStructured: once on TIMEOUT, and the fallback answers', async () => {
    const provider = withFallback(scripted([], outage('TIMEOUT')), [scripted([])], {
      labels: ['vertex', 'mock'],
      onFailover: recordEvent,
    });

    const answer = await provider.generateStructured({prompt: 'summarise', schema: {}} as never);

    expect({answer, events}).toEqual({
      answer: 'structured answer',
      events: [{failed: 'vertex', next: 'mock', code: 'TIMEOUT', elapsedMs: 0}],
    });
  });
});
