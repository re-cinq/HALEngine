import type {WsAuthenticator, HttpAuthMiddleware} from './types/auth.js';
import type {SessionStore} from './types/sessionStore.js';
import type {PromptBuilderConfig} from './infrastructure/builders/promptBuilder.js';
import type {ContextConfig} from './orchestration/conversationContext.js';
import type {ProviderConfig} from './providers/providerFactory.js';
import type {Logger} from './shared/logger.js';
import type {ChatSession} from './types/session.js';
import type {HalServer} from './transport/createServer.js';
import {PromptBuilder} from './infrastructure/builders/promptBuilder.js';
import {createChatOrchestrator} from './orchestration/chatOrchestrator.js';
import type {OrchestratorHooks} from './orchestration/chatOrchestrator.js';
import {createProvider} from './providers/providerFactory.js';
import {ToolRegistry} from './orchestration/tools/registry.js';
import {InMemorySessionStore} from './infrastructure/stores/inMemorySessionStore.js';
import {createApp} from './transport/createApp.js';
import {createServer} from './transport/createServer.js';

export interface HalEngineConfig {
  provider: ProviderConfig;
  prompt: PromptBuilderConfig;
  tools?: ToolRegistry;
  session?: SessionStore;
  transport?: {
    port?: number;
    corsOrigin?: string | string[];
    basePath?: string;
    heartbeatIntervalMs?: number;
  };
  auth: {
    ws: WsAuthenticator;
    http?: HttpAuthMiddleware;
  };
  orchestrator?: {
    maxToolRounds?: number;
    contextConfig?: Partial<ContextConfig>;
    hooks?: OrchestratorHooks;
  };
  logger?: Logger;
  onConnect?: (session: ChatSession) => void | Promise<void>;
  onDisconnect?: (sessionId: string) => void | Promise<void>;
}

export interface HalEngine extends HalServer {
  app: ReturnType<typeof createApp>;
  orchestrator: ReturnType<typeof createChatOrchestrator>;
  toolRegistry: ToolRegistry;
}

export function createHalEngine(config: HalEngineConfig): HalEngine {
  const toolRegistry = config.tools ?? new ToolRegistry();
  const sessionStore = config.session ?? new InMemorySessionStore();
  const basePath = config.transport?.basePath ?? '/hal';

  const provider = createProvider(config.provider);
  const promptBuilder = new PromptBuilder(config.prompt);
  const orchestrator = createChatOrchestrator(provider, promptBuilder, toolRegistry, {
    maxToolRounds: config.orchestrator?.maxToolRounds,
    contextConfig: config.orchestrator?.contextConfig,
    hooks: config.orchestrator?.hooks,
  });

  const app = createApp({
    corsOrigin: config.transport?.corsOrigin,
    basePath,
    authMiddleware: config.auth.http,
    orchestrator,
    sessionStore,
  });

  const halServer = createServer({
    app,
    wsAuth: config.auth.ws,
    sessionStore,
    orchestrator,
    toolRegistry,
    basePath,
    port: config.transport?.port,
    heartbeatIntervalMs: config.transport?.heartbeatIntervalMs,
    onConnect: config.onConnect,
    onDisconnect: config.onDisconnect,
  });

  return {
    ...halServer,
    app,
    orchestrator,
    toolRegistry,
  };
}
