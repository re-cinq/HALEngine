import http from 'http';
import {WebSocketServer} from 'ws';
import type {Express} from 'express';
import type {WsAuthenticator} from '../types/auth.js';
import type {SessionStore} from '../types/sessionStore.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import type {ToolRegistry} from '../orchestration/tools/registry.js';
import {createUpgradeHandler, createConnectionHandler, ExtWebSocket} from './ws/connectionHandler.js';
import {createMessageHandler} from './ws/messageHandler.js';
import {selectSubprotocol} from './ws/subprotocol.js';
import type {ConnectInfo, SessionResumeOptions} from './ws/sessionResume.js';
import type {ConversationHistoryOptions} from './ws/conversationList.js';
import {log} from '../shared/logger.js';

export interface HalServerOptions {
  app: Express;
  wsAuth: WsAuthenticator;
  sessionStore: SessionStore;
  orchestrator: ChatOrchestrator;
  toolRegistry?: ToolRegistry;
  basePath?: string;
  port?: number;
  heartbeatIntervalMs?: number;
  onConnect?: (session: import('../types/session.js').ChatSession, connection: ConnectInfo) => void | Promise<void>;
  onDisconnect?: (sessionId: string) => void | Promise<void>;
  resume?: SessionResumeOptions;
  history?: ConversationHistoryOptions;
}

export interface HalServer {
  server: http.Server;
  wss: WebSocketServer;
  start: (port?: number) => Promise<void>;
  stop: () => Promise<void>;
}

export function createServer(options: HalServerOptions): HalServer {
  const basePath = options.basePath ?? '/hal';

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: selectSubprotocol,
  });

  // A list whose rows cannot be opened is a deployment slip worth saying out loud, not worth refusing to start over.
  if (options.history?.enabled && !options.resume?.enabled) {
    log.warn('server', 'conversation history is on but resume is off, so a listed conversation cannot be rejoined');
  }

  // Asking for a label on a list this server does not serve: inert, and silence would read as previews being on.
  if (options.history?.preview === true && !options.history.enabled) {
    log.warn('server', 'conversation previews are on but conversation history is off, so no list is served at all');
  }

  const handleMessage = createMessageHandler(options.orchestrator, {
    sessionStore: options.sessionStore,
    history: options.history,
  });
  const examplePrompts = options.toolRegistry?.getExamplePrompts() ?? [];

  const deps = {
    wsAuth: options.wsAuth,
    sessionStore: options.sessionStore,
    handleMessage,
    basePath,
    onConnect: options.onConnect,
    onDisconnect: options.onDisconnect,
    resume: options.resume,
  };

  const handleUpgrade = createUpgradeHandler(wss, deps);
  const handleConnection = createConnectionHandler(deps, examplePrompts);

  const server = http.createServer(options.app);

  server.on('upgrade', (request, socket, head) => {
    handleUpgrade(request, socket, head);
  });

  wss.on('connection', ws => {
    handleConnection(ws as ExtWebSocket);
  });

  const heartbeatMs = options.heartbeatIntervalMs ?? 30_000;

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach(ws => {
      const extWs = ws as ExtWebSocket;
      if (!extWs.isAlive) {
        extWs.terminate();
        return;
      }
      extWs.isAlive = false;
      extWs.ping();
    });
  }, heartbeatMs);

  // The listening socket should hold the process open, not the heartbeat: an engine never started must not.
  heartbeatInterval.unref();

  wss.on('close', () => clearInterval(heartbeatInterval));

  return {
    server,
    wss,
    start: (port?: number) =>
      new Promise<void>((resolve, reject) => {
        // Refused before the handlers are touched: `listen` throws on a running server, and the swap below stripped its handler.
        if (server.listening) {
          reject(new Error('HAL Engine is already started'));
          return;
        }

        // ?? not ||, so a configured port 0 means "let the OS choose" rather than 8086.
        const p = port ?? options.port ?? (Number(process.env.PORT) || 8086);

        // Without this an EADDRINUSE settles nothing and takes the process down as an unhandled event.
        const onError = (error: Error) => reject(error);
        server.once('error', onError);

        // A listener left from a previous start would report this bind failure as a running server breaking.
        server.removeListener('error', logLateError);

        server.listen(p, () => {
          server.removeListener('error', onError);

          // Past the listen window nothing is listening, and an 'error' with no handler ends the process.
          server.on('error', logLateError);

          // The bound port, not the requested one: a configured 0 means the OS chose it.
          log.info('server', 'HAL Engine started', {port: boundPort(server, p)});
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));
        wss.close();
        clearInterval(heartbeatInterval);

        // Nothing to close after a refused start or a second stop: `close` would reject for a server that never ran.
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}

// A running server's error is a condition to report, not a reason to exit; the consumer decides what to do.
function logLateError(error: Error): void {
  log.error('server', 'server error after start', {error: error.message});
}

function boundPort(server: http.Server, requested: number): number {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : requested;
}
