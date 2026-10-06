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
}

export interface ThinkingEntry {
  role: 'thinking';
  content: string;
  isStreaming: boolean;
  /** Present only when the run ended before this entry finished (a provider failure or a round with no stop), or on a resume's replay of an entry still streaming. */
  truncated?: true;
  /** Present only when a tool suppressed the response and the client was never sent this entry. */
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
}

export interface AuthenticatedUser {
  id: string | number;
  [key: string]: unknown;
}
