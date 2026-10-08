import {WebSocket} from 'ws';
import type {ConversationSummary, ListConversationsMessage} from '../../types/messages.js';
import {ErrorCodes} from '../../types/messages.js';
import type {ChatSession} from '../../types/session.js';
import type {SessionStore, SessionSummary} from '../../types/sessionStore.js';
import {StoreCannotList} from '../../types/sessionStore.js';
import {labelFrom} from '../../infrastructure/stores/sessionPreview.js';
import {sendError, sendJson} from './sender.js';
import {log} from '../../shared/logger.js';

/** Opt-in, and the deployer's decision: it tells a client what conversations a user has, which rejoining one does not. GDPR: it reaches as far back as the store keeps conversations, so the consumer owns the retention bound — the store's `maxAgeMs` and erasure methods, and see re-cinq/HALEngine#41. */
export interface ConversationHistoryOptions {
  enabled: boolean;
  /** Whether a listed conversation carries its opening question; `false` by default, since that text is conversation content. GDPR: a preview is personal data the client renders, so turning it on extends what this deployment discloses under its own lawful basis. */
  preview?: boolean;
}

export interface ConversationListDeps {
  sessionStore: SessionStore;
  history?: ConversationHistoryOptions;
}

// One read in flight per socket: nothing else lets a single client turn frames sent in one tick into parallel queries.
const reading = new WeakMap<WebSocket, Promise<void>>();

/** Answers one `list_conversations` for the socket's own authenticated user, never for a user the frame names. */
export function answerConversationList(
  ws: WebSocket,
  session: Pick<ChatSession, 'sessionId' | 'userId'>,
  frame: ListConversationsMessage,
  deps?: ConversationListDeps
): Promise<void> {
  const answered = (reading.get(ws) ?? Promise.resolve()).then(() => answerOne(ws, session, frame, deps));
  // A swallowed copy is what the next frame waits on, so one refusal does not reject every list queued behind it.
  reading.set(
    ws,
    answered.catch(() => undefined)
  );
  return answered;
}

async function answerOne(
  ws: WebSocket,
  session: Pick<ChatSession, 'sessionId' | 'userId'>,
  frame: ListConversationsMessage,
  deps?: ConversationListDeps
): Promise<void> {
  const {sessionId, userId} = session;
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

  // The deployer's switch, never the client's: the frame has no field for it and the validator would drop one.
  const preview = deps.history.preview === true;
  let conversations: ConversationSummary[];
  // Only the read and the mapping of what it answered: a send that fails is this socket's fault, not the store's.
  try {
    const summaries = await listFor.call(deps.sessionStore, userId, {
      limit: frame.limit,
      before: frame.before,
      preview,
    });
    conversations = summaries.map(preview ? withPreview : onTheWire);
  } catch (error) {
    if (error instanceof StoreCannotList) {
      // A store saying it cannot list at all is a deployment fault, not a failed read: the client hears the same as above.
      log.error('message', 'store cannot list conversations', {sessionId, userId, errorType: error.name});
      sendError(ws, ErrorCodes.UNSUPPORTED, 'This session store cannot list conversations');
      return;
    }
    // The type alone, as the authenticator path does it: a driver's message can carry a connection string and its password.
    log.error('message', 'conversation list failed', {sessionId, userId, errorType: typeOf(error)});
    sendError(ws, ErrorCodes.SERVER_ERROR, 'Could not list conversations');
    return;
  }

  sendJson(ws, {type: 'conversation_list', conversations});
}

// Through `new Date` rather than off the `Date`: a store answering ISO strings is the shape the wire shows, not a failure.
function onTheWire(summary: SessionSummary): ConversationSummary {
  return {
    sessionId: summary.sessionId,
    createdAt: new Date(summary.createdAt).toISOString(),
    updatedAt: new Date(summary.updatedAt).toISOString(),
    entryCount: summary.entryCount,
  };
}

// The only mapper that copies a preview, so a store volunteering one cannot reach the wire through the other.
function withPreview(summary: SessionSummary): ConversationSummary {
  const row = onTheWire(summary);
  // Cut again here, as the times are rebuilt above: the bound the protocol documents is the transport's to hold.
  const label = labelFrom(summary.preview);
  if (label === undefined) return row;
  return {...row, preview: label};
}

function typeOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
