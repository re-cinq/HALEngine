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
  /** Present only when the run ended before this entry finished: a provider failure or a round with no stop. */
  truncated?: true;
}

export interface ThinkingEntry {
  role: 'thinking';
  content: string;
  isStreaming: boolean;
  /** Present only when the run ended before this entry finished: a provider failure or a round with no stop. */
  truncated?: true;
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
