# HAL Engine

A generic AI chat server framework with pluggable providers, tools, and transport.

HAL Engine extracts the core patterns of building an AI-powered chat backend into a reusable library. It handles streaming responses, tool execution loops, WebSocket connections, and session management -- you bring your own AI provider, auth, and domain tools.

## Features

- **Multi-provider support**: AWS Bedrock (full), OpenAI, Anthropic, Google Vertex AI (stubs ready for implementation)
- **Tool system**: Register custom tools with JSON Schema validation, executed in parallel within a configurable tool loop
- **Streaming**: Real-time WebSocket streaming with thinking tag parsing and entry-based protocol
- **Pluggable auth**: Bring your own WebSocket and HTTP authentication
- **Pluggable session store**: In-memory default, swap in Redis/database/etc.
- **Configurable prompts**: Identity, domain context, response guidelines -- all injectable
- **Express + WebSocket**: Full HTTP API and WebSocket server out of the box

## Quick Start

```bash
npm install @re-cinq/hal-engine
```

```typescript
import {createHalEngine, ToolRegistry} from '@re-cinq/hal-engine';

const tools = new ToolRegistry();
tools.register(
  {
    name: 'get_weather',
    description: 'Get weather for a city',
    inputSchema: {
      type: 'object',
      properties: {city: {type: 'string'}},
      required: ['city'],
    },
  },
  async input => `Weather in ${input.city}: 22C, sunny`
);

const engine = createHalEngine({
  provider: {type: 'bedrock', modelId: 'eu.amazon.nova-pro-v1:0', region: 'eu-central-1', maxTokens: 4096},
  prompt: {identity: 'You are a helpful assistant.'},
  tools,
  auth: {
    ws: async req => {
      const token = req.headers.authorization;
      if (!token) return null;
      return {id: 'user-1'};
    },
  },
});

engine.start(8086);
```

## Providers

| Provider | Status | Package |
|----------|--------|---------|
| AWS Bedrock | Full | `@aws-sdk/client-bedrock-runtime` |
| Google Vertex AI | Full | `@google-cloud/vertexai` |
| OpenAI / ChatGPT | Stub | `openai` |
| Anthropic / Claude | Stub | `@anthropic-ai/sdk` |
| Mock | Full | (built-in) |

Stub providers throw a descriptive error with implementation guidance. See [docs/providers.md](specs/hal-engine-providers/spec.md) for details on implementing a provider.

## Configuration

The `createHalEngine()` function accepts a single config object:

```typescript
interface HalEngineConfig {
  provider: ProviderConfig;        // Which AI provider to use
  prompt: PromptBuilderConfig;     // System prompt configuration
  tools?: ToolRegistry;            // Registered tools (optional)
  session?: SessionStore;          // Custom session store (default: in-memory)
  transport?: {
    port?: number;                 // Server port (default: 8086)
    corsOrigin?: string | string[];
    basePath?: string;             // URL prefix (default: '/hal')
    heartbeatIntervalMs?: number;  // WS heartbeat (default: 30000)
  };
  auth: {
    ws: WsAuthenticator;          // WebSocket auth function
    http?: HttpAuthMiddleware;     // Express auth middleware
  };
  orchestrator?: {
    maxToolRounds?: number;        // Max tool loop iterations (default: 5)
    contextConfig?: Partial<ContextConfig>;
  };
  onConnect?: (session) => void;
  onDisconnect?: (sessionId) => void;
}
```

## Project Structure

```
src/
  index.ts              # Public API exports
  config.ts             # createHalEngine() factory
  types/                # Layer 1: Core types and interfaces
  providers/            # Layer 2: AI provider implementations
  infrastructure/       # Layer 3: Stores, builders, parsers
  orchestration/        # Layer 4: Chat orchestrator, tools, entry management
  transport/            # Layer 5: Express app, WebSocket server, routes
  shared/               # Layer 0: Cross-cutting utilities (logger)
```

## Documentation

- [Getting Started](docs/getting-started.md)
- [Architecture](specs/hal-engine-architecture/spec.md)
- [WebSocket Protocol](specs/hal-engine-websocket-protocol/spec.md)
- [Adding a Tool](docs/adding-a-tool.md)
- [Tool Responses](specs/hal-engine-tool-responses/spec.md)
- [Providers](specs/hal-engine-providers/spec.md)
- [Coding Practices](docs/coding-practices.md)

## Development

```bash
npm install
npm run typecheck    # Type check
npm test             # Run tests
npm run build        # Build to dist/
npm run dev          # Dev server with hot reload
```

## License

ISC
