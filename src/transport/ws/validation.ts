import type {ConversationCursor, IncomingMessage} from '../../types/messages.js';
import {SESSION_ID_PATTERN} from './helpers.js';
// The store's own cap, not a copy of it: a frame asking for more than it would give is a client bug worth reporting.
import {MAX_LIMIT} from '../../infrastructure/stores/sessionListWindow.js';

const MAX_CONTENT_LENGTH = 10000;

interface ValidationSuccess {
  valid: true;
  data: IncomingMessage;
}

export interface ValidationFailure {
  valid: false;
  error: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

// A Map rather than an object: a frame naming `constructor` or `__proto__` must miss, not reach an inherited member.
const VALIDATORS = new Map<string, (message: Record<string, unknown>) => ValidationResult>([
  ['user_message', validateUserMessage],
  ['ping', validatePingMessage],
  ['list_conversations', validateListConversations],
]);

export function validateMessage(payload: unknown): ValidationResult {
  if (typeof payload !== 'object' || payload === null) {
    return {valid: false, error: 'Message must be an object'};
  }

  const message = payload as Record<string, unknown>;

  if (typeof message.type !== 'string') {
    return {valid: false, error: 'Message must have a type field'};
  }

  const validator = VALIDATORS.get(message.type);
  if (validator === undefined) return {valid: false, error: `Unknown message type: ${message.type}`};
  return validator(message);
}

function validateUserMessage(message: Record<string, unknown>): ValidationResult {
  if (typeof message.content !== 'string') {
    return {valid: false, error: 'user_message must have content string'};
  }

  const trimmed = message.content.trim();

  if (trimmed.length === 0) {
    return {valid: false, error: 'Message content cannot be empty'};
  }

  if (message.content.length > MAX_CONTENT_LENGTH) {
    return {valid: false, error: `Message content too long (max ${MAX_CONTENT_LENGTH} chars)`};
  }

  return {
    valid: true,
    data: {
      type: 'user_message',
      content: message.content,
    },
  };
}

function validatePingMessage(message: Record<string, unknown>): ValidationResult {
  if (typeof message.timestamp !== 'number') {
    return {valid: false, error: 'ping must have timestamp number'};
  }

  return {
    valid: true,
    data: {
      type: 'ping',
      timestamp: message.timestamp,
    },
  };
}

// Accepted whether or not the feature is on: a validator reads a frame, and the handler decides what is served.
function validateListConversations(message: Record<string, unknown>): ValidationResult {
  const {limit, before} = message;
  if (limit !== undefined && !isPage(limit)) {
    return {valid: false, error: `list_conversations limit must be a whole number from 1 to ${MAX_LIMIT}`};
  }

  const cursor = before === undefined ? undefined : asCursor(before);
  if (before !== undefined && cursor === undefined) {
    return {valid: false, error: 'list_conversations before must carry an ISO updatedAt and a sessionId'};
  }

  return {valid: true, data: {type: 'list_conversations', limit: limit as number | undefined, before: cursor}};
}

function isPage(limit: unknown): limit is number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT;
}

// Both halves or neither: a cursor missing its session id would page on a time alone and skip a conversation on a tie.
function asCursor(before: unknown): ConversationCursor | undefined {
  if (typeof before !== 'object' || before === null) return undefined;
  const {updatedAt, sessionId} = before as Record<string, unknown>;
  if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) return undefined;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return undefined;
  return {updatedAt, sessionId};
}
