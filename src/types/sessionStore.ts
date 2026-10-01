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
  /** Drops a session the client never received, without erasing anything a consumer would want kept. */
  evict?(sessionId: string): Awaitable<boolean>;
  /** Write signal: fires once per processed user message; failures are swallowed (specs/hal-engine-session-write-signal/spec.md). */
  save?(session: T): Awaitable<void>;
  /** The user's most recently active session the store still holds, so a connect that names none can continue it (specs/hal-engine-session-resume/spec.md). */
  latestFor?(userId: string | number): Awaitable<T | undefined>;
}
