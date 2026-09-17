# HAL Engine

A generic AI chat server framework with pluggable providers, tools, and transport.

HAL Engine extracts the core patterns of building an AI-powered chat backend into a reusable library. It handles streaming responses, tool execution loops, WebSocket connections, and session management -- you bring your own AI provider, auth, and domain tools.

## Features

- **Multi-provider support**: AWS Bedrock and Google Vertex AI implemented, OpenAI and Anthropic stubbed, plus a built-in Mock. Scored per method in [Providers](#providers) — a provider can implement one of `AIProvider`'s two methods without the other
- **Tool system**: Register custom tools with a JSON Schema `inputSchema`, executed in parallel within a configurable tool loop. The schema is forwarded to the model and validated against the input before the executor runs; a schema-invalid call returns a descriptive rejection to the model so it can retry within the tool-round budget
- **Streaming**: Real-time WebSocket streaming with thinking tag parsing and entry-based protocol
- **Pluggable auth**: Bring your own WebSocket and HTTP authentication
- **Pluggable session store**: In-memory default, swap in Redis/database/etc.
- **Configurable prompts**: Identity, domain context, response guidelines -- all injectable
- **Express + WebSocket**: Full HTTP API and WebSocket server out of the box

## Install

```bash
npm install @re-cinq/hal-engine
```

That is the supported install path, and the one this project releases against: every published version is built by a workflow run in this repository's CI and carries an npm provenance attestation. `npm audit signatures` verifies it, which tells you the tarball was built by a workflow of this repository from the commit the attestation names, rather than uploaded by whoever held a token. `0.2.0` was published once with a token, because the registry cannot hold a trusted publisher for a name that has never been published; every version after it is published by the release workflow from a published GitHub release, with no credential stored anywhere, and reaches you only after a maintainer approves it.

A git specifier also resolves, and four things differ. It builds `dist/` from a checkout through the `prepare` script rather than installing a built artefact, so your install runs this package's TypeScript compiler. It carries no provenance, because provenance is produced at publish time. It pins whatever commit your lockfile recorded, not a version, so `npm outdated` has nothing to compare and a fix reaches you only when you repoint it. And npm installs a dependency under its **key**, not the package's `name`.

That last one has a trap in it. An existing `"hal-engine": "github:…"` entry keeps resolving after the rename — the directory is still `node_modules/hal-engine`, so `import 'hal-engine'` keeps working while the package inside it declares `@re-cinq/hal-engine`. The rename produces no error, no warning and no failed build. Worse, following the rename and switching your imports to `@re-cinq/hal-engine` is what breaks: that specifier resolves to nothing until the key is renamed too. Move to the registry specifier, or rename the key and the imports together.

## Quick Start

<!-- doc-block: example/server.ts#quick-start -->
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
    // No `http` middleware here, so the chat routes under /api/chats answer 401 rather than serving anyone.
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

`AIProvider` has two methods and a provider can implement one without the other, so status is scored per method. Bedrock streams but cannot produce structured output; Vertex does both. This is the only implementation-status matrix in the repository — npm renders `README.md` and nothing else, and a second copy would drift from it.

| Provider | `type` | `sendMessage` | `generateStructured` | Package |
|---|---|---|---|---|
| AWS Bedrock | `'bedrock'` | Implemented | throws `Bedrock structured output is not yet implemented.` | `@aws-sdk/client-bedrock-runtime` |
| Google Vertex AI | `'vertex'` | Implemented | Implemented | `@google-cloud/vertexai` |
| Mock | `'mock'` | Implemented | Implemented | (built-in) |
| OpenAI / ChatGPT | `'openai'` | throws `OpenAI provider is not yet implemented.` | throws `OpenAI provider is not yet implemented.` | `openai` |
| Anthropic / Claude | `'anthropic'` | throws `Anthropic provider is not yet implemented.` | throws `Anthropic provider is not yet implemented.` | `@anthropic-ai/sdk` |

A stub's message continues past the sentence in the table, naming the SDK to install and a provider to copy — for example `OpenAI provider is not yet implemented. Install openai and implement the streaming logic. See src/providers/bedrock/ for a reference implementation.`

`generateStructured` returns typed JSON for internal decisions — evaluation, classification, extraction — and is never user-facing. If your application does not call it, the `generateStructured` column does not constrain your choice.

**Switching providers is config-only only within a column.** Moving from Vertex to Bedrock changes one config object if you only stream, and breaks at runtime if anything calls `generateStructured`. There is no compile-time signal: every provider satisfies `AIProvider`, and a stub satisfies it by throwing.

See [the providers spec](specs/hal-engine-providers/spec.md) for configuration and for implementing one.

## Configuration

The `createHalEngine()` function accepts a single config object:

<!-- doc-block: none -- annotated for the npm front page; the unannotated interface is HalEngineConfig in src/config.ts, which typecheck covers -->
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

### Environment variables

Three, and only three. Everything else is a config field.

| Variable | Read at | Overridden by | Default |
|---|---|---|---|
| `CORS_ORIGIN` | `src/transport/createApp.ts` | `transport.corsOrigin` | `http://localhost:3000` |
| `PORT` | `src/transport/createServer.ts` | `transport.port`, or the argument to `engine.start(port)` | `8086` |
| `LOG_LEVEL` | `src/shared/logger.ts` | nothing — there is no config field | `info` |

`CORS_ORIGIN` carries **one origin**. The value reaches `cors({origin})` unsplit, so a comma-separated list is a single literal string that matches no browser origin. Pass an array to `transport.corsOrigin` for several.

`PORT` is read only when neither `engine.start(port)` nor `transport.port` supplied one. A value that is not a positive number falls through to `8086` — `Number(process.env.PORT) || 8086`, so `PORT=0` and `PORT=http` both yield `8086`. `transport.port` is resolved with `??` rather than `||`, so a configured `0` means "let the OS choose a free port" and is not replaced by the default.

`LOG_LEVEL` is resolved once at module load, so changing `process.env.LOG_LEVEL` afterwards has no effect. See [Logging](docs/logging.md).

No vendor credential variable appears here, because this package reads none of them. See [Providers](#providers).

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
- [Contributing](CONTRIBUTING.md)
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

Apache-2.0. The full text is in [LICENSE](LICENSE), and the same identifier is the `license` field of `package.json`.
