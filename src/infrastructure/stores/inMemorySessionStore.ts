import type {ChatSession} from '../../types/session.js';
import type {SessionStore, SessionCreateOptions} from '../../types/sessionStore.js';

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ChatSession>();

  create(sessionId: string, userId: string | number, options?: SessionCreateOptions): ChatSession {
    const session: ChatSession = {
      sessionId,
      userId,
      entries: [],
      authHeaders: options?.authHeaders,
      workspaceId: options?.workspaceId,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): ChatSession | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  count(): number {
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
  }
}
