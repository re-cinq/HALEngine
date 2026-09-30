import type {WebSocket} from 'ws';
import type {ChatSession, SessionEntry} from '../../types/session.js';
import type {SessionStore} from '../../types/sessionStore.js';
import type {ConnectedMessage} from '../../types/messages.js';
import {sendSkip, sendUpsert} from './sender.js';
import {log} from '../../shared/logger.js';

/** Opt-in resume. GDPR: enabling it keeps conversation content past disconnect, so the consumer owns the retention bound — set it with the store's `maxAgeMs` and erasure methods and see re-cinq/HALEngine#41; an unbounded retained store is a retention breach, not a memory leak. */
export interface SessionResumeOptions {
  enabled: boolean;
}

interface Requester {
  requestedSessionId?: string;
  userId: string | number;
}

// Only the requester's own session is rejoined; a miss, a store failure and a not-yours all read as no resume.
export async function resumableSession(store: SessionStore, requester: Requester): Promise<ChatSession | undefined> {
  const {requestedSessionId, userId} = requester;
  if (requestedSessionId === undefined) return undefined;
  const stored = await storedSession(store, requestedSessionId, userId);
  return stored !== undefined && String(stored.userId) === String(userId) ? stored : undefined;
}

async function storedSession(
  store: SessionStore,
  sessionId: string,
  userId: string | number
): Promise<ChatSession | undefined> {
  try {
    return await store.get(sessionId);
  } catch (error) {
    log.error('ws', 'session lookup failed', {userId, error: error instanceof Error ? error.message : String(error)});
    return undefined;
  }
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
  sendUpsert(ws, index, entry);
}
