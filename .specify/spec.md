# HAL Engine System Specification

## Overview

HAL Engine is a generic, production-ready AI chat server framework designed to abstract away the complexity of building AI-powered chat backends. It provides a pluggable architecture for AI providers, tools, authentication, session management, and transport, allowing developers to focus on domain-specific logic rather than infrastructure plumbing.

The system handles core patterns including streaming responses, tool execution loops, WebSocket connections, session persistence, and message orchestration. It is structured as a layered application with clear separation of concerns from core types through infrastructure and transport.

**Primary Language**: TypeScript (ES2022, strict mode)  
**Entry Point**: `src/config.ts` (`createHalEngine()` factory function)

---

## Key Capabilities

### 1. Multi-Provider Support

- **AWS Bedrock** - `sendMessage` implemented, supporting Amazon Nova and other Bedrock models; `generateStructured` throws
- **Google Vertex AI** - both `AIProvider` methods implemented
- **OpenAI / ChatGPT** (stub with guidance for implementation)
- **Anthropic / Claude** (stub with guidance for implementation)
- **Mock Provider** (built-in for testing)

Providers are abstractly defined via the `AIProvider` interface and instantiated through the `createProvider()` factory. A method that is not implemented throws a descriptive error carrying implementation guidance. Status is per method rather than per provider, and `README.md` carries the only matrix - a second copy would drift.

### 2. Tool System

- Dynamic tool registration via `ToolRegistry`
- JSON Schema tool definitions, declared per tool and forwarded to the model; the schema describes the input the model should produce and is NOT enforced before the executor runs
- Parallel tool execution within configurable tool loops
- Tool response normalization (supports both simple strings and structured content)
- Context-aware tool execution: the executor receives the caller's identity (`userId`, `sessionId`, `workspaceId`) and the auth headers the session carries, forwarded from the WebSocket upgrade or the HTTP chat request, not the conversation history
- Configurable maximum tool loop iterations (default: 5)

### 3. Real-Time Streaming

- WebSocket-based bi-directional communication
- Entry-based protocol (supports User, Assistant, Thinking, Tool, and error entries)
- Thinking tag parsing for handling model reasoning artifacts
- Delta-based streaming for efficient bandwidth usage
- Automatic heartbeat mechanism (default: 30-second interval)

### 4. Pluggable Authentication

- Custom WebSocket authentication via `WsAuthenticator` function
- Express middleware-based HTTP authentication via `HttpAuthMiddleware`, which must attach a `user` to the `AuthenticatedRequest`
- Session binding to authenticated users
- User context propagated throughout request lifecycle

### 5. Session Management

- In-memory default session store (`InMemorySessionStore`)
- Pluggable interface for custom stores (Redis, database, etc.)
- Automatic session lifecycle (creation, retrieval, cleanup)
- Fire-and-forget `onConnect` and `onDisconnect` hooks, neither awaited and neither able to fail a connection
- Session persistence across WebSocket reconnections

### 6. Configurable Prompts

- Injectable system prompt builder (`PromptBuilder`)
- Identity, domain context, and response guideline configuration
- Dynamic prompt composition from templates

### 7. HTTP + WebSocket Server

- Express.js v5 application with full CORS support
- WebSocket server built on `ws` library
- Configurable base path (default: `/hal`)
- Type-safe route definitions

---

## Core Data Model

### Message Flow

**Incoming Messages** (`IncomingMessage` type):

- `UserMessage`: User-provided text input with optional metadata
- `Ping`: WebSocket heartbeat

**Outgoing Messages** (`OutgoingMessage` type):

- `ConnectedMessage`: Initial handshake after WebSocket connection
- `EntryUpsertMessage`: New or updated conversation entry
- `EntryDeltaMessage`: Streaming content delta
- `EntryCommitMessage`: Entry finalization marker
- `EntrySkipMessage`: Skip tool/response generation
- `ErrorMessage`: Error with code and details
- `PongMessage`: Heartbeat acknowledgment
- `StreamEndMessage`: End of streaming sequence

### Session Model

**ChatSession**:

- `id`: Unique session identifier (UUID)
- `userId`: Authenticated user identifier
- `entries`: Array of conversation entries
- `createdAt`: Session creation timestamp
- `updatedAt`: Last activity timestamp

**Entry Types**:

- `UserEntry`: Text message from user
- `AssistantEntry`: AI-generated response with tool calls
- `ThinkingEntry`: Internal reasoning (parsed from models that support thinking)
- `ToolEntry`: Tool execution metadata and results
- `SessionEntry`: Marker for session lifecycle events

### AI Communication Model

**Message** types:

- `TextMessage`: Simple text content
- `ToolUseMessage`: Tool invocation with arguments
- `ToolResultMessage`: Tool execution result
- `ToolCallContent`: Structured tool call representation
- `ToolResultContent`: Structured tool result representation

**ToolDefinition**:
<!-- doc-block: none -- a JSON message payload, not a TypeScript declaration -->
```typescript
{
  name: string;
  description: string;
  inputSchema: JSONSchema;
}
```

**Tool Response Variants**:

- String: Direct text response
- Object with `content`: Rich structured content
- Object with `entries`: Multiple message entries
- Normalized to internal format via `normalizeToolResponse()`

---

## User Roles

### 1. **System Administrator**

- Configures `HalEngineConfig` during initialization
- Selects AI provider and region
- Defines authentication strategy
- Sets rate limits and tool execution constraints
- Manages session store backend
- Configures CORS and network settings

### 2. **Application Developer**

- Implements custom `WsAuthenticator` and optional `HttpAuthMiddleware`
- Registers domain-specific tools via `ToolRegistry`
- Defines prompt templates and system instructions
- Implements custom `SessionStore` if needed
- Handles `onConnect`/`onDisconnect` lifecycle hooks, both returning `void | Promise<void>`
- Consumes published API from `createHalEngine()`

### 3. **End User**

- Connects via WebSocket with authentication token
- Sends `UserMessage` entries with text input
- Receives streaming `EntryUpsert`/`EntryDelta` messages
- Observes tool execution through entry protocol
- Maintains session across reconnections

### 4. **AI Model (Provider)**

- Processes chat history and system prompts
- Generates text responses and tool calls
- Streams content in chunks
- Returns usage metadata (tokens, cost estimation)
- Validates tool calls against schemas

---

## Business Rules

### 1. Tool Execution

- Tools execute only when explicitly requested by the AI model
- Maximum tool loop iterations enforce termination (prevents infinite loops)
- Tools execute in response to explicit `ToolCall` objects from the model
- Tool results are returned to the model for incorporation into response
- Tool failures are communicated via `ToolResultMessage` with error content

### 2. Message Ordering

- User messages must precede assistant responses
- Tool results must follow corresponding tool calls
- Thinking entries (when present) appear before tool calls or text
- All entries within a single assistant response are committed atomically
- Session history is immutable after commit

### 3. Authentication & Authorization

- WebSocket connections require successful `WsAuthenticator` callback
- Invalid tokens result in connection rejection
- Each session is bound to exactly one authenticated user
- User context is available to tools and infrastructure components
- The chat routes require an identified user: with no middleware configured, or middleware that attaches no usable `user.id`, they answer `401`

### 4. Session Lifecycle

- Sessions are created on first successful WebSocket connection
- Sessions persist across disconnections (reconnection support)
- `onDisconnect` hook fires when session is abandoned (configurable timeout)
- Session entries are append-only (immutable history)
- Session cleanup follows configurable eviction policy

### 5. Streaming & Response Handling

- Streaming begins immediately upon receiving user message
- Thinking content is parsed from XML tags (provider-dependent)
- Deltas are sent as soon as available (streaming chunks)
- Complete entries are committed before next entry begins
- Client must handle partial messages due to network conditions

### 6. Tool Response Normalization

- Tool executors return `string`, object with `content`, or object with `entries`
- Framework normalizes all variants to internal representation
- Tool results are validated against original tool definition schema
- Malformed responses result in error entries

### 7. Provider Compatibility

- Provider selection is immutable per engine instance
- Provider-specific configuration is validated at startup
- Missing provider dependencies (e.g., AWS SDK) result in clear error messages
- All providers implement identical `AIProvider` interface

---

## Success Metrics

### Operational Metrics

1. **Availability**: WebSocket server uptime and connection stability
2. **Latency**:
   - Time to first token (TTFT) from model
   - End-to-end response time (user message → final entry commit)
3. **Throughput**: Concurrent WebSocket connections supported
4. **Error Rate**: Failed messages, tool execution errors, provider failures

### Integration Metrics

1. **Tool Success Rate**: Percentage of tool calls that execute without error
2. **Tool Loop Efficiency**: Average iterations before response completion
3. **Streaming Efficiency**: Chunk size and delta frequency

### Developer Experience Metrics

1. **Time to Integration**: Hours to implement custom provider or tool
2. **Configuration Complexity**: Lines of code for basic setup
3. **Documentation Coverage**: Completeness of docs/ directory

### Business Metrics

1. **Provider Cost Per Interaction**: Token usage × provider pricing
2. **Session Persistence**: Reconnection success rate
3. **Authentication Success Rate**: Percentage of valid auth attempts

### Reliability Metrics

1. **Message Delivery Guarantee**: No lost messages within a session
2. **Tool Execution Idempotency**: Safe to retry failed tool calls
3. **Provider Fallback**: Time to detect provider failure and escalate

---

## Architecture Overview

The system is organized into five layers plus a cross-cutting utilities layer:

- **Layer 0 (Shared)**: Logger and common utilities
- **Layer 1 (Types)**: Core type definitions (AI, session, messages, auth, stores)
- **Layer 2 (Providers)**: AI provider implementations (Bedrock, Vertex, OpenAI, Anthropic, Mock)
- **Layer 3 (Infrastructure)**: Stores (session, prompt, usage), builders (prompt), parsers (thinking tags)
- **Layer 4 (Orchestration)**: Chat orchestrator, tool registry, conversation context, entry management
- **Layer 5 (Transport)**: Express app, WebSocket server, HTTP/WebSocket routes

Each layer depends only on layers below it, ensuring clean separation of concerns.

---

## Configuration & Deployment

### Required Configuration

- `provider`: Type and credentials for selected AI provider
- `prompt`: System identity and context instructions
- `auth.ws`: WebSocket authentication function

### Optional Configuration

- `tools`: Custom tool registry (defaults to empty)
- `session`: Custom session store (defaults to in-memory)
- `transport`: Port, CORS, base path, heartbeat interval
- `auth.http`: Express middleware for HTTP endpoints
- `orchestrator`: Max tool rounds, context config, lifecycle hooks
- `onConnect`/`onDisconnect`: Lifecycle hooks, fire-and-forget
- `logger`: Custom logger instance

### Deployment Artifacts

- Builds to `dist/` directory (ES2022, ESM only - `type: module`, resolved through the `exports` map)
- Type definitions included (`dist/index.d.ts`)
- Published as npm package `@re-cinq/hal-engine`, Apache-2.0, `engines: node >=22`
- `@types/express`, `@types/node` and `@types/ws` are runtime `dependencies`, not dev: the emitted `.d.ts` files import `express`, `http`, `stream` and `ws`, so a consumer cannot type-check without them

---

## Development & Testing

- **TypeScript**: Strict mode, ES2022 target
- **Testing Framework**: Jest with ts-jest
- **Linting**: ESLint with flat config
- **Formatting**: Prettier
- **Development**: `tsx watch`, hot-reloading `example/server.ts`
- **Build**: TypeScript compiler, declarations only - the published build emits no source or declaration maps
