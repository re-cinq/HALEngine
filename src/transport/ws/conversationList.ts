import {WebSocket} from 'ws';
import type {ConversationSummary, ListConversationsMessage} from '../../types/messages.js';
import {ErrorCodes} from '../../types/messages.js';
import type {SessionStore, SessionSummary} from '../../types/sessionStore.js';
import {StoreCannotList} from '../../types/sessionStore.js';
import {sendError, sendJson} from './sender.js';
import {log} from '../../shared/logger.js';

/** Opt-in. GDPR: it tells a client what conversations a user has, which rejoining one does not, so it is its own decision. */
export interface ConversationHistoryOptions {
  enabled: boolean;
}

export interface ConversationListDeps {
  sessionStore: SessionStore;
  history?: ConversationHistoryOptions;
}

/** Answers one `list_conversations` for the socket's own authenticated user, never for a user the frame names. */
export async function answerConversationList(
  ws: WebSocket,
  userId: string | number,
  frame: ListConversationsMessage,
  deps?: ConversationListDeps
): Promise<void> {
  // A handler built without the store cannot serve the frame either, and silence is the one answer never to give.
  if (deps === undefined || !deps.history?.enabled) {
    sendError(ws, ErrorCodes.UNSUPPORTED, 'Conversation history is not enabled on this server');
    return;
  }
  // Refused rather than answered empty: a client told "no conversations" cannot tell that from a user who has none.
  const {listFor} = deps.sessionStore;
  if (listFor === undefined) {
    sendError(ws, ErrorCodes.UNSUPPORTED, 'This session store cannot list conversations');
    return;
  }

  try {
    const summaries = await listFor.call(deps.sessionStore, userId, {limit: frame.limit, before: frame.before});
    sendJson(ws, {type: 'conversation_list', conversations: summaries.map(onTheWire)});
  } catch (error) {
    if (error instanceof StoreCannotList) {
      // A store saying it cannot list at all is a deployment fault, not a failed read: the client hears the same as above.
      log.error('message', 'store cannot list conversations', {userId, errorType: error.name});
      sendError(ws, ErrorCodes.UNSUPPORTED, 'This session store cannot list conversations');
      return;
    }
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
