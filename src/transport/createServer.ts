import http from 'http';
import {WebSocketServer} from 'ws';
import type {Express} from 'express';
import type {WsAuthenticator} from '../types/auth.js';
import type {SessionStore} from '../types/sessionStore.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import type {ToolRegistry} from '../orchestration/tools/registry.js';
import {createUpgradeHandler, createConnectionHandler, ExtWebSocket} from './ws/connectionHandler.js';
import {createMessageHandler} from './ws/messageHandler.js';
import {log} from '../shared/logger.js';

export interface HalServerOptions {
  app: Express;
  wsAuth: WsAuthenticator;
  sessionStore: SessionStore;
  orchestrator: ChatOrchestrator;
  toolRegistry?: ToolRegistry;
  basePath?: string;
  heartbeatIntervalMs?: number;
  onConnect?: (session: import('../types/session.js').ChatSession) => void;
  onDisconnect?: (sessionId: string) => void;
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
    handleProtocols: (protocols: Set<string>) => {
      const [requested] = protocols;
      return requested || false;
    },
  });

  const handleMessage = createMessageHandler(options.orchestrator);
  const examplePrompts = options.toolRegistry?.getExamplePrompts() ?? [];

  const deps = {
    wsAuth: options.wsAuth,
    sessionStore: options.sessionStore,
    handleMessage,
    basePath,
    onDisconnect: options.onDisconnect,
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

  wss.on('close', () => clearInterval(heartbeatInterval));

  return {
    server,
    wss,
    start: (port?: number) =>
      new Promise<void>(resolve => {
        const p = port ?? (Number(process.env.PORT) || 8086);
        server.listen(p, () => {
          log.info('server', 'HAL Engine started', {port: p});
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));
        wss.close();
        clearInterval(heartbeatInterval);
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}
