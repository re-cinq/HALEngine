# Getting Started

This guide shows how to set up HAL Engine in your application with `createHalEngine()`.

## Installation

```bash
npm install @re-cinq/hal-engine
```

## Minimal Setup

The simplest possible setup requires two things: an AI provider configuration and a WebSocket authenticator.

<!-- doc-block: example/minimal.ts#minimal -->
```typescript
import {createHalEngine, credentialFromSubprotocol} from '@re-cinq/hal-engine';

const engine = createHalEngine({
  provider: {type: 'mock'},
  prompt: {identity: 'You are a helpful assistant.'},
  auth: {
    ws: async req => {
      const token = req.headers.authorization ?? credentialFromSubprotocol(req.headers['sec-websocket-protocol']);
      if (!token) return null;
      return {id: 'user-1'};
    },
  },
  transport: {port: 8086, basePath: '/api'},
});

await engine.start();
```

`ws` receives the WebSocket upgrade request, not a token, so pull whatever you authenticate with off `req.headers` yourself. A browser cannot set `Authorization` on a WebSocket, so it offers its token beside `hal.v1` in `Sec-WebSocket-Protocol`; `credentialFromSubprotocol` reads it the way the engine does, skipping the marker. Return an `AuthenticatedUser` — `id` is the only required field, and anything else you put on it reaches tools through `ToolContext`. Returning `null` rejects the upgrade with `401`.

This starts a server with:

- WebSocket endpoint at `ws://localhost:8086/api/ws`
- Health check at `GET http://localhost:8086/api/health`
- Demo chat routes at `POST http://localhost:8086/api/chats`, which answer `401` until `auth.http` is configured
- In-memory session storage
- The mock provider, which needs no credentials — see [Providers](../specs/hal-engine-providers/spec.md) for a real one
- No tools registered (the AI responds from its training data only)

`transport.basePath` defaults to `/hal` and `transport.port` to `8086`, or `PORT` from the environment. The example above sets both explicitly to match [`example/server.ts`](../example/server.ts), which CI type-checks.

## Adding Tools

Tools let the AI fetch data or perform actions. Register them on the engine's `toolRegistry`:

<!-- doc-block: example/with-tools.ts#with-tools -->
```typescript
import {createHalEngine, credentialFromSubprotocol, ToolRegistry} from '@re-cinq/hal-engine';
import type {ToolDefinition} from '@re-cinq/hal-engine';

const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: 'Get current weather for a location.',
  inputSchema: {
    type: 'object',
    properties: {
      location: {type: 'string', description: 'City name'},
    },
    required: ['location'],
  },
};

async function executeWeather(input: Record<string, unknown>): Promise<string> {
  const location = input.location as string;
  const weather = await fetchWeatherApi(location);
  return JSON.stringify(weather);
}

const toolRegistry = new ToolRegistry();
toolRegistry.register(weatherTool, executeWeather);

const engine = createHalEngine({
  provider: {
    type: 'bedrock',
    region: 'eu-west-1',
    modelId: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
    maxTokens: 4096,
  },
  prompt: {
    identity: 'You are a helpful weather assistant.',
    responseGuidelines:
      'Always use the get_weather tool when asked about weather. Present temperatures in the units the user prefers.',
  },
  tools: toolRegistry,
  auth: {
    ws: async req => verifyToken(req.headers.authorization ?? credentialFromSubprotocol(req.headers['sec-websocket-protocol'])),
  },
});
```

## Full Configuration

Here is every option available on `HalEngineConfig`:

<!-- doc-block: example/full-config.ts#full-config -->
```typescript
import process from 'node:process';
import {createHalEngine, InMemorySessionStore, ToolRegistry, log} from '@re-cinq/hal-engine';
import type {
  AuthenticatedRequest,
  HttpAuthMiddleware,
  Logger,
  OrchestratorHooks,
  ToolCall,
  ToolResponse,
} from '@re-cinq/hal-engine';

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
  // A human-oversight policy: a returned ToolResponse declines the call, and the model reads its result instead.
  beforeToolCall: async (_session, call: ToolCall): Promise<ToolResponse | undefined> =>
    call.name === 'send_notification'
      ? {result: 'Not performed. A human reviewer has been asked to do it.'}
      : undefined,
  // The engine writes no user-facing prose: this sentence closes a turn whose tool budget ran out.
  onToolBudgetExhausted: async () => 'I could not finish looking that up, so a colleague will follow up.',
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
    resume: {enabled: true}, // a reconnect sending ?sessionId= rejoins its own conversation; off by default, see Session Resume
    additionalRoutes: router => router.get('/ping', (_req, res) => res.json({ok: true})),
    rootRoutes: router => router.get('/', (_req, res) => res.send('<h1>Hello</h1>')),
    errorHandler: (err, _req, res, _next) => res.status(500).json({error: String(err)}), // replaces Express's default HTML error page
  },

  // OPTIONAL: Orchestrator settings
  orchestrator: {
    maxToolRounds: 5, // Max tool rounds executed (default 5); the provider is called at most maxToolRounds + 1 times
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
```

### Message lifecycle hooks

`orchestrator.hooks` takes an `OrchestratorHooks`: `beforeSession`, `beforeUserInput`, `afterUserInput`, `beforeModelResponse`, `afterModelResponse`, `afterSession`, `onError`, `beforeToolCall` and `onToolBudgetExhausted`. Every one is optional.

Four of them use their return value — `beforeUserInput` rewrites the user message, `beforeModelResponse` replaces the system prompt, `onToolBudgetExhausted` supplies the sentence that closes a turn whose tool budget ran out, and `beforeToolCall` can decline a tool call by returning the `ToolResponse` the model reads instead (see [adding a tool](adding-a-tool.md#what-happens-automatically)). `afterSession` always fires, including on error.

They fire in this order:

```
beforeSession → beforeUserInput → afterUserInput → beforeModelResponse → ...streaming (beforeToolCall × each tool call, each round)... → onToolBudgetExhausted (only on an exhausted budget) → afterModelResponse → afterSession
```

## Connecting a Client

The WebSocket protocol is documented in [websocket-protocol.md](../specs/hal-engine-websocket-protocol/spec.md). A minimal client connection:

The demo chat routes are not part of this flow. A `POST /chats` id is not a WebSocket session id -- the socket mints its own and ignores whatever follows `/ws` in the path -- so there is no create-then-connect handshake to perform. Rejoining a session after a reconnect is a query parameter, not a path segment; see [Session Resume](#session-resume).

<!-- doc-block: none -- illustrates assembling the parts by hand, which no single declaration or example region carries -->
```typescript
// 1. Connect. Offer the `hal.v1` marker (exported as HAL_WS_SUBPROTOCOL) beside the token; the server answers
// the marker, so the token never appears in the response. The server mints the session id and sends it back
// in the `connected` frame.
const ws = new WebSocket('ws://localhost:8086/api/ws', ['hal.v1', token]);

ws.onmessage = event => {
  const message = JSON.parse(event.data);

  switch (message.type) {
    case 'connected':
      console.log('Connected:', message.sessionId);
      break;
    case 'entry_upsert':
      console.log('New entry:', message.entry);
      break;
    case 'entry_delta':
      console.log('Streaming:', message.delta);
      break;
    case 'entry_commit':
      console.log('Entry finalized at index:', message.index);
      break;
    case 'stream_end':
      console.log('Response complete');
      break;
  }
};

// 2. Send a message
ws.send(
  JSON.stringify({
    type: 'user_message',
    content: 'What is the weather in Berlin?',
  })
);
```

## Session Resume

By default every connection gets a new, empty session. With `transport: {resume: {enabled: true}}`, a client that reconnects can get its conversation back: it opens `{basePath}/ws?sessionId=<id>` with the `sessionId` from its last `connected` frame. The server rejoins that conversation only if it belongs to the connection's authenticated user, answers `resumed: true` with an `entryCount`, and replays each stored entry as an `entry_upsert` at its index, or as an `entry_skip` for one a tool suppressed. Any other id, whether another user's, one never issued or one the store no longer holds, gets a fresh session and `resumed: false`, and the three are indistinguishable. The id is not a credential: it is checked against the user your `WsAuthenticator` returned.

An answer still streaming when the client reconnects, because its turn is running on the connection that dropped, is replayed finished and flagged `truncated`. The rest of that turn still goes to the old connection (re-cinq/HALEngine#49).

**Hooks.** `onConnect` and `onDisconnect` fire per connection, not per conversation: a resumed conversation gets its own `onConnect`, and the connection it replaced can report `onDisconnect` after that. So with resume on, do not erase a conversation in `onDisconnect`, as the `0.4.0` upgrade note suggests for consumers who relied on erase-on-close: the conversation erased may be the one a reconnect has just rejoined. Bound retention through the store instead.

**GDPR.** With resume on, a conversation outlives its socket, so you own the retention bound: set `maxAgeMs` on `InMemorySessionStore` (eight hours by default), use `MongoSessionStore`'s erasure methods, and see _Control what the engine keeps in server-side conversation history_ (re-cinq/HALEngine#41). An unbounded retained store is a retention breach, not a memory leak.

## Custom Session Store

The package ships two stores. `InMemorySessionStore` is the default and keeps conversations for
`maxAgeMs` (eight hours by default). `MongoSessionStore` keeps them in a collection, so a
conversation outlives the process:

<!-- doc-block: none -- a consumer's wiring, not code this repository ships -->
```typescript
import {createHalEngine, createMongoSessionStore} from '@re-cinq/hal-engine';

const session = createMongoSessionStore({url: process.env.MONGODB_URL!, dbName: 'support'});

const engine = createHalEngine({/* … */ session});
```

Which method erases, and which only evicts, is the thing to get right — see
[session-stores.md](session-stores.md). In short: only `clear` is cache-only, while `delete`,
`evict`, `eraseConversation`, `eraseOlderThan` and `eraseAll` all remove documents — so do not
point `onDisconnect` at any of them.

To write your own, implement `SessionStore`. Every member may be synchronous or return a promise,
and `save` is the write signal the engine calls once per processed user message:

<!-- doc-block: none -- a Redis store a reader writes, not code this repository ships -->
```typescript
import type {Awaitable, ChatSession, SessionCreateOptions, SessionStore} from '@re-cinq/hal-engine';

class RedisSessionStore implements SessionStore {
  private readonly cache = new Map<string, ChatSession>();

  constructor(private redis: RedisClient) {}

  create(sessionId: string, userId: string | number, options?: SessionCreateOptions): ChatSession {
    const session: ChatSession = {sessionId, userId, entries: [], ...options};
    this.cache.set(sessionId, session);
    return session;
  }

  async get(sessionId: string): Promise<ChatSession | undefined> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;

    const stored = await this.redis.get(`session:${sessionId}`);
    return stored ? (JSON.parse(stored) as ChatSession) : undefined;
  }

  // Eviction, not erasure: the engine never calls this, and a durable delete here would destroy history.
  delete(sessionId: string): boolean {
    return this.cache.delete(sessionId);
  }

  count(): Awaitable<number> {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }

  // Never persist authHeaders: the credentials outlive the request they were issued for.
  async save(session: ChatSession): Promise<void> {
    const {authHeaders: _ignored, ...storable} = session;
    await this.redis.set(`session:${session.sessionId}`, JSON.stringify(storable));
  }

  async eraseConversation(sessionId: string): Promise<void> {
    this.cache.delete(sessionId);
    await this.redis.del(`session:${sessionId}`);
  }
}
```

## Next Steps

- [architecture.md](../specs/hal-engine-architecture/spec.md) -- understand the system design and pluggable interfaces
- [adding-a-tool.md](adding-a-tool.md) -- add tools the AI can invoke
- [providers.md](../specs/hal-engine-providers/spec.md) -- configure different AI providers
- [websocket-protocol.md](../specs/hal-engine-websocket-protocol/spec.md) -- WebSocket message format reference
