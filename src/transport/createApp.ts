import express, {Request, Response, Router} from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import type {HttpAuthMiddleware} from '../types/auth.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import type {SessionStore} from '../types/sessionStore.js';
import {createChatRoutes} from './routes/chats.js';

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
    const chatRoutes = createChatRoutes(options.orchestrator, options.sessionStore, options.authMiddleware);
    app.use(`${basePath}/chats`, chatRoutes);
  }

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

  return app;
}
