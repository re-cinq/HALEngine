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
import {createHalEngine} from '@re-cinq/hal-engine';

const engine = createHalEngine({
  provider: {type: 'mock'},
  prompt: {identity: 'You are a helpful assistant.'},
  auth: {
    ws: async req => {
      const token = req.headers.authorization;
      if (!token) return null;
      return {id: 'user-1'};
    },
  },
  transport: {port: 8086, basePath: '/api'},
});

await engine.start();
```

`ws` receives the WebSocket upgrade request, not a token, so pull whatever you authenticate with off `req.headers` yourself. Return an `AuthenticatedUser` — `id` is the only required field, and anything else you put on it reaches tools through `ToolContext`. Returning `null` rejects the upgrade with `401`.

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

<!-- doc-block: none -- a worked tool for a fictional weather API, not a declaration this repository exports -->
```typescript
import {createHalEngine, ToolRegistry} from '@re-cinq/hal-engine';
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
  },
  prompt: {
    identity: 'You are a helpful weather assistant.',
    responseGuidelines:
      'Always use the get_weather tool when asked about weather. Present temperatures in the units the user prefers.',
  },
  tools: toolRegistry,
  auth: {
    ws: async req => {
      const user = await verifyToken(req.headers.authorization);
      return user && {id: user.id};
    },
  },
});
```

## Full Configuration

Here is every option available on `HalEngineConfig`:

<!-- doc-block: none -- a composed configuration using a provider this repository cannot call in CI -->
```typescript
const engine = createHalEngine({
  // REQUIRED: AI provider settings
  provider: {
    type: 'bedrock',             // 'bedrock' | 'vertex' | 'openai' | 'anthropic' | 'mock'
    region: 'eu-west-1',
    modelId: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
  },

  // REQUIRED: System prompt configuration. Every field but `identity` is optional.
  prompt: {
    identity: 'You are a helpful assistant.',
    domainContext: 'You help users with weather and general questions.',
    responseGuidelines: 'Be concise. Use tools when available.',
    toolPreamble: 'Replaces the built-in instructions telling the model when to call a tool.',
  },

  // REQUIRED: Authentication
  auth: {
    ws: async req => ({id: 'user-1'}),   // Receives the upgrade request; return null to reject
    http: authMiddleware,                // Express middleware for the chat routes (401 without it)
  },

  // OPTIONAL: Tool registry
  tools: toolRegistry,

  // OPTIONAL: Session store (defaults to InMemorySessionStore)
  session: new RedisSessionStore(redisClient),

  // OPTIONAL: Transport settings
  transport: {
    port: 3000,
    corsOrigin: ['https://example.com'],
    basePath: '/hal',                // WebSocket path prefix (default '/hal')
    heartbeatIntervalMs: 30000,      // Ping interval (default 30s)
  },

  // OPTIONAL: Orchestrator settings
  orchestrator: {
    maxToolRounds: 5,                // Max tool execution rounds (default 5)
    contextConfig: {
      maxTokens: 100000,             // Context window limit
    },
    hooks: {                         // Message lifecycle hooks; see below
      beforeUserInput: async (session, message) => message.trim(),
      onError: async (session, error) => report(error),
    },
  },

  // OPTIONAL: Logger
  logger: myLogger,

  // OPTIONAL: Lifecycle hooks. Fire-and-forget: never awaited, and a throw or
  // rejection is logged and swallowed rather than dropping the connection.
  onConnect: (session) => console.log(`Connected: ${session.sessionId}`),
  onDisconnect: (sessionId) => console.log(`Disconnected: ${sessionId}`),
});
```

### Message lifecycle hooks

`orchestrator.hooks` takes an `OrchestratorHooks`: `beforeSession`, `beforeUserInput`, `afterUserInput`, `beforeModelResponse`, `afterModelResponse`, `afterSession` and `onError`. Every one is optional.

Two of them use their return value — `beforeUserInput` rewrites the user message, and `beforeModelResponse` replaces the system prompt. `afterSession` always fires, including on error.

They fire in this order:

```
beforeSession → beforeUserInput → afterUserInput → beforeModelResponse → ...streaming... → afterModelResponse → afterSession
```

## Connecting a Client

The WebSocket protocol is documented in [websocket-protocol.md](../specs/hal-engine-websocket-protocol/spec.md). A minimal client connection:

The demo chat routes are not part of this flow. A `POST /chats` id is not a WebSocket session id -- the socket mints its own and ignores whatever follows `/ws` in the path -- so there is no create-then-connect handshake to perform.

<!-- doc-block: none -- illustrates assembling the parts by hand, which no single declaration or example region carries -->
```typescript
// 1. Connect. The server mints the session id and sends it back in the `connected` frame.
const ws = new WebSocket('ws://localhost:8086/api/ws', [token]);

ws.onmessage = (event) => {
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
ws.send(JSON.stringify({
  type: 'user_message',
  content: 'What is the weather in Berlin?',
}));
```

## Custom Session Store

Implement the `SessionStore` interface to persist sessions beyond in-memory storage:

<!-- doc-block: none -- a Redis store a reader writes, not code this repository ships -->
```typescript
import type {SessionStore} from '@re-cinq/hal-engine';
import type {ChatSession} from '@re-cinq/hal-engine';

class RedisSessionStore implements SessionStore {
  constructor(private redis: RedisClient) {}

  get(sessionId: string): ChatSession | undefined {
    const data = this.redis.get(`session:${sessionId}`);
    return data ? JSON.parse(data) : undefined;
  }

  set(sessionId: string, session: ChatSession): void {
    this.redis.set(`session:${sessionId}`, JSON.stringify(session));
  }

  delete(sessionId: string): void {
    this.redis.del(`session:${sessionId}`);
  }
}
```

## Next Steps

- [architecture.md](../specs/hal-engine-architecture/spec.md) -- understand the system design and pluggable interfaces
- [adding-a-tool.md](adding-a-tool.md) -- add tools the AI can invoke
- [providers.md](../specs/hal-engine-providers/spec.md) -- configure different AI providers
- [websocket-protocol.md](../specs/hal-engine-websocket-protocol/spec.md) -- WebSocket message format reference
