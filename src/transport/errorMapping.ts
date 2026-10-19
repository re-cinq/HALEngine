import {AIError} from '../types/ai.js';
import {ErrorCodes} from '../types/session.js';

/** What both transports tell a client about one AIError: the WebSocket code, the HTTP status and a fixed sentence. */
export interface ClientError {
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes];
  status: number;
  message: string;
}

const AI_UNAVAILABLE = 'AI service temporarily unavailable';

// The provider conditions a client can wait out; every other AIError code is the vendor failing, the fallback row.
const PROVIDER_CONDITIONS: Readonly<Record<string, ClientError>> = {
  RATE_LIMITED: {code: ErrorCodes.RATE_LIMITED, status: 429, message: 'AI service is busy, please try again'},
  SERVICE_UNAVAILABLE: {code: ErrorCodes.SERVICE_UNAVAILABLE, status: 503, message: AI_UNAVAILABLE},
  TIMEOUT: {code: ErrorCodes.TIMEOUT, status: 504, message: 'AI service timed out'},
};

const UPSTREAM_ERROR: ClientError = {code: ErrorCodes.UPSTREAM_ERROR, status: 502, message: AI_UNAVAILABLE};

/** The one answer for an AIError on either transport; its own message never reaches a client, as it can echo request content. */
export function clientErrorFor(error: AIError): ClientError {
  // An own property only: a code such as `constructor` must fall back rather than find Object's prototype.
  return Object.hasOwn(PROVIDER_CONDITIONS, error.code) ? PROVIDER_CONDITIONS[error.code] : UPSTREAM_ERROR;
}
