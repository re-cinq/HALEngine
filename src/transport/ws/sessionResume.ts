import type {WebSocket} from 'ws';
import type {ChatSession, SessionEntry} from '../../types/session.js';
import type {Awaitable, SessionStore} from '../../types/sessionStore.js';
import type {ConnectedMessage} from '../../types/messages.js';
import {sendSkip, sendUpsert} from './sender.js';
import {log} from '../../shared/logger.js';

/** Opt-in resume. GDPR: enabling it keeps conversation content past disconnect, so the consumer owns the retention bound — set it with the store's `maxAgeMs` and erasure methods and see re-cinq/HALEngine#41; an unbounded retained store is a retention breach, not a memory leak. */
export interface SessionResumeOptions {
  enabled: boolean;
  /** With no `?sessionId=`, rejoin the user's most recently active session (the store's `latestFor`) instead of starting one; `?new=1` still starts one. */
  latest?: boolean;
}

/** What `onConnect` learns about a connection besides its session. */
export interface ConnectInfo {
  /** `true` when the connection rejoined a stored session, the one `?sessionId=` named or the user's latest; `false` for a new session. */
  resumed: boolean;
}

interface Requester {
  requestedSessionId?: string;
  startNewSession?: boolean;
  userId: string | number;
}

// Only the requester's own session is rejoined; a miss, a store failure and a not-yours all read as no resume.
export async function resumableSession(
  store: SessionStore,
  requester: Requester,
  options?: SessionResumeOptions
): Promise<ChatSession | undefined> {
  const stored = await storedSession(store, requester, options);
  return stored !== undefined && String(stored.userId) === String(requester.userId) ? stored : undefined;
}

async function storedSession(
  store: SessionStore,
  requester: Requester,
  options: SessionResumeOptions | undefined
): Promise<ChatSession | undefined> {
  try {
    return await lookUp(store, requester, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error('ws', 'session lookup failed', {userId: requester.userId, error: reason});
    return undefined;
  }
}

// A named id first; with none, the user's latest session, unless resume asks for none or the client asked for a new one.
function lookUp(
  store: SessionStore,
  {requestedSessionId, startNewSession, userId}: Requester,
  options: SessionResumeOptions | undefined
): Awaitable<ChatSession | undefined> {
  if (requestedSessionId !== undefined) return store.get(requestedSessionId);
  if (!options?.enabled || !options.latest || startNewSession) return undefined;
  return store.latestFor?.(userId);
}

// Absent when resume is off, so a connected frame is byte-for-byte what it was before resume existed.
export function resumeFields(
  options: SessionResumeOptions | undefined,
  resumed: ChatSession | undefined
): Pick<ConnectedMessage, 'resumed' | 'entryCount'> {
  if (!options?.enabled) return {};
  return resumed ? {resumed: true, entryCount: resumed.entries.length} : {resumed: false};
}

// A suppressed entry is replayed as a skip: the client sees the conversation it saw live, never the text a tool hid.
export function replayEntries(ws: WebSocket, session: ChatSession): void {
  session.entries.forEach((entry, index) => replayEntry(ws, index, entry));
}

function replayEntry(ws: WebSocket, index: number, entry: SessionEntry): void {
  if ('suppressed' in entry && entry.suppressed) {
    sendSkip(ws, index);
    return;
  }
  // Its turn streams to the socket that started it, so this client is shown it cut off rather than waiting on it.
  if ('isStreaming' in entry && entry.isStreaming) {
    sendUpsert(ws, index, {...entry, isStreaming: false, truncated: true});
    return;
  }
  sendUpsert(ws, index, entry);
}
