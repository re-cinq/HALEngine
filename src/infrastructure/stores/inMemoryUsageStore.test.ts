import {InMemoryUsageStore} from './inMemoryUsageStore.js';
import type {UsageRecord} from '../../types/usageStore.js';

// Fixed: nothing asserts on it, and new Date() would tie the run to the clock.
const RECORDED_AT = '2026-01-01T00:00:00.000Z';

function makeRecord(sessionId: string, inputTokens: number): UsageRecord {
  return {
    sessionId,
    provider: 'vertex',
    model: 'gemini-2.5-flash',
    usage: {inputTokens, outputTokens: 20, totalTokens: inputTokens + 20},
    timestamp: RECORDED_AT,
  };
}

describe('InMemoryUsageStore', () => {
  let store: InMemoryUsageStore;

  beforeEach(() => {
    store = new InMemoryUsageStore();
  });

  it('records and retrieves usage by session', async () => {
    const record = makeRecord('s1', 10);
    await store.record(record);
    const results = await store.getBySession('s1');
    expect(results).toEqual([record]);
  });

  it('returns empty array for unknown session', async () => {
    expect(await store.getBySession('nonexistent')).toEqual([]);
  });

  it('filters by session ID', async () => {
    await store.record(makeRecord('s1', 10));
    await store.record(makeRecord('s2', 15));
    await store.record(makeRecord('s1', 20));

    const s1Records = await store.getBySession('s1');

    expect(s1Records.map(r => `${r.sessionId}:${r.usage.inputTokens}`)).toEqual(['s1:10', 's1:20']);
  });
});
