// _sessionStore is unused by design; the Map is process-local; a REST chat id is not a WebSocket session id.

import {Router, Response, RequestHandler} from 'express';
import {randomUUID} from 'crypto';
import type {ChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import type {SessionStore} from '../../types/sessionStore.js';
import type {AuthenticatedRequest, HttpAuthMiddleware} from '../../types/auth.js';
import type {AuthenticatedUser} from '../../types/session.js';
import {log} from '../../shared/logger.js';
import {filterAuthHeaders, forwardedHeaders} from '../authHeaders.js';
import type {ForwardableHeader} from '../authHeaders.js';
import {rateLimitMiddleware} from '../rateLimit.js';
import type {RateLimiter} from '../rateLimit.js';
import type {ChatSession, SessionEntry} from '../../types/session.js';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface Chat {
  id: string;
  userId: string | number;
  workspaceId?: string | number;
  messages: ChatMessage[];
  createdAt: string;
}
export function createChatRoutes(
  orchestrator: ChatOrchestrator,
  sessionStore: SessionStore,
  authMiddleware?: HttpAuthMiddleware,
  forwardHeaders?: readonly ForwardableHeader[],
  rateLimit?: RateLimiter
): Router {
  const router = Router();
  // After auth on every route, so a chat request is keyed on its user rather than on an address an office shares.
  const limit: RequestHandler = rateLimit ? rateLimitMiddleware(rateLimit) : (_req, _res, next) => next();
  // Resolved once at construction, so the headers a turn may carry are fixed before any request arrives.
  const allow = forwardedHeaders(forwardHeaders);
  const chats = new Map<string, Chat>();

  // No middleware means no way to identify a caller, so deny rather than serve everyone as one shared user.
  const auth: HttpAuthMiddleware =
    authMiddleware ??
    ((_req, res) => {
      deny(res, 'no auth middleware is configured');
    });

  router.post('/', auth, limit, async (req: AuthenticatedRequest, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    const chatId = randomUUID();
    const createdAt = new Date().toISOString();

    const workspaceId = optionalId(user.workspaceId);
    // Stored before it is listed, so a store that refuses the write leaves no chat behind that it never held.
    await sessionStore.create(chatId, user.id, {workspaceId});

    chats.set(chatId, {
      id: chatId,
      userId: user.id,
      workspaceId,
      messages: [],
      createdAt,
    });

    res.status(201).json({id: chatId, createdAt});
  });

  router.get('/:id', auth, limit, (req: AuthenticatedRequest<{id: string}>, res: Response) => {
    const chat = authorizedChat(req, res, chats);
    if (!chat) return;

    res.json({id: chat.id, messages: chat.messages, createdAt: chat.createdAt});
  });

  router.post('/:id/messages', auth, limit, async (req: AuthenticatedRequest<{id: string}>, res: Response) => {
    const chat = authorizedChat(req, res, chats);
    if (!chat) return;

    // `req.body` is undefined when no parser claimed the content type; destructuring that threw past the guard.
    const {content} = (req.body ?? {}) as {content?: string};

    if (!content || typeof content !== 'string') {
      res.status(400).json({error: 'Message content is required'});
      return;
    }

    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };
    chat.messages.push(userMessage);

    const session: ChatSession = {
      sessionId: chat.id,
      userId: chat.userId,
      workspaceId: chat.workspaceId,
      authHeaders: filterAuthHeaders(
        {
          cookie: req.headers.cookie,
          authorization: req.headers.authorization,
          host: (req.headers['x-forwarded-host'] as string) || req.headers.host,
        },
        allow
      ),
      entries: chatMessagesToEntries(chat.messages),
    };

    const aiContent = await orchestrator.processMessage(session);
    const assistantMessage: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: aiContent,
      timestamp: new Date().toISOString(),
    };
    chat.messages.push(assistantMessage);

    res.status(201).json({userMessage, assistantMessage});
  });

  return router;
}

function chatMessagesToEntries(messages: ChatMessage[]): SessionEntry[] {
  return messages.map(m =>
    m.role === 'user'
      ? {role: 'user' as const, content: m.content, timestamp: m.timestamp}
      : {role: 'assistant' as const, content: m.content, timestamp: m.timestamp, isStreaming: false}
  );
}

// null means this already answered 401, 404 or 403, so the caller must return.
function authorizedChat(req: AuthenticatedRequest<{id: string}>, res: Response, chats: Map<string, Chat>): Chat | null {
  const user = requireUser(req, res);
  if (!user) return null;

  const chat = chats.get(req.params.id);

  if (!chat) {
    res.status(404).json({error: 'Chat not found'});
    return null;
  }

  if (chat.userId !== user.id) {
    res.status(403).json({error: 'Forbidden'});
    return null;
  }

  return chat;
}

// null means this already answered 401, so the caller must return.
function requireUser(
  req: AuthenticatedRequest | AuthenticatedRequest<{id: string}>,
  res: Response
): AuthenticatedUser | null {
  const {user} = req;

  if (!user || !isUsableId(user.id)) {
    deny(res, 'the configured middleware attached no usable user id');
    return null;
  }

  return user;
}

// One line per refusal, and `reason` is a fixed string: nothing request-derived reaches the log.
function deny(res: Response, reason: string): void {
  log.warn('http', 'chat request refused', {reason});
  res.status(401).json({error: 'Unauthorized'});
}

// Middleware is consumer-supplied, so `id` is untrusted here whatever AuthenticatedUser declares.
function isUsableId(id: unknown): id is string | number {
  // 0 is a legal id, so only an absent, null or empty id is unauthenticated - never a falsy one.
  return typeof id === 'number' || (typeof id === 'string' && id !== '');
}

function optionalId(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}
