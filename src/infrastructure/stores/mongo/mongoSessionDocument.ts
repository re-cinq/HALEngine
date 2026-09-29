import type {ChatSession, SessionEntry} from '../../../types/session.js';

/** Keys never written to the database, matched case-insensitively at any depth. */
export const REDACTED_KEYS: readonly string[] = ['authheaders', 'authorization', 'cookie', 'host'];

export interface MongoSessionDocument {
  _id: string;
  userId: string | number;
  entries: SessionEntry[];
  workspaceId?: string | number;
  createdAt: Date;
  updatedAt: Date;
}

/** Returns a deep copy with every credential-bearing key removed, leaving the input untouched. */
export function stripCredentialKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(element => stripCredentialKeys(element)) as unknown as T;
  if (!isPlainObject(value)) return value;

  const kept: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (REDACTED_KEYS.includes(key.toLowerCase())) continue;
    kept[key] = stripCredentialKeys(nested);
  }
  return kept as T;
}

/** The fields a save writes, sanitized, without the timestamps the store owns. */
export function persistedFields(session: ChatSession): Omit<MongoSessionDocument, '_id' | 'createdAt' | 'updatedAt'> {
  return stripCredentialKeys({
    userId: session.userId,
    entries: session.entries,
    workspaceId: session.workspaceId,
  });
}

/** Rebuilds the in-memory session from a stored document; credentials are gone and do not come back. */
export function toChatSession(document: MongoSessionDocument): ChatSession {
  return {
    sessionId: document._id,
    userId: document.userId,
    entries: document.entries as SessionEntry[],
    workspaceId: document.workspaceId,
  };
}

// A Date is a value the driver stores natively, so it is copied by reference rather than walked.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !(value instanceof Date);
}
