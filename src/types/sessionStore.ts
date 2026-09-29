import type {ChatSession} from './session.js';

/** A value a store may return directly or resolve to, so a database-backed member needs no new interface. */
export type Awaitable<T> = T | Promise<T>;

export interface BaseSession {
  sessionId: string;
  userId: string | number;
}

export interface SessionCreateOptions {
  authHeaders?: ChatSession['authHeaders'];
  workspaceId?: string | number;
}

export interface SessionStore<T extends BaseSession = ChatSession> {
  create(sessionId: string, userId: string | number, options?: SessionCreateOptions): Awaitable<T>;
  get(sessionId: string): Awaitable<T | undefined>;
  delete(sessionId: string): Awaitable<boolean>;
  count(): Awaitable<number>;
  clear(): Awaitable<void>;
  /** Write signal: fires once per processed user message; failures are swallowed (specs/hal-engine-session-write-signal/spec.md). */
  save?(session: T): void | Promise<void>;
}
