import {jest} from '@jest/globals';
import {withFallback} from './withFallback.js';
import {AIError} from '../types/ai.js';
import type {AIProvider, MessageChunk, SendMessageParams} from '../types/ai.js';
import {setLogger} from '../shared/logger.js';
import {collectChunks, userMessage} from './providerTestSupport.js';

const text = (value: string): MessageChunk => ({type: 'text', text: value});
const STOP: MessageChunk = {type: 'stop', stopReason: 'end_turn'};

interface Scripted {
  provider: AIProvider;
  calls: () => number;
  params: () => SendMessageParams[];
}

// A provider that yields `chunks` and then throws `failWith`, if given; it counts its calls and keeps what it was sent.
function scripted(chunks: MessageChunk[], failWith?: unknown, structured?: unknown): Scripted {
  const seen: SendMessageParams[] = [];
  const sendMessage = jest.fn(async function* (params: SendMessageParams): AsyncGenerator<MessageChunk> {
    seen.push(params);
    yield* chunks;
    if (failWith !== undefined) throw failWith;
  });
  const generateStructured = jest.fn(async () => {
    if (failWith !== undefined) throw failWith;
    return structured;
  });
  const provider = {sendMessage, generateStructured} as unknown as AIProvider;
  const {calls} = sendMessage.mock;
  return {provider, calls: () => calls.length, params: () => seen};
}

const outage = (code: string) => new AIError(`${code} at the vendor`, code);

const warnings: Array<Record<string, unknown>> = [];
const quiet = () => undefined;
beforeEach(() => {
  warnings.length = 0;
  setLogger({
    debug: quiet,
    info: quiet,
    warn: (category, message, fields) => void warnings.push({category, message, ...fields}),
    error: quiet,
  });
});
afterAll(() => setLogger());

describe('withFallback', () => {
  it("streams exactly the secondary's chunks when the primary throws SERVICE_UNAVAILABLE before its first chunk", async () => {
    const primary = scripted([], outage('SERVICE_UNAVAILABLE'));
    const secondary = scripted([text('from the secondary'), STOP]);

    const chunks = await collectChunks(
      withFallback(primary.provider, [secondary.provider]).sendMessage(userMessage('hi'))
    );

    expect({chunks, primaryCalls: primary.calls(), secondaryCalls: secondary.calls()}).toEqual({
      chunks: [text('from the secondary'), STOP],
      primaryCalls: 1,
      secondaryCalls: 1,
    });
  });

  it('does not fail over once a chunk has reached the caller: the chunk, then the throw, and the secondary uncalled', async () => {
    const failure = outage('SERVICE_UNAVAILABLE');
    const primary = scripted([text('half an answer')], failure);
    const secondary = scripted([text('never'), STOP]);
    const received: MessageChunk[] = [];
    let raised: unknown;

    try {
      for await (const chunk of withFallback(primary.provider, [secondary.provider]).sendMessage(userMessage('hi'))) {
        received.push(chunk);
      }
    } catch (error) {
      raised = error;
    }

    expect({received, sameError: raised === failure, secondaryCalls: secondary.calls()}).toEqual({
      received: [text('half an answer')],
      sameError: true,
      secondaryCalls: 0,
    });
  });

  it('propagates AUTH_ERROR, ACCESS_DENIED and VALIDATION_ERROR from the primary with the secondary uncalled', async () => {
    const outcomes = [];
    for (const code of ['AUTH_ERROR', 'ACCESS_DENIED', 'VALIDATION_ERROR']) {
      const failure = outage(code);
      const secondary = scripted([text('never'), STOP]);
      const stream = withFallback(scripted([], failure).provider, [secondary.provider]).sendMessage(userMessage('hi'));
      const raised = await collectChunks(stream).catch((error: unknown) => error);
      outcomes.push({code, sameError: raised === failure, secondaryCalls: secondary.calls()});
    }

    expect(outcomes).toEqual([
      {code: 'AUTH_ERROR', sameError: true, secondaryCalls: 0},
      {code: 'ACCESS_DENIED', sameError: true, secondaryCalls: 0},
      {code: 'VALIDATION_ERROR', sameError: true, secondaryCalls: 0},
    ]);
  });

  it('fails over on BEDROCK_ERROR, PROVIDER_ERROR, UNKNOWN_ERROR, RATE_LIMITED, TIMEOUT and any retryable AIError', async () => {
    const failures = [
      outage('BEDROCK_ERROR'),
      outage('PROVIDER_ERROR'),
      outage('UNKNOWN_ERROR'),
      outage('RATE_LIMITED'),
      outage('TIMEOUT'),
      // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
      new AIError('a retryable fault the vendor named its own way', 'INTERNAL_ERROR', true),
    ];
    const answered = [];
    for (const failure of failures) {
      const stream = withFallback(scripted([], failure).provider, [scripted([text('ok'), STOP]).provider]).sendMessage(
        userMessage('hi')
      );
      answered.push([failure.code, (await collectChunks(stream)).length]);
    }

    expect(answered).toEqual([
      ['BEDROCK_ERROR', 2],
      ['PROVIDER_ERROR', 2],
      ['UNKNOWN_ERROR', 2],
      ['RATE_LIMITED', 2],
      ['TIMEOUT', 2],
      ['INTERNAL_ERROR', 2],
    ]);
  });

  it('propagates a plain Error boom unchanged with the secondary uncalled', async () => {
    const boom = new Error('boom');
    const secondary = scripted([text('never'), STOP]);

    const raised = await collectChunks(
      withFallback(scripted([], boom).provider, [secondary.provider]).sendMessage(userMessage('hi'))
    ).catch((error: unknown) => error);

    expect({sameError: raised === boom, secondaryCalls: secondary.calls()}).toEqual({
      sameError: true,
      secondaryCalls: 0,
    });
  });

  it("calls each of three providers failing on TIMEOUT once, in order, and throws the third's AIError instance", async () => {
    const order: string[] = [];
    const failures = [outage('TIMEOUT'), outage('TIMEOUT'), outage('TIMEOUT')];
    const [first, second, third] = failures.map((failure, position): AIProvider => ({
      async *sendMessage(): AsyncGenerator<MessageChunk> {
        order.push(`provider-${position}`);
        yield* [];
        throw failure;
      },
      generateStructured: async <T>() => ({}) as T,
    }));

    const raised = await collectChunks(withFallback(first, [second, third]).sendMessage(userMessage('hi'))).catch(
      (error: unknown) => error
    );

    expect({order, thirds: raised === failures[2]}).toEqual({
      order: ['provider-0', 'provider-1', 'provider-2'],
      thirds: true,
    });
  });

  it("hands the secondary the primary's own SendMessageParams: the same messages, system prompt, tools and signal", async () => {
    const primary = scripted([], outage('SERVICE_UNAVAILABLE'));
    const secondary = scripted([text('ok'), STOP]);
    const params: SendMessageParams = {
      ...userMessage('hi'),
      tools: [{name: 'lookup', description: 'Looks it up.', inputSchema: {type: 'object'}}],
      signal: new AbortController().signal,
    };

    await collectChunks(withFallback(primary.provider, [secondary.provider]).sendMessage(params));

    const [sentToPrimary] = primary.params();
    const [sentToSecondary] = secondary.params();
    expect({same: sentToSecondary === sentToPrimary, equal: sentToSecondary}).toEqual({same: true, equal: params});
  });

  it('fails over generateStructured under the same rules: SERVICE_UNAVAILABLE routes on, AUTH_ERROR propagates', async () => {
    const answer = {verdict: 'ok'};
    const routed = await withFallback(scripted([], outage('SERVICE_UNAVAILABLE')).provider, [
      scripted([], undefined, answer).provider,
    ]).generateStructured({messages: [], systemPrompt: 's', responseSchema: {type: 'object'}});
    const auth = outage('AUTH_ERROR');
    const secondary = scripted([], undefined, answer);
    const refused = await withFallback(scripted([], auth).provider, [secondary.provider])
      .generateStructured({messages: [], systemPrompt: 's', responseSchema: {type: 'object'}})
      .catch((error: unknown) => error);

    const {calls} = (secondary.provider.generateStructured as jest.Mock).mock;
    expect({routed, sameError: refused === auth, secondaryCalls: calls.length}).toEqual({
      routed: answer,
      sameError: true,
      secondaryCalls: 0,
    });
  });

  it("ends quietly without starting the secondary when the caller aborts during the primary's attempt", async () => {
    const controller = new AbortController();
    const primary: AIProvider = {
      async *sendMessage(): AsyncGenerator<MessageChunk> {
        controller.abort();
        yield* [];
        throw outage('SERVICE_UNAVAILABLE');
      },
      generateStructured: async <T>() => ({}) as T,
    };
    const secondary = scripted([text('never'), STOP]);

    const chunks = await collectChunks(
      withFallback(primary, [secondary.provider]).sendMessage({...userMessage('hi'), signal: controller.signal})
    );

    expect({chunks, secondaryCalls: secondary.calls()}).toEqual({chunks: [], secondaryCalls: 0});
  });

  it("logs each failover once under provider with the failing provider's label, code and position, and no content", async () => {
    const params = {...userMessage('my booking OLT-2026-0001'), systemPrompt: 'secret system prompt'};
    const stream = withFallback(
      scripted([], outage('SERVICE_UNAVAILABLE')).provider,
      [scripted([], outage('TIMEOUT')).provider, scripted([text('ok'), STOP]).provider],
      {labels: ['vertex', 'bedrock', 'mock']}
    ).sendMessage(params);

    await collectChunks(stream);

    expect({warnings, leaked: /OLT-2026-0001|secret system prompt/.test(JSON.stringify(warnings))}).toEqual({
      warnings: [
        {
          category: 'provider',
          message: 'failing over to the next provider',
          failed: 'vertex',
          code: 'SERVICE_UNAVAILABLE',
          position: 1,
          of: 3,
        },
        {
          category: 'provider',
          message: 'failing over to the next provider',
          failed: 'bedrock',
          code: 'TIMEOUT',
          position: 2,
          of: 3,
        },
      ],
      leaked: false,
    });
  });
});
