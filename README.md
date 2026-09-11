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
    description: 'Get current weather for a city',
    inputSchema: {
      type: 'object',
      properties: {
        city: {type: 'string', description: 'City name'},
      },
      required: ['city'],
    },
    promptInstructions: 'Use this tool when the user asks about weather in a specific city.',
    examplePrompts: ['What is the weather in Berlin?', 'Is it raining in Tokyo?'],
  },
  async input => {
    const city = input.city as string;
    return `Weather in ${city}: 22C, partly cloudy, wind 12 km/h NW`;
  }
);

const engine = createHalEngine({
  provider: {type: 'mock'},
  prompt: {
    identity: 'You are a helpful AI assistant.',
    responseGuidelines: 'Be concise and informative.',
  },
  tools,
  auth: {
    ws: async req => {
      const token = req.headers.authorization;
      if (!token) return null;
      return {id: 'user-1'};
    },
  },
  transport: {
    port: 8086,
    basePath: '/api',
  },
});

await engine.start();
```

This is [`example/server.ts`](example/server.ts) apart from the import specifier, and CI type-checks that file on every pull request, so it cannot drift from the API it demonstrates.

`provider: {type: 'mock'}` needs no credentials and no SDK — swap it for one from the [Providers](#providers) table when you have them. The server listens on `ws://localhost:8086/api/ws`, answers `GET /api/health`, and mounts the demo chat routes at `/api/chats`, which reply `401` until you configure `auth.http`.

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
  onConnect?: (session) => void | Promise<void>;      // Fire-and-forget; never awaited
  onDisconnect?: (sessionId) => void | Promise<void>;  // Fire-and-forget; never awaited
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
- [Logging](docs/logging.md)
- [Coding Practices](docs/coding-practices.md)

## Security

Do not open a public issue for a vulnerability. Report it privately to **security@re-cinq.com**; we aim to acknowledge within 48 hours.

This package terminates WebSocket connections, runs registered tools against caller-supplied input, and forwards conversation state to third-party model APIs, so the reports that matter are the ones that cross a session boundary, escape the tool contract, or move credentials. Full intake, supported versions and scope are in [SECURITY.md](./SECURITY.md).

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
