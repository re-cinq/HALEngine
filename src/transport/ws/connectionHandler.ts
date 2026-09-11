import {WebSocket, WebSocketServer} from 'ws';
import {IncomingMessage} from 'http';
import {Duplex} from 'stream';
import {v4 as uuidv4} from 'uuid';
import type {WsAuthenticator} from '../../types/auth.js';
import type {SessionStore} from '../../types/sessionStore.js';
import type {ConnectedMessage} from '../../types/messages.js';
import {ErrorCodes} from '../../types/session.js';
import {sendError} from './sender.js';
import {isValidWsPath, rejectSocket, parseWsData} from './helpers.js';
import {log} from '../../shared/logger.js';

export interface ExtWebSocket extends WebSocket {
  isAlive: boolean;
  userId: string | number;
  workspaceId?: string | number;
  authHeaders?: {
    cookie?: string;
    authorization?: string;
    host?: string;
  };
}

export interface ConnectionHandlerDeps {
  wsAuth: WsAuthenticator;
  sessionStore: SessionStore;
  handleMessage: (
    ws: WebSocket,
    session: import('../../types/session.js').ChatSession,
    rawMessage: unknown
  ) => Promise<void>;
  basePath: string;
  onDisconnect?: (sessionId: string) => void;
}
export function createUpgradeHandler(wss: WebSocketServer, deps: ConnectionHandlerDeps) {
  return function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!isValidWsPath(request.url || '', request.headers.host || '', deps.basePath)) {
      rejectSocket(socket, '400 Bad Request');
      return;
    }

    deps
      .wsAuth(request)
      .then(user => {
        if (!user) {
          rejectSocket(socket, '401 Unauthorized');
          return;
        }

        wss.handleUpgrade(request, socket, head, ws => {
          const extWs = ws as ExtWebSocket;
          extWs.userId = user.id;
          extWs.workspaceId = user['workspaceId'] as string | number | undefined;
          extWs.authHeaders = {
            cookie: request.headers.cookie,
            authorization: request.headers.authorization || bearerFromWebSocketProtocol(request),
            host: (request.headers['x-forwarded-host'] as string | undefined) ?? request.headers.host,
          };
          extWs.isAlive = true;
          wss.emit('connection', extWs, request);
        });
      })
      .catch(() => {
        rejectSocket(socket, '500 Internal Server Error');
      });
  };
}

function bearerFromWebSocketProtocol(req: IncomingMessage): string | undefined {
  const protocol = req.headers['sec-websocket-protocol'];
  if (!protocol) return undefined;
  const token = protocol
    .split(',')
    .map(s => s.trim())
    .find(s => s.length > 0);
  return token ? `Bearer ${token}` : undefined;
}

export function createConnectionHandler(deps: ConnectionHandlerDeps, examplePrompts: string[]) {
  return function handleConnection(ws: ExtWebSocket): void {
    const sessionId = uuidv4();
    const session = deps.sessionStore.create(sessionId, ws.userId, {
      authHeaders: ws.authHeaders,
      workspaceId: ws.workspaceId,
    });

    log.info('ws', 'connected', {sessionId, userId: ws.userId});

    const connected: ConnectedMessage = {
      type: 'connected',
      sessionId,
      message: 'Connected to HAL Engine',
      examplePrompts,
    };
    ws.send(JSON.stringify(connected));

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (frame: Buffer | string) => {
      const parsed = parseWsData(frame);
      if (parsed === null) {
        sendError(ws, ErrorCodes.INVALID_FORMAT, 'Invalid JSON');
        return;
      }
      log.info('ws', 'message received', {sessionId, type: (parsed as Record<string, unknown>).type as string});
      deps.handleMessage(ws, session, parsed);
    });

    ws.on('error', (error: Error) => {
      log.error('ws', 'connection error', {sessionId, error: error.message});
    });

    ws.on('close', () => {
      log.info('ws', 'disconnected', {sessionId});
      deps.sessionStore.delete(sessionId);
      deps.onDisconnect?.(sessionId);
    });
  };
}
