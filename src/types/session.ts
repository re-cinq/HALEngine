export interface UserEntry {
  role: 'user';
  content: string;
  timestamp: string;
}

export interface AssistantEntry {
  role: 'assistant';
  content: string;
  timestamp: string;
  isStreaming: boolean;
  /** Present only when the run ended before this entry finished (a provider failure or a round with no stop), or on a resume's replay of an entry still streaming. */
  truncated?: true;
  /** Present only when a tool suppressed the response and the client was shown this entry blank or not at all. */
  suppressed?: true;
  /** The consumer's identifier of the persona that wrote this entry; the engine never resolves or validates it, and it must carry no personal data. */
  persona?: string;
}

export interface ThinkingEntry {
  role: 'thinking';
  content: string;
  /** When the entry was created, ISO 8601: `2026-01-15T14:30:00.000Z` or `2026-01-15T15:30:00.000+01:00` alike, so parse before comparing; absent on an entry stored before 0.9. */
  timestamp?: string;
  isStreaming: boolean;
  /** Present only when the run ended before this entry finished (a provider failure or a round with no stop), or on a resume's replay of an entry still streaming. */
  truncated?: true;
  /** Present only when a tool suppressed the response and the client was shown this entry blank or not at all. */
  suppressed?: true;
}

export interface ToolEntry {
  role: 'tool';
  toolName: string;
  toolInput: Record<string, unknown>;
  timestamp: string;
}

export type SessionEntry = UserEntry | AssistantEntry | ThinkingEntry | ToolEntry;

export const ErrorCodes = {
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  INVALID_FORMAT: 'INVALID_FORMAT',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  SERVER_ERROR: 'SERVER_ERROR',
  UNSUPPORTED: 'UNSUPPORTED',
} as const;

export interface ChatSession {
  sessionId: string;
  userId: string | number;
  entries: SessionEntry[];
  authHeaders?: {
    cookie?: string;
    authorization?: string;
    host?: string;
  };
  workspaceId?: string | number;
  /** Set by the consumer before or during beforeModelResponse; every assistant entry created for that turn carries it as its persona. */
  activePersona?: string;
  /** When the store created the session, ISO 8601: `Z`-suffixed or with an offset alike, so parse before comparing; written by the store, not the engine, and absent when the store holds no creation time for the session. */
  createdAt?: string;
}

export interface AuthenticatedUser {
  id: string | number;
  [key: string]: unknown;
}

/** Whether a user id is one a store can filter on: a string or a finite number, never an object such as `{$ne: null}`, which a Mongo filter reads as every user. */
export function isScalarUserId(userId: unknown): userId is string | number {
  return typeof userId === 'string' || (typeof userId === 'number' && Number.isFinite(userId));
}

/** The kind of an unusable user id, for a log line or an error: never its contents, which can carry whatever a token held. */
export function userIdKind(userId: unknown): string {
  if (userId === null) return 'null';
  if (Array.isArray(userId)) return 'array';
  if (typeof userId === 'number') return Number.isNaN(userId) ? 'NaN' : 'Infinity';
  return typeof userId;
}

/** Refuses a user id that is not a string or a finite number, before any store query is built from it. */
export function assertScalarUserId(userId: unknown): asserts userId is string | number {
  if (isScalarUserId(userId)) return;
  throw new TypeError(`user id must be a string or a finite number, not ${userIdKind(userId)}`);
}
