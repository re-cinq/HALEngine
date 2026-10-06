import {WebSocket} from 'ws';
import type {ConversationSummary, ListConversationsMessage} from '../../types/messages.js';
import {ErrorCodes} from '../../types/messages.js';
import type {SessionStore, SessionSummary} from '../../types/sessionStore.js';
import {sendError, sendJson} from './sender.js';
import {log} from '../../shared/logger.js';

/** Opt-in. GDPR: it tells a client what conversations a user has, which rejoining one does not, so it is its own decision. */
export interface ConversationHistoryOptions {
  enabled: boolean;
}

interface Lister {
  store: SessionStore;
  options?: ConversationHistoryOptions;
}

/** Answers one `list_conversations` for the socket's own authenticated user, never for a user the frame names. */
export async function answerConversationList(
  ws: WebSocket,
  userId: string | number,
  frame: ListConversationsMessage,
  {store, options}: Lister
): Promise<void> {
  if (!options?.enabled) {
    sendError(ws, ErrorCodes.UNSUPPORTED, 'Conversation history is not enabled on this server');
    return;
  }
  // Refused rather than answered empty: a client told "no conversations" cannot tell that from a user who has none.
  if (store.listFor === undefined) {
    sendError(ws, ErrorCodes.UNSUPPORTED, 'This session store cannot list conversations');
    return;
  }

  try {
    const summaries = await store.listFor(userId, {limit: frame.limit, before: frame.before});
    sendJson(ws, {type: 'conversation_list', conversations: summaries.map(onTheWire)});
  } catch (error) {
    // The type alone, as the authenticator path does it: a driver's message can carry a connection string and its password.
    log.error('message', 'conversation list failed', {userId, errorType: typeOf(error)});
    sendError(ws, ErrorCodes.SERVER_ERROR, 'Could not list conversations');
  }
}

function onTheWire(summary: SessionSummary): ConversationSummary {
  return {
    sessionId: summary.sessionId,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
    entryCount: summary.entryCount,
  };
}

function typeOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
