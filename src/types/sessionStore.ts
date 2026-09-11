import type {ChatSession} from './session.js';

export interface BaseSession {
  sessionId: string;
  userId: string | number;
}

export interface SessionCreateOptions {
  authHeaders?: ChatSession['authHeaders'];
  workspaceId?: string | number;
}

export interface SessionStore<T extends BaseSession = ChatSession> {
  create(sessionId: string, userId: string | number, options?: SessionCreateOptions): T;
  get(sessionId: string): T | undefined;
  delete(sessionId: string): boolean;
  count(): number;
  clear(): void;
}
