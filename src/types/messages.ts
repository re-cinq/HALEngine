import type {SessionEntry} from './session.js';

export interface UserMessagePayload {
  type: 'user_message';
  content: string;
}

export interface PingMessage {
  type: 'ping';
  timestamp: number;
}

export type IncomingMessage = UserMessagePayload | PingMessage;

export interface ConnectedMessage {
  type: 'connected';
  sessionId: string;
  message: string;
  examplePrompts: string[];
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
  | EntryUpsertMessage
  | EntryDeltaMessage
  | EntryCommitMessage
  | EntrySkipMessage
  | ErrorMessage
  | PongMessage
  | StreamEndMessage;

export {ErrorCodes} from './session.js';
