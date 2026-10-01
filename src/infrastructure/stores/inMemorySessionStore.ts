import type {ChatSession} from '../../types/session.js';
import type {SessionStore, SessionCreateOptions, SessionLookup} from '../../types/sessionStore.js';

// Eight hours: a memory bound, not a retention decision (specs/hal-engine-session-lifetime/spec.md).
const DEFAULT_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export interface InMemorySessionStoreOptions {
  maxAgeMs?: number;
}

// The creation time is held beside the session rather than on it, so it never reaches the public ChatSession.
interface HeldSession {
  session: ChatSession;
  createdAt: number;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, HeldSession>();
  private readonly maxAgeMs: number;

  constructor(options: InMemorySessionStoreOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  create(sessionId: string, userId: string | number, options?: SessionCreateOptions): ChatSession {
    this.sweepExpired();

    const session: ChatSession = {
      sessionId,
      userId,
      entries: [],
      authHeaders: options?.authHeaders,
      workspaceId: options?.workspaceId,
    };
    this.sessions.set(sessionId, {session, createdAt: Date.now()});
    return session;
  }

  get(sessionId: string): ChatSession | undefined {
    const held = this.sessions.get(sessionId);
    if (held === undefined) return undefined;
    if (!this.hasExpired(held)) return held.session;

    this.sessions.delete(sessionId);
    return undefined;
  }

  /** One shot: a session past `maxAgeMs` answers `expired` once and is evicted, never kept as a tombstone. */
  lookup(sessionId: string): SessionLookup {
    const held = this.sessions.get(sessionId);
    if (held === undefined) return {status: 'missing'};
    if (!this.hasExpired(held)) return {status: 'active', session: held.session};

    this.sessions.delete(sessionId);
    return {status: 'expired', userId: held.session.userId};
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  // Eviction and erasure coincide for a store that is only a cache; they do not for a durable one.
  evict(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  count(): number {
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
  }

  /** The user's most recently active session that has not aged out: its newest entry decides, or its creation if it has none. */
  latestFor(userId: string | number): ChatSession | undefined {
    const owned = [...this.sessions.values()].filter(held => held.session.userId === userId && !this.hasExpired(held));
    // Ascending and stable, so of two sessions last active at the same moment, the one created later wins.
    const byActivity = owned.sort((first, second) => lastActivity(first) - lastActivity(second));
    return byActivity.at(-1)?.session;
  }

  // Insertion order approximates age order, so the first live entry ends the sweep and the rest cost nothing.
  private sweepExpired(): void {
    for (const [sessionId, held] of this.sessions) {
      if (!this.hasExpired(held)) return;
      this.sessions.delete(sessionId);
    }
  }

  // A session stamped with an unusable clock reading never ages out, rather than expiring immediately.
  private hasExpired(held: HeldSession): boolean {
    return Number.isFinite(held.createdAt) && Date.now() - held.createdAt > this.maxAgeMs;
  }
}

// The store has no save to stamp, so activity is read off the entries; an unusable clock reading counts as none.
function lastActivity(held: HeldSession): number {
  const {entries} = held.session;
  const stamps = entries.map(entry => ('timestamp' in entry ? Date.parse(entry.timestamp) : Number.NaN));
  // Folded rather than spread into Math.max, whose argument list runs out past about 150,000 entries.
  return [held.createdAt, ...stamps].filter(Number.isFinite).reduce((latest, time) => Math.max(latest, time), 0);
}
