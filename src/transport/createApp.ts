import express, {Request, Response, Router} from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import type {HttpAuthMiddleware} from '../types/auth.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import type {SessionStore} from '../types/sessionStore.js';
import {createChatRoutes} from './routes/chats.js';
import {httpErrorHandler} from './httpErrorHandler.js';
import {rateLimitMiddleware} from './rateLimit.js';
import type {RateLimiter} from './rateLimit.js';
import type {ForwardableHeader} from './authHeaders.js';

export interface HalAppOptions {
  corsOrigin?: string | string[];
  basePath?: string;
  authMiddleware?: HttpAuthMiddleware;
  orchestrator?: ChatOrchestrator;
  /** Gates whether the demo chat routes mount; those routes keep their own Map and never read it. */
  sessionStore?: SessionStore;
  additionalRoutes?: (router: Router) => void;
  rootRoutes?: (router: Router) => void;
  errorHandler?: express.ErrorRequestHandler;
  /** The caller headers a tool reached through the chat routes may receive; unset, none. */
  forwardHeaders?: readonly ForwardableHeader[];
  /** The request budget shared with the WebSocket transport; unset, nothing here is limited (specs/hal-engine-rate-limit/spec.md). */
  rateLimit?: RateLimiter;
}

export function createApp(options: HalAppOptions = {}) {
  const app = express();
  const basePath = options.basePath ?? '/hal';

  const corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN ?? 'http://localhost:3000';
  app.use(
    cors({
      origin: corsOrigin,
      credentials: true,
    })
  );

  app.use(express.json());
  app.use(cookieParser());

  app.get(`${basePath}/health`, (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  if (options.orchestrator && options.sessionStore) {
    const chatRoutes = createChatRoutes(
      options.orchestrator,
      options.sessionStore,
      options.authMiddleware,
      options.forwardHeaders,
      options.rateLimit
    );
    app.use(`${basePath}/chats`, chatRoutes);
  }

  // After health, so a liveness probe is never refused, and after the chat routes, which limit behind their own auth; before everything else.
  if (options.rateLimit) app.use(rateLimitMiddleware(options.rateLimit));

  if (options.additionalRoutes) {
    const router = Router();
    options.additionalRoutes(router);
    app.use(basePath, router);
  }

  if (options.rootRoutes) {
    const router = Router();
    options.rootRoutes(router);
    app.use(router);
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({error: 'Not Found'});
  });

  if (options.errorHandler) {
    app.use(options.errorHandler);
  }

  // Always last: it answers whatever a consumer's handler passes on, and never Express's HTML page with a stack.
  app.use(httpErrorHandler);

  return app;
}
