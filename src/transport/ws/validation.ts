import type {IncomingMessage} from '../../types/messages.js';

const MAX_CONTENT_LENGTH = 10000;

interface ValidationSuccess {
  valid: true;
  data: IncomingMessage;
}

interface ValidationFailure {
  valid: false;
  error: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export function validateMessage(payload: unknown): ValidationResult {
  if (typeof payload !== 'object' || payload === null) {
    return {valid: false, error: 'Message must be an object'};
  }

  const message = payload as Record<string, unknown>;

  if (typeof message.type !== 'string') {
    return {valid: false, error: 'Message must have a type field'};
  }

  switch (message.type) {
    case 'user_message':
      return validateUserMessage(message);
    case 'ping':
      return validatePingMessage(message);
    default:
      return {valid: false, error: `Unknown message type: ${message.type}`};
  }
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
