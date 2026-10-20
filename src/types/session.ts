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
  /** When the store created the session, ISO 8601: `Z`-suffixed or with an offset alike, so parse before comparing; written by the store, not the engine, and absent from a session stored before 0.9. */
  createdAt?: string;
}

export interface AuthenticatedUser {
  id: string | number;
  [key: string]: unknown;
}
