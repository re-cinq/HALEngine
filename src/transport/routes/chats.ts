import {Router, Request, Response} from 'express';
import {randomUUID} from 'crypto';
import type {ChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import type {SessionStore} from '../../types/sessionStore.js';
import type {HttpAuthMiddleware} from '../../types/auth.js';
import {AIError} from '../../types/ai.js';
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

  const auth = authMiddleware ?? ((_req: Request, _res: Response, next: () => void) => next());

  router.post('/', auth, (req: Request, res: Response) => {
    const chatId = randomUUID();
    const userId =
      (req as Request & {user?: {id: string | number; workspaceId?: string | number}}).user?.id ?? 'anonymous';
    const workspaceId = (req as Request & {user?: {workspaceId?: string | number}}).user?.workspaceId;
    const createdAt = new Date().toISOString();

    chats.set(chatId, {
      id: chatId,
      userId,
      workspaceId,
      messages: [],
      createdAt,
    });

    res.status(201).json({id: chatId, createdAt});
  });

  router.get('/:id', auth, (req: Request<{id: string}>, res: Response) => {
    const chat = authorizedChat(req, res, chats);
    if (!chat) return;

    res.json({id: chat.id, messages: chat.messages, createdAt: chat.createdAt});
  });

  router.post('/:id/messages', auth, async (req: Request<{id: string}>, res: Response) => {
    const chat = authorizedChat(req, res, chats);
    if (!chat) return;

    const {content} = req.body as {content: string};

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

// null means this already answered 404 or 403, so the caller must return.
function authorizedChat(req: Request<{id: string}>, res: Response, chats: Map<string, Chat>): Chat | null {
  const chat = chats.get(req.params.id);

  if (!chat) {
    res.status(404).json({error: 'Chat not found'});
    return null;
  }

  const userId = (req as Request<{id: string}> & {user?: {id: string | number}}).user?.id;
  if (userId && chat.userId !== userId) {
    res.status(403).json({error: 'Forbidden'});
    return null;
  }

  return chat;
}
