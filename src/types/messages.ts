import type {SessionEntry} from './session.js';

export interface UserMessagePayload {
  type: 'user_message';
  content: string;
}

export interface PingMessage {
  type: 'ping';
  timestamp: number;
}

/** Where a page of conversations resumes from: the last row the client was sent, both fields as it received them. */
export interface ConversationCursor {
  updatedAt: string;
  sessionId: string;
}

/** Asks for the connecting user's conversations. It names no user: the engine takes that from the connection. */
export interface ListConversationsMessage {
  type: 'list_conversations';
  limit?: number;
  before?: ConversationCursor;
}

export type IncomingMessage = UserMessagePayload | PingMessage | ListConversationsMessage;

export interface ConnectedMessage {
  type: 'connected';
  sessionId: string;
  message: string;
  examplePrompts: string[];
  resumed?: boolean;
  entryCount?: number;
  /** Why a named id was not rejoined: `expired` only for the session's own owner, `unknown` for every other case. */
  resumeFailure?: 'expired' | 'unknown';
}

/** One conversation in a list: a `SessionSummary` with its times as ISO strings, which is what survives the wire. */
export interface ConversationSummary {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  entryCount: number;
  /** The conversation's opening question, present only where the deployer turned previews on (specs/hal-engine-conversation-list/spec.md). */
  preview?: string;
}

/** The answer to `list_conversations`: the connecting user's own conversations, newest activity first. */
export interface ConversationListMessage {
  type: 'conversation_list';
  conversations: ConversationSummary[];
}

export interface EntryUpsertMessage {
  type: 'entry_upsert';
  index: number;
  entry: SessionEntry;
}

export interface EntryDeltaMessage {
  type: 'entry_delta';
  index: number;
  delta: string;
}

export interface EntryCommitMessage {
  type: 'entry_commit';
  index: number;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface PongMessage {
  type: 'pong';
  timestamp: number;
}

export interface EntrySkipMessage {
  type: 'entry_skip';
  index: number;
}

export interface StreamEndMessage {
  type: 'stream_end';
}

export type OutgoingMessage =
  | ConnectedMessage
  | ConversationListMessage
  | EntryUpsertMessage
  | EntryDeltaMessage
  | EntryCommitMessage
  | EntrySkipMessage
  | ErrorMessage
  | PongMessage
  | StreamEndMessage;

export {ErrorCodes} from './session.js';
