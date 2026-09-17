// Every option HalEngineConfig declares, in one composed configuration the compiler checks.

// #region full-config
import process from 'node:process';
import {createHalEngine, InMemorySessionStore, ToolRegistry, log} from '../src/index.js';
import type {AuthenticatedRequest, HttpAuthMiddleware, Logger, OrchestratorHooks} from '../src/index.js';

const toolRegistry = new ToolRegistry();

// Your own SessionStore goes here; InMemorySessionStore is the default and loses everything on restart.
const sessionStore = new InMemorySessionStore();

// The chat routes answer 401 until this attaches a user; authenticating without attaching one is the same to them.
const authMiddleware: HttpAuthMiddleware = (req: AuthenticatedRequest, _res, next) => {
  req.user = {id: 'user-1'};
  next();
};

const hooks: OrchestratorHooks = {
  beforeSession: async session => log.info('app', 'session opened', {sessionId: session.sessionId}),
  beforeUserInput: async (_session, userMessage) => userMessage.trim(),
  afterUserInput: async (_session, userMessage) => log.info('app', 'received', {length: userMessage.length}),
  beforeModelResponse: async (_session, systemPrompt) => systemPrompt,
  afterModelResponse: async (_session, _responseText, usage) => log.info('app', 'answered', {usage}),
  afterSession: async session => log.info('app', 'session closed', {sessionId: session.sessionId}),
  onError: async (_session, error) => log.error('app', 'orchestration failed', {error: error.message}),
};

// A Logger of your own; this one writes plain lines to stderr. Passing `log` itself here is treated as passing none.
const line = (level: string, category: string, message: string) => `${level} ${category}: ${message}\n`;
const myLogger: Logger = {
  debug: (category, message) => process.stderr.write(line('debug', category, message)),
  info: (category, message) => process.stderr.write(line('info', category, message)),
  warn: (category, message) => process.stderr.write(line('warn', category, message)),
  error: (category, message) => process.stderr.write(line('error', category, message)),
};

const engine = createHalEngine({
  // REQUIRED: AI provider settings
  provider: {
    type: 'bedrock', // 'bedrock' | 'vertex' | 'openai' | 'anthropic' | 'mock'
    region: 'eu-west-1',
    modelId: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
    maxTokens: 4096, // REQUIRED for bedrock
  },

  // REQUIRED: System prompt configuration. Every field but `identity` is optional.
  prompt: {
    identity: 'You are a helpful assistant.',
    domainContext: 'You help users with weather and general questions.',
    responseGuidelines: 'Be concise. Use tools when available.',
    toolPreamble: 'Replaces the built-in instructions telling the model when to call a tool.',
  },

  // REQUIRED: Authentication. `ws` receives the upgrade request; return null to reject it.
  auth: {
    ws: async () => ({id: 'user-1'}),
    http: authMiddleware,
  },

  // OPTIONAL: Tool registry
  tools: toolRegistry,

  // OPTIONAL: Session store (defaults to InMemorySessionStore)
  session: sessionStore,

  // OPTIONAL: Transport settings
  transport: {
    port: 8086, // 0 lets the OS choose; unset falls through to PORT, then 8086
    corsOrigin: ['https://example.com'],
    // basePath defaults to '/hal' and the heartbeat to 30s.
    basePath: '/hal',
    heartbeatIntervalMs: 30_000,
    additionalRoutes: router => router.get('/ping', (_req, res) => res.json({ok: true})), // mounted under basePath, no auth gate
    rootRoutes: router => router.get('/', (_req, res) => res.send('<h1>Hello</h1>')), // mounted at /, after basePath router
    errorHandler: (err, _req, res, _next) => res.status(500).json({error: String(err)}), // replaces Express default HTML errors
  },

  // OPTIONAL: Orchestrator settings
  orchestrator: {
    maxToolRounds: 5, // Max tool execution rounds (default 5)
    contextConfig: {
      // How many messages are kept, and how much of each.
      maxMessages: 50,
      maxContentLength: 4000,
    },
    hooks,
  },

  // OPTIONAL: Logger. Process-wide, not per engine - see docs/logging.md.
  logger: myLogger,

  // OPTIONAL: Lifecycle hooks. Fire-and-forget: never awaited, and a throw is logged and swallowed.
  onConnect: session => log.info('app', 'connected', {sessionId: session.sessionId}),
  onDisconnect: sessionId => log.info('app', 'disconnected', {sessionId}),
});
// #endregion

void engine;
