// The demo REST chat API: its whole state is the `chats` Map below, one per router and lost on restart.

// `_sessionStore` is unused by design - this router keeps that Map and builds each ChatSession inline.

// A chat id from POST /chats is not a WebSocket session id: the socket mints its own and stores that.

// Demo only - see specs/hal-engine-chat-routes/spec.md; content sits in process memory, unredacted.

import {Router, Response} from 'express';
import {randomUUID} from 'crypto';
import type {ChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import type {SessionStore} from '../../types/sessionStore.js';
import type {AuthenticatedRequest, HttpAuthMiddleware} from '../../types/auth.js';
import type {AuthenticatedUser} from '../../types/session.js';
import {AIError} from '../../types/ai.js';
import {log} from '../../shared/logger.js';
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
  _sessionStore: SessionStore,
  authMiddleware?: HttpAuthMiddleware
): Router {
  const router = Router();
  const chats = new Map<string, Chat>();

  // No middleware means no way to identify a caller, so deny rather than serve everyone as one shared user.
  const auth: HttpAuthMiddleware =
    authMiddleware ??
    ((_req, res) => {
      deny(res, 'no auth middleware is configured');
    });

  router.post('/', auth, (req: AuthenticatedRequest, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    const chatId = randomUUID();
    const createdAt = new Date().toISOString();

    chats.set(chatId, {
      id: chatId,
      userId: user.id,
      workspaceId: optionalId(user.workspaceId),
      messages: [],
      createdAt,
    });

    res.status(201).json({id: chatId, createdAt});
  });

  router.get('/:id', auth, (req: AuthenticatedRequest<{id: string}>, res: Response) => {
    const chat = authorizedChat(req, res, chats);
    if (!chat) return;

    res.json({id: chat.id, messages: chat.messages, createdAt: chat.createdAt});
  });

  router.post('/:id/messages', auth, async (req: AuthenticatedRequest<{id: string}>, res: Response) => {
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

    try {
      const session: ChatSession = {
        sessionId: chat.id,
        userId: chat.userId,
        workspaceId: chat.workspaceId,
        authHeaders: {
          cookie: req.headers.cookie,
          authorization: req.headers.authorization,
          host: (req.headers['x-forwarded-host'] as string) || req.headers.host,
        },
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
    } catch (error) {
      if (error instanceof AIError) {
        res.status(502).json({error: 'AI service temporarily unavailable'});
        return;
      }
      throw error;
    }
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
