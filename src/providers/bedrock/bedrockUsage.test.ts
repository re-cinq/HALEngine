import type {ConverseStreamOutput} from '@aws-sdk/client-bedrock-runtime';
import {extractUsageFromMetadata, parseStreamEvents} from './bedrockStreamHandlers.js';
import {collectChunks} from '../providerTestSupport.js';

// Plain objects in the shape the Converse stream sends: the parser needs no client and no SDK mock.
const events = (...list: object[]): AsyncIterable<ConverseStreamOutput> => ({
  async *[Symbol.asyncIterator]() {
    yield* list as ConverseStreamOutput[];
  },
});
const parse = (...list: object[]) => collectChunks(parseStreamEvents(events(...list), undefined));

const TEXT = {contentBlockDelta: {delta: {text: 'Hello'}}};
const STOP = {messageStop: {stopReason: 'end_turn'}};
const COUNTS = {inputTokens: 1200, outputTokens: 340, totalTokens: 1540};
const METADATA = {metadata: {usage: COUNTS}};

describe('Bedrock token usage', () => {
  it('reads the three counts off a metadata event, undefined without one, leaving the event as it was', () => {
    const event = Object.freeze({metadata: Object.freeze({usage: Object.freeze({...COUNTS})})});

    expect([
      extractUsageFromMetadata(event as ConverseStreamOutput),
      extractUsageFromMetadata({messageStop: {stopReason: 'end_turn'}} as ConverseStreamOutput),
      extractUsageFromMetadata({metadata: {usage: undefined}} as ConverseStreamOutput),
    ]).toEqual([COUNTS, undefined, undefined]);
  });

  it('carries the usage of a metadata event after messageStop on the one stop chunk, after the text', async () => {
    expect(await parse(TEXT, STOP, METADATA)).toEqual([
      {type: 'text', text: 'Hello'},
      {type: 'stop', stopReason: 'end_turn', usage: COUNTS},
    ]);
  });

  it('yields the identical chunks when the metadata event arrives before messageStop', async () => {
    expect(await parse(TEXT, METADATA, STOP)).toEqual(await parse(TEXT, STOP, METADATA));
  });

  it('puts no usage key at all on the stop chunk of a stream with no metadata event', async () => {
    const chunks = await parse(TEXT, STOP);

    expect(Object.keys(chunks.at(-1) ?? {})).toEqual(['type', 'stopReason']);
  });

  it('reports no usage for a metadata event with no counts, and zeroes the counts a partial one leaves out', async () => {
    const empty = await parse(STOP, {metadata: {usage: {}}});
    const partial = await parse(STOP, {metadata: {usage: {inputTokens: 1200}}});

    expect({emptyKeys: Object.keys(empty.at(-1) ?? {}), partial: partial.at(-1)}).toEqual({
      emptyKeys: ['type', 'stopReason'],
      partial: {type: 'stop', stopReason: 'end_turn', usage: {inputTokens: 1200, outputTokens: 0, totalTokens: 0}},
    });
  });

  it("reports the vendor's totalTokens of 1300 as given, never a recomputed 1000", async () => {
    const chunks = await parse(STOP, {metadata: {usage: {inputTokens: 900, outputTokens: 100, totalTokens: 1300}}});

    expect(chunks.at(-1)).toMatchObject({usage: {totalTokens: 1300}});
  });

  it('keeps metrics and trace out of the stop chunk, which carries exactly the three usage fields', async () => {
    const chunks = await parse(STOP, {
      metadata: {usage: COUNTS, metrics: {latencyMs: 4321}, trace: {guardrail: {input: 'user typed secret-77'}}},
    });

    const stop = chunks.at(-1);
    expect({
      leaked: /latencyMs|4321|secret-77/.test(JSON.stringify(stop)),
      usageKeys: Object.keys((stop as {usage?: object}).usage ?? {}).sort(),
    }).toEqual({leaked: false, usageKeys: ['inputTokens', 'outputTokens', 'totalTokens']});
  });

  it("yields a tool round's tool_use chunk before its stop, the stop carrying that round's usage", async () => {
    const chunks = await parse(
      {contentBlockStart: {start: {toolUse: {toolUseId: 't1', name: 'lookup'}}}},
      {contentBlockDelta: {delta: {toolUse: {input: '{"q":"hi"}'}}}},
      {contentBlockStop: {}},
      {messageStop: {stopReason: 'tool_use'}},
      METADATA
    );

    expect(chunks).toEqual([
      {type: 'tool_use', toolCall: {id: 't1', name: 'lookup', input: {q: 'hi'}}},
      {type: 'stop', stopReason: 'tool_use', usage: COUNTS},
    ]);
  });
});
