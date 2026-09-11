import type {UsageMetadata} from './ai.js';

export interface UsageRecord {
  sessionId: string;
  provider: string;
  model: string;
  usage: UsageMetadata;
  timestamp: string;
}

export interface UsageStore {
  record(entry: UsageRecord): Promise<void>;
  getBySession(sessionId: string): Promise<UsageRecord[]>;
}
