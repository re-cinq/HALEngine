import type {IncomingMessage} from 'http';
import type {NextFunction, Request, Response} from 'express';
import type {AuthenticatedUser} from './session.js';

export type WsAuthenticator = (req: IncomingMessage) => Promise<AuthenticatedUser | null>;

// `user` is optional because middleware can run and attach nothing; that case is denied at the route, not here.
export type AuthenticatedRequest<P = Request['params']> = Request<P> & {user?: AuthenticatedUser};

// Stated in terms of what it must produce, not just as a RequestHandler: attach `user`, or the routes answer 401.
export type HttpAuthMiddleware = (req: AuthenticatedRequest, res: Response, next: NextFunction) => void | Promise<void>;
