import type {UsageStore, UsageRecord} from '../../types/usageStore.js';

export class InMemoryUsageStore implements UsageStore {
  private readonly records: UsageRecord[] = [];

  async record(entry: UsageRecord): Promise<void> {
    this.records.push(entry);
  }

  async getBySession(sessionId: string): Promise<UsageRecord[]> {
    return this.records.filter(r => r.sessionId === sessionId);
  }
}
