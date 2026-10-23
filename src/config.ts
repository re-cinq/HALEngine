import type {WsAuthenticator, HttpAuthMiddleware} from './types/auth.js';
import type {ForwardableHeader} from './transport/authHeaders.js';
import {rateLimiterFrom} from './transport/rateLimit.js';
import type {RateLimitConfig} from './transport/rateLimit.js';
import type {SessionStore} from './types/sessionStore.js';
import type {PromptBuilderConfig} from './infrastructure/builders/promptBuilder.js';
import type {ContextConfig} from './orchestration/conversationContext.js';
import type {ProviderConfig} from './providers/providerFactory.js';
import {withRetry} from './providers/withRetry.js';
import {withFallback} from './providers/withFallback.js';
import type {FailoverEvent} from './providers/withFallback.js';
import {withMask} from './providers/withMask.js';
import type {PromptMask} from './providers/withMask.js';
import type {RetryPolicy} from './providers/withRetry.js';
import type {Logger} from './shared/logger.js';
import {setLogger} from './shared/logger.js';
import type {ChatSession} from './types/session.js';
import type {AIProvider} from './types/ai.js';
import type {HalServer} from './transport/createServer.js';
import type {ConnectInfo} from './transport/ws/sessionResume.js';
import {PromptBuilder} from './infrastructure/builders/promptBuilder.js';
import {createChatOrchestrator} from './orchestration/chatOrchestrator.js';
import type {OrchestratorHooks, HistoryPolicy} from './orchestration/chatOrchestrator.js';
import {createProvider} from './providers/providerFactory.js';
import {ToolRegistry} from './orchestration/tools/registry.js';
import {InMemorySessionStore} from './infrastructure/stores/inMemorySessionStore.js';
import {createApp} from './transport/createApp.js';
import type {HalAppOptions} from './transport/createApp.js';
import {createServer} from './transport/createServer.js';
import type {SessionResumeOptions} from './transport/ws/sessionResume.js';
import type {ConversationHistoryOptions} from './transport/ws/conversationList.js';

export interface HalEngineConfig {
  provider: ProviderConfig;
  resilience?: RetryPolicy;
  /** Tried in order, once each, when the provider before it is unavailable; each is built at construction like the primary and gets its own `resilience` retry. */
  fallbackProviders?: ProviderConfig[];
  /** Reversible pseudonymisation at the provider boundary: the model sees `mask`'s tokens, and everything downstream the real values. */
  privacy?: {
    mask?: PromptMask;
  };
  prompt: PromptBuilderConfig;
  tools?: ToolRegistry;
  session?: SessionStore;
  transport?: {
    port?: number;
    corsOrigin?: string | string[];
    basePath?: string;
    heartbeatIntervalMs?: number;
    /** Every new socket's first frame, the connected frame, carries this as its `message`; unset, `DEFAULT_CONNECT_MESSAGE`. A deployer serving EU users may carry the AI Act Art. 50(1) disclosure here; the engine only sends it, and a front end the deployer builds discloses on its own. */
    connectMessage?: string;
    additionalRoutes?: HalAppOptions['additionalRoutes'];
    rootRoutes?: HalAppOptions['rootRoutes'];
    errorHandler?: HalAppOptions['errorHandler'];
    resume?: SessionResumeOptions;
    history?: ConversationHistoryOptions;
    /** One user's request budget across both transports: 20 a minute, 5 at once, when unset; `false` turns it off (specs/hal-engine-rate-limit/spec.md). */
    rateLimit?: RateLimitConfig | false;
  };
  auth: {
    ws: WsAuthenticator;
    http?: HttpAuthMiddleware;
    /** Which caller headers reach a tool as `authHeaders`; unset, none (specs/hal-engine-tool-header-allowlist/spec.md). */
    forwardHeaders?: ForwardableHeader[];
  };
  orchestrator?: {
    maxToolRounds?: number;
    /** How long one tool call may take before it is abandoned and answered with a timeout result; default 30000, and 0 waits forever. */
    toolTimeoutMs?: number;
    contextConfig?: Partial<ContextConfig>;
    /** Lifecycle hooks: called before and after each phase of processing a user message. */
    hooks?: OrchestratorHooks;
  };
  history?: HistoryPolicy;
  // Replaces the package's logger process-wide, not per engine: there is one `log` per process.
  logger?: Logger;
  onConnect?: (session: ChatSession, connection: ConnectInfo) => void | Promise<void>;
  onDisconnect?: (sessionId: string) => void | Promise<void>;
  /** Called once each time a provider in `fallbackProviders` takes over, with the two providers' config types, the code and the elapsed time; a throw is logged and changes nothing. */
  onFailover?: (event: FailoverEvent) => void | Promise<void>;
}

export interface HalEngine extends HalServer {
  app: ReturnType<typeof createApp>;
  orchestrator: ReturnType<typeof createChatOrchestrator>;
  toolRegistry: ToolRegistry;
}

export function createHalEngine(config: HalEngineConfig): HalEngine {
  // Before anything else builds, so a supplied logger receives this engine's first line.
  if (config.logger) setLogger(config.logger);
  refuseBlankConnectMessage(config.transport?.connectMessage);

  const toolRegistry = config.tools ?? new ToolRegistry();
  const sessionStore = config.session ?? new InMemorySessionStore();
  const basePath = config.transport?.basePath ?? '/hal';

  const provider = composeProvider(config);
  const promptBuilder = new PromptBuilder(config.prompt);
  const orchestrator = createChatOrchestrator(provider, promptBuilder, toolRegistry, {
    maxToolRounds: config.orchestrator?.maxToolRounds,
    toolTimeoutMs: config.orchestrator?.toolTimeoutMs,
    contextConfig: config.orchestrator?.contextConfig,
    hooks: config.orchestrator?.hooks,
    sessionStore,
    history: config.history,
  });

  // One limiter for both transports, so a user's HTTP and WebSocket requests draw on one budget.
  const rateLimiter = rateLimiterFrom(config.transport?.rateLimit);
  const app = createApp({
    rateLimit: rateLimiter,
    corsOrigin: config.transport?.corsOrigin,
    basePath,
    authMiddleware: config.auth.http,
    forwardHeaders: config.auth.forwardHeaders,
    orchestrator,
    sessionStore,
    additionalRoutes: config.transport?.additionalRoutes,
    rootRoutes: config.transport?.rootRoutes,
    errorHandler: config.transport?.errorHandler,
  });

  const halServer = createServer({
    app,
    wsAuth: config.auth.ws,
    forwardHeaders: config.auth.forwardHeaders,
    sessionStore,
    orchestrator,
    toolRegistry,
    basePath,
    port: config.transport?.port,
    heartbeatIntervalMs: config.transport?.heartbeatIntervalMs,
    connectMessage: config.transport?.connectMessage,
    onConnect: config.onConnect,
    onDisconnect: config.onDisconnect,
    resume: config.transport?.resume,
    history: config.transport?.history,
    rateLimiter,
  });

  return {
    ...halServer,
    app,
    orchestrator,
    toolRegistry,
  };
}

// A blank message set on purpose is indistinguishable from the default having been dropped, so it fails construction.
function refuseBlankConnectMessage(connectMessage: string | undefined): void {
  if (connectMessage === undefined || connectMessage.trim() !== '') return;
  throw new Error(
    'transport.connectMessage is blank: set the text the connected frame should carry, or leave it unset'
  );
}

/** The provider the orchestrator receives: retry innermost per provider, then the fallback chain, then the mask; with none configured, exactly what `create` returned. */
export function composeProvider(
  config: Pick<HalEngineConfig, 'provider' | 'resilience' | 'fallbackProviders' | 'privacy' | 'onFailover'>,
  create: (providerConfig: ProviderConfig) => AIProvider = createProvider
): AIProvider {
  const resilient = (provider: AIProvider): AIProvider =>
    config.resilience ? withRetry(provider, config.resilience) : provider;
  const primary = resilient(create(config.provider));
  const fallbacks = config.fallbackProviders ?? [];
  // Every fallback is built now, so a misconfigured one fails at startup rather than during an outage.
  const routed =
    fallbacks.length === 0
      ? primary
      : withFallback(
          primary,
          fallbacks.map(fallback => resilient(create(fallback))),
          {labels: [config.provider.type, ...fallbacks.map(fallback => fallback.type)], onFailover: config.onFailover}
        );
  // Outermost, so a retry replays masked parameters and every vendor tried receives text from one binding.
  const mask = config.privacy?.mask;
  return mask ? withMask(routed, mask) : routed;
}
