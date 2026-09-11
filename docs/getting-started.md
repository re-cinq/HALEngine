# Getting Started

This guide shows how to set up hal-engine in your application with `createHalEngine()`.

## Installation

```bash
npm install @re-cinq/hal-engine
```

## Minimal Setup

The simplest possible setup requires two things: an AI provider configuration and a WebSocket authenticator.

```typescript
import {createHalEngine} from '@re-cinq/hal-engine';

const engine = createHalEngine({
  provider: {
    type: 'bedrock',
    region: 'eu-west-1',
    modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
  },
  prompt: {
    identity: 'You are a helpful assistant.',
  },
  auth: {
    ws: async (token) => {
      const user = await verifyToken(token);
      return {userId: user.id, workspaceId: user.workspaceId};
    },
  },
});

engine.listen(3000);
console.log('hal-engine running on port 3000');
```

This starts a server with:
- WebSocket endpoint at `ws://localhost:3000/hal/ws/{chatId}`
- HTTP endpoint at `POST http://localhost:3000/hal/chats`
- In-memory session storage
- No tools registered (the AI responds from its training data only)

## Adding Tools

Tools let the AI fetch data or perform actions. Register them on the engine's `toolRegistry`:

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
    modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
  },
  prompt: {
    identity: 'You are a helpful weather assistant.',
    guidelines: [
      'Always use the get_weather tool when asked about weather.',
      'Present temperatures in the units the user prefers.',
    ],
  },
  tools: toolRegistry,
  auth: {
    ws: async (token) => {
      const user = await verifyToken(token);
      return {userId: user.id};
    },
  },
});
```

## Full Configuration

Here is every option available on `HalEngineConfig`:

```typescript
const engine = createHalEngine({
  // REQUIRED: AI provider settings
  provider: {
    type: 'bedrock',             // 'bedrock' | 'vertex' | 'openai' | 'anthropic' | 'mock'
    region: 'eu-west-1',
    modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
  },

  // REQUIRED: System prompt configuration
  prompt: {
    identity: 'You are a helpful assistant.',
    context: 'You help users with weather and general questions.',
    guidelines: ['Be concise.', 'Use tools when available.'],
    customInstructions: 'Additional free-form instructions for the AI.',
  },

  // REQUIRED: Authentication
  auth: {
    ws: async (token) => ({userId: 'user-1'}),   // WebSocket auth (required)
    http: authMiddleware,                          // Express middleware for REST (optional)
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
    hooks: {
      beforeSession: async (session) => { /* setup */ },
      beforeUserInput: async (session, message) => message,
      afterUserInput: async (session, message) => { /* validate */ },
      beforeModelResponse: async (session, prompt) => prompt,
      afterModelResponse: async (session, text, usage) => { /* track usage */ },
      afterSession: async (session) => { /* cleanup */ },
      onError: async (session, error) => { /* log errors */ },
    },
  },

  // OPTIONAL: Logger
  logger: myLogger,

  // OPTIONAL: Lifecycle hooks
  onConnect: (session) => console.log(`Connected: ${session.sessionId}`),
  onDisconnect: (sessionId) => console.log(`Disconnected: ${sessionId}`),
});
```

## Connecting a Client

The WebSocket protocol is documented in [websocket-protocol.md](../specs/hal-engine-websocket-protocol/spec.md). A minimal client connection:

```typescript
// 1. Create a chat session
const response = await fetch('http://localhost:3000/hal/chats', {
  method: 'POST',
  headers: {Authorization: `Bearer ${token}`},
});
const {chatId} = await response.json();

// 2. Connect via WebSocket (token as subprotocol)
const ws = new WebSocket(
  `ws://localhost:3000/hal/ws/${chatId}`,
  [token]
);

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

// 3. Send a message
ws.send(JSON.stringify({
  type: 'user_message',
  content: 'What is the weather in Berlin?',
}));
```

## Custom Session Store

Implement the `SessionStore` interface to persist sessions beyond in-memory storage:

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
