# CLAUDE.md — HAL Engine

HAL Engine is a TypeScript library that provides a production-ready AI chat server framework with pluggable providers, tool execution, WebSocket streaming, and session management.

## Project context

- **Entry point**: `src/config.ts` — `createHalEngine()` factory function
- **Public API**: `src/index.ts` — all exports developers consume
- **Example**: `example/server.ts` — minimal working server

## Architecture

Five mandatory layers (no cross-layer shortcuts, no circular deps). Declared in `layers.yaml` and enforced by `re-lint/no-cross-layer-import`, so a shortcut fails lint rather than review:

```
types → providers → infrastructure → orchestration → transport
```

| Layer | Path | Purpose |
|-------|------|---------|
| types | `src/types/` | Core interfaces: `AIProvider`, `SessionStore`, message protocol |
| providers | `src/providers/` | Bedrock (full), Vertex (full), OpenAI/Anthropic (stubs), Mock (built-in) |
| infrastructure | `src/infrastructure/` | Stores, prompt builder, thinking-tag parser |
| orchestration | `src/orchestration/` | `chatOrchestrator`, tool registry, context management |
| transport | `src/transport/` | Express app, WebSocket server, chat routes |

Pluggable interfaces: `AIProvider`, `SessionStore`, `WsAuthenticator`, `PromptStore`, `UsageStore`.

## Commands

```bash
npm run dev              # Hot-reload dev server: example/server.ts via node --watch
npm run typecheck        # Type-check without emitting
npm test                 # Jest suite
npm run build            # Compile to dist/
npm run eslint           # Lint (zero-warning policy)
npm run prettier         # Format src/**/*.ts
npm run prettier:check   # Check formatting only
```

Pre-commit (run all):

```bash
npm run typecheck && npm run eslint && npm run prettier:check && npm test && npm run build
```

## Code rules

- **TypeScript strict mode** — `strict: true` is non-negotiable; no `any` in public APIs
- **Type-only imports** — `import type { Foo } from '...'` for types
- **No `console.log`** — use `log` from `src/shared/logger.ts`
- **Single quotes**, semicolons required, line length 120 (Prettier)
- **Zero ESLint warnings** — all warnings are errors
- **Comments at most one line** — `re-lint/max-comment-lines` enforces this and does not exempt JSDoc, so a one-line `/** … */` passes but a `@param`/`@returns`/`@throws` block does not. Anything longer than one sentence belongs in `specs/`, `adrs/` or `docs/`, where it is searchable and linked. Tooling directives (`eslint-disable`, `@ts-expect-error`) are exempt, and an `eslint-disable` may carry its reason after `--`

## Testing

- Tests live next to source: `src/**/*.test.ts`
- Minimum 70% line coverage for new code; aim for >80% on modified files
- All public APIs need at least one test
- Use the built-in `MockProvider` for unit tests — avoid hitting real providers

## Protocol invariants

These rules enforce message ordering and must not be violated when adding providers, tools, or transport handlers:

- **Entry ordering**: `UserEntry` precedes `AssistantEntry`; tool results immediately follow the corresponding tool call; `ThinkingEntry` is committed before the assistant text entry begins
- **Append-only history**: session entries are immutable after commit — never mutate or delete existing entries
- **Atomic commit**: all entries within a single assistant response are committed before the next user message is processed
- **Provider immutability**: the provider selected at engine creation cannot change at runtime

## AIProvider full contract

Providers must implement **both** methods:

<!-- doc-block: src/types/ai.ts#AIProvider -->
```typescript
interface AIProvider {
  sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk>;
  generateStructured<T>(params: StructuredOutputParams<T>): Promise<T>;
}
```

`generateStructured` returns typed JSON for internal AI decisions (evaluation, classification, structured extraction) — it is not user-facing. Stub providers must throw `AIError` with a descriptive message; returning `null` or `undefined` silently breaks orchestration.

## Adding a provider

1. Create `src/providers/<name>/index.ts` implementing `AIProvider`
2. Return `AsyncGenerator<MessageChunk>` from `sendMessage`
3. Implement `generateStructured` (required — see contract above)
4. Handle rate-limiting; surface errors as `AIError` (not raw SDK errors)
5. Map tool calls to/from provider format in the provider layer
6. Export the config type and factory from `src/index.ts`
7. Update README provider table and `specs/hal-engine-providers/spec.md`

## Adding a tool

<!-- doc-block: none -- the registration call shape, with placeholder fields a reader fills in -->
```typescript
tools.register(
  {
    name: 'tool_name',
    description: '...',
    inputSchema: { type: 'object', properties: { ... }, required: [...] },
    promptInstructions?: string,   // appended to system prompt so the AI knows when/how to call this tool
    examplePrompts?: string[],     // surfaced to the client via ConnectedMessage.examplePrompts
  },
  async (input, context) => result
);
```

Tools receive a `ToolContext` with session, user, workspace. The return value is normalized:

| Return value | Effect |
|---|---|
| `string` or `{ content: string }` | Standard tool result returned to the AI |
| `{ entries: OutgoingMessage[] }` | Messages forwarded directly to the WebSocket client |
| `{ ..., suppressAssistantResponse: true }` | AI follow-up kept in session history but hidden from the client |

See `docs/adding-a-tool.md` and `specs/hal-engine-tool-responses/spec.md` for full details.

## OrchestratorHooks

Pass hooks to `createChatOrchestrator` (via `ChatOrchestratorOptions.hooks`) to intercept the message lifecycle:

<!-- doc-block: src/orchestration/chatOrchestrator.ts#OrchestratorHooks -->
```typescript
interface OrchestratorHooks {
  beforeSession?: (session: ChatSession) => Promise<void>;
  afterSession?: (session: ChatSession) => Promise<void>;
  beforeUserInput?: (session: ChatSession, userMessage: string) => Promise<string>;
  afterUserInput?: (session: ChatSession, userMessage: string) => Promise<void>;
  beforeModelResponse?: (session: ChatSession, systemPrompt: string) => Promise<string>;
  afterModelResponse?: (session: ChatSession, responseText: string, usage?: UsageMetadata) => Promise<void>;
  onError?: (session: ChatSession, error: Error) => Promise<void>;
}
```

Fire order: `beforeSession → beforeUserInput → afterUserInput → beforeModelResponse → [streaming] → afterModelResponse → afterSession`. The returned value matters for two of them: `beforeUserInput` rewrites the user message and `beforeModelResponse` replaces the system prompt. `afterSession` always fires, including on error. The block above is generated from the declaration, so the declaration order is not the fire order.

## Specs and ADRs

Normative specs live in `specs/<slug>/spec.md`, decision records in `adrs/`, and the repo-level system spec in `.specify/spec.md`. Research spikes are in `docs/spikes/`; `docs/` otherwise holds how-to guides.

Every spec under `specs/` opens with a header table whose `Status` row tracks its **test-citation coverage**, not how finished the feature is — a spec describing shipped behaviour still reads `Draft` until its statements cite tests. Read AGENTS.md § Spec Header Table and § Spec Test Links before adding or editing a spec.

## Commit format

```
<type>(<scope>): <subject>
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`  
Scopes: `bedrock`, `vertex`, `openai`, `anthropic`, `mock`, `tools`, `orchestrator`, `transport`, `session`, `types`, `build`

Rules: imperative mood, no capital, no trailing period, subject ≤ 50 chars, reference issues in footer.

## Breaking changes

Must be discussed in an issue first, include a migration guide in the PR, bump MINOR version, and add a one-minor-version deprecation period where possible.

## ChatSession shape

`ChatSession` (in `src/types/session.ts`) uses `sessionId`, not `id`:

<!-- doc-block: src/types/session.ts#ChatSession -->
```typescript
interface ChatSession {
  sessionId: string;
  userId: string | number;
  entries: SessionEntry[];
  authHeaders?: {
    cookie?: string;
    authorization?: string;
    host?: string;
  };
  workspaceId?: string | number;
}
```

The `authHeaders` field carries request headers forwarded from the WebSocket upgrade request — useful for proxying authenticated calls to upstream services from inside a tool.

## Key files to read first

1. `README.md`
2. `src/index.ts` — full public surface
3. `src/config.ts` — `HalEngineConfig` schema
4. `src/types/ai.ts` — `AIProvider` interface
5. `src/types/messages.ts` — WebSocket protocol (additive changes only)
6. `specs/hal-engine-architecture/spec.md` — data flow diagrams
