import type {IncomingMessage} from 'http';
import type {RequestHandler} from 'express';
import type {AuthenticatedUser} from './session.js';

export type WsAuthenticator = (req: IncomingMessage) => Promise<AuthenticatedUser | null>;

export type HttpAuthMiddleware = RequestHandler;
