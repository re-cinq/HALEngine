import {WebSocket, WebSocketServer} from 'ws';
import {IncomingMessage} from 'http';
import {Duplex} from 'stream';
import {v4 as uuidv4} from 'uuid';
import type {WsAuthenticator} from '../../types/auth.js';
import type {SessionStore} from '../../types/sessionStore.js';
import type {ConnectedMessage} from '../../types/messages.js';
import type {AuthenticatedUser, ChatSession} from '../../types/session.js';
import {ErrorCodes} from '../../types/session.js';
import {sendError} from './sender.js';
import {isValidWsPath, rejectSocket, parseWsData} from './helpers.js';
import {credentialFromSubprotocol} from './subprotocol.js';
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
  onConnect?: (session: import('../../types/session.js').ChatSession) => void | Promise<void>;
  onDisconnect?: (sessionId: string) => void | Promise<void>;
}
export function createUpgradeHandler(wss: WebSocketServer, deps: ConnectionHandlerDeps) {
  return function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Nothing may throw out of this listener: the `upgrade` event has no catch above it, so a throw ends the process.
    if (!request.headers.host || !isValidWsPath(request.url || '', deps.basePath)) {
      rejectSocket(socket, '400 Bad Request');
      return;
    }

    authenticate(deps.wsAuth, request)
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
      .catch((error: unknown) => {
        // The type alone: an authenticator's message can carry the credential it was checking.
        log.error('ws', 'authenticator failed', {errorType: error instanceof Error ? error.name : typeof error});
        rejectSocket(socket, '500 Internal Server Error');
      });
  };
}

// Async, so a synchronous throw becomes a rejection (answered 500) and a user returned without a promise still resolves.
async function authenticate(wsAuth: WsAuthenticator, request: IncomingMessage): Promise<AuthenticatedUser | null> {
  return wsAuth(request);
}

function bearerFromWebSocketProtocol(req: IncomingMessage): string | undefined {
  const token = credentialFromSubprotocol(req.headers['sec-websocket-protocol']);
  return token ? `Bearer ${token}` : undefined;
}

export function createConnectionHandler(deps: ConnectionHandlerDeps, examplePrompts: string[]) {
  return function handleConnection(ws: ExtWebSocket): void {
    // The listener stays synchronous: an async one rejects into the emitter, and node ends the process on that.
    openSession(deps, examplePrompts, ws).catch((error: unknown) => {
      log.error('ws', 'connection setup failed', {error: messageOf(error)});
      // Resumed before closing: a paused socket never reads the close frame it would be waiting for.
      ws.resume();
      ws.close(1011, 'Connection setup failed');
    });
  };
}

async function openSession(deps: ConnectionHandlerDeps, examplePrompts: string[], ws: ExtWebSocket): Promise<void> {
  const sessionId = uuidv4();
  const state = {closed: false, settled: false, notified: false, delivered: false};
  const held: {session?: ChatSession} = {};

  ws.on('error', (error: Error) => {
    log.error('ws', 'connection error', {sessionId, error: error.message});
  });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('close', () => {
    state.closed = true;
    log.info('ws', 'disconnected', {sessionId});
    if (state.settled) endSession(deps, sessionId, state, held);
  });

  // Paused across the await so a frame arriving before the message listener exists is buffered, not dropped.
  ws.pause();

  const session = await createSession(deps, sessionId, ws);
  state.settled = true;

  if (session === undefined) {
    // Resumed before closing: ws.close() on a paused socket waits for a close frame it can never read.
    ws.resume();
    ws.close(1011, 'Session store unavailable');
    return;
  }

  if (state.closed) {
    // Held first: a store that implements no evict still holds this session, and it carries the caller's credentials.
    held.session = session;
    await evictSession(deps, sessionId);
    endSession(deps, sessionId, state, held);
    ws.resume();
    return;
  }

  held.session = session;

  log.info('ws', 'connected', {sessionId, userId: ws.userId});

  const connected: ConnectedMessage = {
    type: 'connected',
    sessionId,
    message: 'Connected to HAL Engine',
    examplePrompts,
  };
  // A socket that died between the check above and this frame must not leave the session it was created for behind.
  try {
    ws.send(JSON.stringify(connected));
  } catch (error) {
    log.error('ws', 'connected frame failed', {sessionId, error: messageOf(error)});
    await evictSession(deps, sessionId);
    endSession(deps, sessionId, state, held);
    ws.resume();
    ws.close(1011, 'Connection setup failed');
    return;
  }

  state.delivered = true;

  // Deferred, not inline: a synchronous throw in the `connection` listener corrupts an already-upgraded socket.

  // A microtask, not setImmediate: it drains before the loop delivers any inbound frame on this socket.
  queueMicrotask(() => runHook('onConnect', sessionId, () => deps.onConnect?.(session)));

  ws.on('message', (frame: Buffer | string) => {
    const parsed = parseWsData(frame);
    if (parsed === null) {
      sendError(ws, ErrorCodes.INVALID_FORMAT, 'Invalid JSON');
      return;
    }
    log.info('ws', 'message received', {sessionId, type: (parsed as Record<string, unknown>).type as string});
    deps.handleMessage(ws, session, parsed);
  });

  ws.resume();
}

// `undefined` rather than a throw: one store failure closes one socket instead of ending the process.
async function createSession(
  deps: ConnectionHandlerDeps,
  sessionId: string,
  ws: ExtWebSocket
): Promise<ChatSession | undefined> {
  try {
    return await deps.sessionStore.create(sessionId, ws.userId, {
      authHeaders: ws.authHeaders,
      workspaceId: ws.workspaceId,
    });
  } catch (error) {
    log.error('ws', 'session create failed', {userId: ws.userId, error: messageOf(error)});
    sendError(ws, ErrorCodes.SERVER_ERROR, 'Could not start a session');
    return undefined;
  }
}

// The close path erases nothing: the conversation outlives its socket, and `onDisconnect` is the consumer's seam.
function endSession(
  deps: ConnectionHandlerDeps,
  sessionId: string,
  state: {notified: boolean; delivered: boolean},
  held: {session?: ChatSession}
): void {
  if (state.notified) return;
  state.notified = true;

  // The credentials were issued for a request that is over; the entries are what the consumer keeps.
  if (held.session) held.session.authHeaders = undefined;

  // Only for a session the consumer was actually handed: onDisconnect is the other half of onConnect, not of a socket.
  if (!state.delivered) return;

  runHook('onDisconnect', sessionId, () => deps.onDisconnect?.(sessionId));
}

// Only for a session no client ever received: it has no entries and nothing to migrate.
async function evictSession(deps: ConnectionHandlerDeps, sessionId: string): Promise<void> {
  try {
    await deps.sessionStore.evict?.(sessionId);
  } catch (error) {
    log.error('ws', 'session evict failed', {sessionId, error: messageOf(error)});
  }
}

// Consumer hooks are fire-and-forget: the engine never awaits one and never lets one take the connection down.
function runHook(name: string, sessionId: string, call: () => void | Promise<void>): void {
  try {
    // Promise.resolve also absorbs a thenable from another realm, where `instanceof Promise` is false.
    void Promise.resolve(call()).catch((error: unknown) => logHookFailure(name, sessionId, error));
  } catch (error) {
    logHookFailure(name, sessionId, error);
  }
}

function logHookFailure(name: string, sessionId: string, error: unknown): void {
  log.error('ws', `${name} hook failed`, {sessionId, error: messageOf(error)});
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
  return String(error);
}
