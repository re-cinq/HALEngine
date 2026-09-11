import {AIError} from '../../types/ai.js';

interface BedrockErrorMapping {
  message: string;
  code: string;
  retryable: boolean;
}

const BEDROCK_ERROR_MAP: Record<string, BedrockErrorMapping> = {
  ThrottlingException: {message: 'Rate limited by Bedrock', code: 'RATE_LIMITED', retryable: true},
  ModelTimeoutException: {message: 'Model timed out', code: 'TIMEOUT', retryable: true},
  ServiceUnavailableException: {message: 'Bedrock service unavailable', code: 'SERVICE_UNAVAILABLE', retryable: true},
  InternalServerException: {message: 'Bedrock internal error', code: 'INTERNAL_ERROR', retryable: true},
  ValidationException: {message: 'Invalid request to Bedrock', code: 'VALIDATION_ERROR', retryable: false},
  AccessDeniedException: {message: 'Access denied to Bedrock model', code: 'ACCESS_DENIED', retryable: false},
};

export function mapBedrockError(error: unknown): AIError {
  if (!(error instanceof Error)) return new AIError('Unknown error from Bedrock', 'UNKNOWN_ERROR');

  const mapping = BEDROCK_ERROR_MAP[error.name];
  if (!mapping) return new AIError(error.message, 'BEDROCK_ERROR');

  const message = error.name === 'ValidationException' ? `${mapping.message}: ${error.message}` : mapping.message;
  return new AIError(message, mapping.code, mapping.retryable);
}
