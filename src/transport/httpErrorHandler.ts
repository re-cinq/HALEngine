import {STATUS_CODES} from 'node:http';
import type {ErrorRequestHandler} from 'express';
import {AIError} from '../types/ai.js';
import {log} from '../shared/logger.js';

interface ErrorResponse {
  status: number;
  error: string;
}

const AI_UNAVAILABLE = 'AI service temporarily unavailable';

// The three provider conditions a caller can wait out; every other AIError code is the vendor failing, so 502.
const AI_ERROR_RESPONSES: Readonly<Record<string, ErrorResponse>> = {
  RATE_LIMITED: {status: 429, error: 'AI service is busy, please try again'},
  SERVICE_UNAVAILABLE: {status: 503, error: AI_UNAVAILABLE},
  TIMEOUT: {status: 504, error: 'AI service timed out'},
};
const AI_ERROR_FALLBACK: ErrorResponse = {status: 502, error: AI_UNAVAILABLE};

const LOWEST_ERROR_STATUS = 400;
const PAST_HIGHEST_ERROR_STATUS = 600;
const INTERNAL_SERVER_ERROR: ErrorResponse = {status: 500, error: 'Internal Server Error'};

// Registered last by createApp; a consumer's own errorHandler runs first, and this answers only what it passes on.
export const httpErrorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  const {status, error} = responseFor(err);
  log.error('http', 'unhandled error', {
    method: req.method,
    path: req.path,
    status,
    code: err instanceof AIError ? err.code : null,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  // Once a byte is written there is no JSON to add; Express destroys the socket instead.
  if (res.headersSent) return next(err);
  res.status(status).json({error});
};

function responseFor(err: unknown): ErrorResponse {
  const explicit = explicitStatus(err);
  if (explicit !== undefined) return explicit;
  if (err instanceof AIError) return AI_ERROR_RESPONSES[err.code] ?? AI_ERROR_FALLBACK;
  return INTERNAL_SERVER_ERROR;
}

// finalhandler's [400, 600) window, narrowed to statuses Node has a phrase for; anything else is a mistake, so 500.
function explicitStatus(err: unknown): ErrorResponse | undefined {
  if (!(err instanceof Object)) return undefined;
  const {status, statusCode} = err as {status?: unknown; statusCode?: unknown};
  const candidate = typeof status === 'number' ? status : statusCode;
  if (typeof candidate !== 'number' || candidate < LOWEST_ERROR_STATUS || candidate >= PAST_HIGHEST_ERROR_STATUS) {
    return undefined;
  }
  const phrase = STATUS_CODES[candidate];
  return phrase === undefined ? undefined : {status: candidate, error: phrase};
}
