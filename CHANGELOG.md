# Changelog

All notable changes to `@re-cinq/hal-engine` are documented here.

The format is [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries are written for somebody installing the
package, not for somebody reading this repository's commit log.

## [Unreleased]

### Added

- `SessionStore` gains an optional `save(session)` member: the write signal a durable store needs. The engine calls it once per processed user message, from the same `finally` path that runs `afterSession`, so it fires for a turn that ended in a provider error as well as one that succeeded — a store that only heard about successes would lose exactly the conversations a customer complains about. By the time it runs, the turn's entries are committed, so the assistant entry's `isStreaming` is already `false` — including when a provider threw mid-stream, where the engine now closes the open entry before saving, recording `truncated` on it, rather than persisting a half-streamed entry that looks finished. An `afterSession` hook that throws no longer costs the turn its write signal. What `save` throws or rejects with is caught and logged as one line carrying the session id, and the turn continues: the client still receives its full stream and `stream_end`, because a database outage is not a reason for the agent to stop answering. The member is typed `void | Promise<void>`, so a synchronous implementation and an `async` one both satisfy it. Additive: `InMemorySessionStore` does not implement `save` and is unchanged, and a store that omits it behaves exactly as before.
- `SessionStore` gains an optional `evict(sessionId)` member, and `InMemorySessionStore` implements it. The engine calls it only for a session whose socket closed while `create` was still pending — one that no client ever received and that has no entries to keep. `InMemorySessionStore` now also takes `{maxAgeMs}` (default `28_800_000`, eight hours), exported as `InMemorySessionStoreOptions`. Expired sessions are evicted when read and swept at the head of `create`, which stops at the first live session, so the bound costs nothing on a busy store. There is no timer: a library-owned interval would keep your process alive.
- **`MongoSessionStore`**, a durable session store, exported as `MongoSessionStore` and `createMongoSessionStore`. It takes a collection, a client with a database name, or a connection URL — nothing in the package reads the environment or assumes a host. The collection is the truth and the in-process cache is an optimisation: a session written by `save` is readable by a second store on the same collection. `delete` and `clear` evict from the cache only, while `eraseConversation`, `eraseOlderThan(cutoff)` and `eraseAll` remove documents; `docs/session-stores.md` opens with the table that says which is which, because the previous documentation would have led you to believe `delete` erased. Documents carry `createdAt` and `updatedAt`, so a retention period is expressible without per-entry timestamps. **No credential is ever written**: `authHeaders`, `authorization`, `cookie` and `host` are stripped at any depth, not just the top level, and the same `stripCredentialKeys` is exported for stores you write yourself. `mongodb` is an optional peer dependency loaded only when the store actually connects, so a consumer who installs no optional peer can still import the package root and use the in-memory store. This does **not** deliver conversation resume, and it does not make the engine safe to run as more than one instance against one conversation.

### Changed

- Every `SessionStore` member is now `Awaitable<T>` (`T | Promise<T>`) rather than a bare `T`, so a store backed by a database is expressible for the first time. `Awaitable` is exported from the package root. **A synchronous implementation needs no change** — `T` is assignable to `T | Promise<T>` in a return position — and `InMemorySessionStore` is unedited. The WebSocket connection handler now awaits `create` and the release that follows a close: it pauses the socket across the await so a frame sent before `connected` arrives is buffered rather than dropped, attaches its `close` listener before the await so a socket that closes mid-create leaves no session behind, and catches a rejection from either call so one store failure closes one socket instead of ending the process with an unhandled rejection. **Migration note**: the `connected` frame now arrives one tick later, after the awaited `create`, so a client that waits for it (as the protocol already requires) sees no difference; only code that assumed the frame was emitted synchronously with the upgrade does.
- **The engine no longer erases a conversation when its socket closes.** The WebSocket close handler called `sessionStore.delete(sessionId)` unconditionally, which meant that behind a durable store every conversation was written and then destroyed the moment the customer closed their tab — the opposite of what this engine's own documentation promised. `SessionStore.delete` now has no engine-internal caller at all and is purely your erasure primitive. The credentials the socket carried are cleared from the session on close, since they were issued for a request that is over; the entries are untouched. **Migration note**: to restore the old behaviour exactly, pass `onDisconnect: sessionId => store.delete(sessionId)` — that one line is the whole migration. If you rely on the default store not growing, note that it is now bounded by `maxAgeMs` (eight hours) rather than by the close handler; that is a memory bound, not a retention policy, and the retention decision remains yours.

## [0.3.0] - 2026-09-29

**Upgrading from 0.2.x.** Nothing is removed and no existing signature changes, but check these before you bump:

- `OrchestratorHooks` gains two optional members, `beforeToolCall` and `onToolBudgetExhausted`. Code that checks the hooks exhaustively, for example `satisfies Record<keyof OrchestratorHooks, …>`, fails to type-check until it names both.
- `ToolRegistry.execute` now validates tool input against each tool's `inputSchema`, so a tool that produced its own message for malformed input receives only valid input; the model reads the registry's validation message instead.
- `maxToolRounds` now counts executed rounds: the default of 5 runs 5 tool rounds, not 6. Raise it by one to keep the old count.
- Offering a bare access token as the only WebSocket subprotocol still works but is deprecated: offer `hal.v1` beside it now, because the next minor release stops accepting a bare token.
- New dependencies: `ajv`, and `cookie` moves from `^0.7` to `^2`.

### Added

- `VertexConfig` gains an optional `apiEndpoint` field, forwarded verbatim to the `@google-cloud/vertexai` SDK constructor. Deployers who must keep inference in the EU multi-region can set `apiEndpoint: 'aiplatform.eu.rep.googleapis.com'`; the change is additive and the default behaviour (endpoint derived from `location`) is unchanged.
- `HalEngineConfig.transport` now accepts three optional extension points: `additionalRoutes` (mounts a router under `basePath`, unauthenticated), `rootRoutes` (mounts a router at `/`, after the `basePath` router and before the 404 catch-all), and `errorHandler` (replaces Express's default HTML error page). Pass none of them and the app is identical to before. See `docs/getting-started.md` for usage and the GDPR / NIS-2 notes that apply to unauthenticated routes.
- `OrchestratorHooks` gains an optional `beforeToolCall(session, call)` hook that fires before each known tool's executor, once per call per round. Return `undefined` to let the call run, or a `ToolResponse` to decline it: the executor is skipped and the model reads your `result` as that call's `tool_result`, with `clientMessages` and `suppressAssistantResponse` behaving as a tool's would. A hook that throws declines the call instead of failing the turn. Use it for an audit of what the model attempted or an EU AI Act Article 14 human-oversight control. The hook receives the model's raw tool input and, through `session`, the caller's `authHeaders`, so don't log either. Additive: with no hook installed, nothing changes.
- `OrchestratorHooks` gains an optional `onToolBudgetExhausted(session, budget)` hook, and `ToolBudgetInfo` (`{maxToolRounds, requestedTools}`) and `TOOL_BUDGET_EXHAUSTED` are exported. It fires when the model asks for a tool round `maxToolRounds` refuses, after the last provider call and before `afterModelResponse`. Return a sentence and the turn ends on it as an ordinary assistant entry, so the user sees a degraded answer instead of silence; the engine writes no prose of its own. Every exhausted run now also ends with a `{type: 'stop', stopReason: 'tool_budget_exhausted'}` chunk, a new value for the existing field rather than a new type, which the WebSocket transport sends nothing for. The turn still ends with `stream_end`, never `error`. Additive: with no hook installed, the wire is unchanged.
- `AssistantEntry` and `ThinkingEntry` gain an optional `truncated: true`, set on an entry the run could not finish: a provider failure mid-stream, or a round that ends on a tool call with no `stop`. The server re-sends such an entry as an `entry_upsert` carrying the flag just before its `entry_commit`, and the flag stays on the stored entry, so a client can render a cut-off answer as cut off live or on a replay, without relying on the transient `error` frame. An entry committed normally never carries it; a suppressed entry is flagged in the session but never re-sent. Text the thinking-tag parser was still holding back is now kept in a cut-off entry, as it already was on a normal stop. Additive: a client that ignores the field renders what it did before, and the extra `entry_upsert` replaces the entry with the content it already has.

### Changed

- Every `user_message` now ends in exactly one `stream_end`, including a run that fails and a message that fails validation; the `error` frame is advisory rather than terminal. Unparseable JSON remains the one frame answered with `INVALID_FORMAT` and no `stream_end`. **Migration note**: `stream_end` may now follow an `error` frame, so treat `stream_end` (or the socket closing) as the only end of a run. The one live consumer handles the two frame types independently, and both clear its processing state, so it keeps working unchanged and no deprecation period is served by delaying.
- Every assistant and thinking entry a run opens is now committed when the run ends, however it ends: a provider that throws mid-stream, or a round that ends on a tool call with no `stop`, no longer leaves an entry with `isStreaming: true` in the session. The partial content is kept exactly as streamed, and on a throw its `entry_commit` arrives before the `error` frame. **Migration note**: `entry_commit` now arrives on paths that previously sent none, so a client counting commit frames sees more of them. No wire type changes, and a client that already stops streaming on `stream_end` renders the same result.
- `maxToolRounds` now bounds the tool rounds that are actually executed: at most `maxToolRounds` rounds run, and the provider is called at most `maxToolRounds + 1` times. Previously the loop ran one extra round whose tool results no provider call ever read, so the default of 5 executed 6 rounds; it now executes 5, and the sixth provider call still reads the fifth round's results. `maxToolRounds: 0` now means one provider call and no tool execution, a negative value behaves as 0, and a non-finite value falls back to the default. When the budget runs out, the engine logs one `warn` (`tool budget exhausted`) naming the tools it did not run. **Migration note**: no exported type or signature changes, but a tool with a side effect in that final, unread round no longer runs there; to restore the old count, raise `maxToolRounds` by one.
- `HalEngineConfig.orchestrator.hooks` now carries a JSDoc comment. The field already shipped
  in `0.2.x`; the comment makes the lifecycle-hook seam discoverable from the published type
  declarations so editors surface it on hover without a trip to the README.
- `ToolRegistry.execute` now validates tool input against the declared `inputSchema` before invoking the executor. A schema-invalid call returns a descriptive `ToolResponse` to the model (naming the failing property path and constraint, never the value) rather than throwing, so the model can retry within the existing tool-round budget. Extra properties pass through to the executor unchanged. **Migration note**: an executor that previously hand-validated its own input now receives only input that has already passed the declared schema; a tool that relied on seeing malformed input to produce its own error message will no longer see it.
- The WebSocket server no longer echoes the access token in its handshake response. A client offers the new `hal.v1` marker beside its token (`new WebSocket(url, ['hal.v1', token])`, or `HAL_WS_SUBPROTOCOL`, now exported from the package root) and the server answers only `hal.v1`, so the token stays out of the 101 response headers and off the connected socket's `protocol` property. The token is read as the first offered value that is not the marker, in either order, and still reaches tools as `authHeaders.authorization`. `credentialFromSubprotocol`, also newly exported, reads it the same way for your own `WsAuthenticator`. **Migration note**: every client must be updated to offer `hal.v1` alongside its token, and an authenticator that took the first `Sec-WebSocket-Protocol` value as the token now gets `hal.v1` from an updated client, so read it with `credentialFromSubprotocol(req.headers['sec-websocket-protocol'])` instead. From the next MINOR, a client that offers only a bare token receives a 101 with no `Sec-WebSocket-Protocol` header, and `ws` and Chromium both fail such a handshake; this release still accepts a bare token (see Deprecated), because `0.2.x` documented it.

### Deprecated

- Offering a bare access token as the only WebSocket subprotocol. This release still echoes it and logs a warning that never includes the offered value; the next MINOR stops echoing it, and a client that has not added `hal.v1` will then fail its handshake.

## [0.2.1] - 2026-09-14

Identical to `0.2.0` — same files, same code. It exists to prove that a release publishes with no
credential stored in the repository: `0.2.0` had to be published with a token, because the registry
cannot hold a trusted publisher for a name that has never been published, and this is the first version
released through that publisher instead. There is nothing here to upgrade for.

## [0.2.0] - 2026-09-14

The first release under the `@re-cinq` scope. Nothing has been published before it, so there is no upgrade
path from `0.1.0` on the registry — only from the git specifier.

### Changed

- The published package carries no source maps. `files` is `["dist"]`, so every `.js.map` and `.d.ts.map`
  named a `../src/*.ts` the tarball did not contain and carried no inlined sources — 98 files that resolved
  to nothing in a debugger. Dropping them halves the file count. Step through the source from a checkout
  of the repository instead.

- The README documents the three environment variables this package actually reads — `CORS_ORIGIN`, `PORT`
  and `LOG_LEVEL` — each with its reading site, what overrides it, and its default. `AWS_REGION` and
  `GOOGLE_CLOUD_PROJECT` are gone from the provider docs: both are config fields, and setting the variable
  while passing a different `region` or `projectId` silently gives you the config value. Vendor credential
  variables are still listed, now stating that this package reads none of them — the vendor SDK does.

- The README now states which install path is supported. The registry specifier is the product; a git
  specifier builds from a checkout, carries no provenance, and pins a commit rather than a version. If you
  install from git under the key `hal-engine`, note that the rename is silent — `import 'hal-engine'` keeps
  working and `import '@re-cinq/hal-engine'` is what fails, because npm installs under the dependency key
  rather than the package name.

- **Log output is JSON, one object per line.** Lines were unstructured text (`[time] [LEVEL] [category] msg`),
  so `log.error` was indistinguishable from `log.info` to anything reading the stream. Each line now carries
  `severity`, `message`, `timestamp` and `category`, with the call site's fields under `data`. `ERROR` goes to
  stderr; every other level goes to stdout. If you parse this output, it has changed shape — see
  [docs/logging.md](docs/logging.md). Supply your own `logger` in `HalEngineConfig` to keep the old format, or
  any other — the option now reaches the package's own log calls, which it did not before this release. The
  swap is process-wide rather than per engine; `docs/logging.md` says why.

- The demo chat routes log a refusal. Every `401` emits one `warn` on category `http` carrying a fixed
  reason and nothing derived from the request, so a denied call is auditable without the log becoming a
  second place the request leaks.

- `engine.start()` rejects when the port is unavailable, instead of ending the process. There was no `error`
  listener on the HTTP server, so an `EADDRINUSE` surfaced as an unhandled event while the promise `start()`
  returned never settled — uncatchable, unretryable. The "HAL Engine started" line now logs the port that was
  actually bound rather than the one requested, which is what `transport.port: 0` makes visible.

- An optional provider SDK that is installed but has a missing dependency of its own now surfaces the loader's
  real error. It was reported as the peer being absent, so the message told you to install a package you
  already had and discarded the actual cause.

- A log call can no longer throw, whichever logger is installed. `data` that cannot be serialised — a circular
  reference, a `BigInt` — is written as `"[unserialisable]: <reason>"` with the rest of the line intact,
  instead of raising a `TypeError` out of whatever was being logged. A `WsAuthenticator` returning an identity
  with a back-reference used to take down the connection that carried it and leave its session in the store.
  A supplied `logger` that throws is caught the same way, and its line goes to the console so that it is not
  lost — which means a logger that writes and then throws emits it twice. See
  [docs/logging.md](docs/logging.md).

- `LOG_LEVEL` gates a supplied `logger` exactly as it gates the built-in one. The threshold is tested once
  before dispatch, so a level below it never reaches your implementation.

- `setLogger` is exported, so a logger installed through `HalEngineConfig` can be replaced or put back.
  Calling it with no argument restores the built-in console logger. Note that the swap is process-wide:
  `createHalEngine` installs a logger only when the config names one, so a second engine that names none keeps
  using whatever was last set. [docs/logging.md](docs/logging.md) says why.

- **Breaking: the package is ESM-only.** `require('@re-cinq/hal-engine')` no longer works. Use
  `import` from an ESM module, or stay on the git specifier until you can. The package declares
  `"type": "module"` and resolves through an `exports` map.
- **Breaking: renamed from `hal-engine` to `@re-cinq/hal-engine`.** Update the specifier in every
  `import` and in `package.json`. A dependency installed from a git specifier resolves under its
  entry **key**, not the package's `name`, so an existing `"hal-engine": "github:…"` entry keeps
  working silently — it will not tell you the package has been renamed.
- An absent optional provider SDK now fails when you construct that provider, not when you import the
  package, and raises an `AIError` with code `OPTIONAL_PEER_MISSING` naming the package and the command
  that installs it, instead of a raw `MODULE_NOT_FOUND` from inside `dist/`.
- Node 22 or newer is required, declared in `engines`.

### Added

- `LICENSE` (Apache-2.0), declared in `package.json`.
- `exports`, `repository`, `engines` and `publishConfig` entries in the manifest.
- `AuthenticatedRequest` is exported from the package root: `Request` plus an optional `user`, for typing
  the `auth.http` middleware you supply. `HttpAuthMiddleware` is stated in its terms rather than as a bare
  Express `RequestHandler`.
- Provenance. This is the first version on the registry, and it and every version after it carry an npm
  provenance attestation: `npm audit signatures` verifies that the tarball was built by a workflow in this
  repository's CI from the commit the attestation names, rather than uploaded by whoever held a token. This
  version is the one exception to how the rest are made: a name that has never been published cannot hold
  a trusted publisher, so `0.2.0` was published by a single-use workflow started by hand, and every version
  after it is published by the release workflow from a published GitHub release, with no token anywhere. It is attestable
  because the source repository is public, which [ADR-007](adrs/ADR-007-repository-visibility.md) decided
  and gives the reasoning for.

### Removed

- **Breaking: the `send_message` frame type is gone.** The WebSocket server accepted it as an alias for
  `user_message` and normalised it away. Send `user_message` instead; an alias frame now comes back as an
  `error` with code `INVALID_MESSAGE`. The exported `IncomingMessage` union never contained the alias, so
  TypeScript clients were already writing `user_message` — this affects hand-written JSON frames, including
  the one the old quick start showed.

### Fixed

- `setLogger(log)` and `logger: log` in `HalEngineConfig` no longer silence the engine. Handing the package's
  own `log` object back to it made every call recurse until the stack ran out, and the overflow was swallowed,
  so nothing was written and nothing failed. It is now treated as passing no logger: the console one is used.
  The full configuration example did exactly this; it now shows a logger of its own.
- `stop()` resolves after a `start()` that was refused, and after a second `stop()`, instead of rejecting with
  `ERR_SERVER_NOT_RUNNING`. A bind failure inside `try { await start() } finally { await stop() }` used to
  surface twice.
- Calling `start()` on a running server is refused with `HAL Engine is already started` and leaves the server
  as it was. It used to reject too, but only after removing the persistent `error` handler, so the next socket
  error on the still-running server ended the process.
- `orchestrator.hooks` is reachable through `createHalEngine`. `OrchestratorHooks` was documented but the
  factory forwarded only `maxToolRounds` and `contextConfig`, so every hook was silently dropped. Assembling
  the parts by hand is no longer the only way to use them.
- `transport.port` is honoured. It was declared on the config and never forwarded, so the server always fell
  through to `PORT` or `8086`. Resolution order is now the `start(port)` argument, then `transport.port`,
  then `PORT`, then `8086` — and `transport.port: 0` means "let the OS choose", not `8086`.
- An engine that is constructed but never started no longer keeps the process alive. The WebSocket heartbeat
  timer is `unref`ed, so the listening socket is what holds Node open, as it should be.

- Every documented model id is one the vendor still serves. Six of the seven in the docs and fixtures were
  dead or dying as of 2026-09-11 — two Claude 3 models past or at end-of-life on Bedrock, Claude Sonnet 4
  legacy on Bedrock and retired on Anthropic's own API, and both Gemini 1.5 ids gone from Vertex. `modelId`
  is an unvalidated string, so a retired id reaches you as an error that looks like your credentials are
  wrong. Bedrock examples now carry the `eu.` geo inference profile prefix, which Claude Sonnet 4.5 requires
  because it supports no in-region inference.

- The README provider table scores each provider per method. `AIProvider` has two methods and Bedrock
  implements only one — its `generateStructured` throws while Vertex's works — so two rows previously read
  `Full` while one provider did half of what the other did. Each cell now names `Implemented` or the message
  it throws, and the "switching providers is config-only" claim is qualified: it holds for `sendMessage` and
  not for `generateStructured`, with no compile-time signal either way.

- The README quick start and `docs/getting-started.md` now match the API. Both showed `PromptBuilderConfig`
  fields that do not exist (`guidelines`, `context`, `customInstructions` for `responseGuidelines`,
  `domainContext`, `toolPreamble`), a `ws` authenticator taking a token rather than the upgrade request and
  returning `userId` rather than `id`, and an `engine.listen()` that was never an API. `example/server.ts` is
  type-checked in CI now, and both documents are written against it.
- `docs/getting-started.md` no longer documents `orchestrator.hooks` on `HalEngineConfig`. `createHalEngine`
  forwards only `maxToolRounds` and `contextConfig`, so the hooks were unreachable that way; the guide now
  shows `createChatOrchestrator`, which is where they work.

- `onConnect` is now called. It was declared on the config, forwarded through `createHalEngine`, and then
  dropped before the connection handler ever saw it, so it never fired — while its sibling `onDisconnect`
  worked, which is what made the gap hard to notice. It runs once per accepted connection, after the
  `connected` frame.
- Neither lifecycle hook can take a connection down. Both now return `void | Promise<void>`, are never
  awaited, and route through one helper that logs and swallows a throw or a rejection. A rejecting
  `onDisconnect` previously reached the process as an unhandled rejection, which ends it under Node's
  defaults.

- Importing the package root no longer loads the Google Vertex AI SDK. It previously pulled in 38
  `@google-cloud/vertexai` modules whether or not you used Vertex, so a consumer of the mock or Bedrock
  provider could not install without it.
- Consumers can type-check against the published declarations. `@types/express`, `@types/node` and
  `@types/ws` are runtime dependencies now; the emitted `.d.ts` files import `express`, `http`, `stream`
  and `ws`, so with those packages dev-only a consumer resolved the runtime and then failed to compile.
- An Express `RequestHandler` can be assigned to `HttpAuthMiddleware`. The option was declared returning
  `void | Promise<void>` while Express declares its handlers `unknown`, so every middleware a consumer
  already had was refused by `tsc` and had to be re-typed or cast. The return is `unknown` now; nothing
  reads it.

- `createProvider({type: 'mock', structuredResponses})` now honours `structuredResponses`. It previously
  dropped the configuration, so the same config object behaved differently through `createProvider` than
  through `createMockProvider`. Note that the map configures `generateStructured`, which nothing inside
  `createHalEngine` calls.
- Compiled test files are no longer published in `dist/`.

### Security

- **There is somewhere to report a vulnerability.** `SECURITY.md` states the intake address, a 48-hour
  acknowledgement target, supported versions, coordinated disclosure, and what is in and out of scope. The
  address is in `package.json`'s `bugs`, so `npm view @re-cinq/hal-engine bugs` finds it without repository
  access.
- **Breaking: the HTTP chat routes deny by default.** With no `auth.http` middleware configured,
  `POST /chats`, `GET /chats/:id` and `POST /chats/:id/messages` now answer `401 Unauthorized`. They
  previously served every caller as one shared `anonymous` user, so anyone holding a chat id could read
  and post to it. Configure `auth.http` to keep them reachable.
- **Breaking: the chat routes require an identified user.** Middleware that runs but attaches no `user`,
  or a `user` whose `id` is missing, `null` or `''`, is now refused `401` as well. Ownership is enforced
  rather than skipped: chats are no longer recorded against a shared `anonymous` owner. The numeric id
  `0` is accepted — it is falsy, but `id` is `string | number` and `0` is a legal id.
- Resolved a high-severity advisory in `ws`, a direct runtime dependency. The full dependency audit went
  from 18 advisories (1 critical, 6 high) to 3 (2 moderate, 1 low), none at high or above.

[Unreleased]: https://github.com/re-cinq/HALEngine/compare/v0.3.0...main
[0.3.0]: https://github.com/re-cinq/HALEngine/releases/tag/v0.3.0
[0.2.1]: https://github.com/re-cinq/HALEngine/releases/tag/v0.2.1
[0.2.0]: https://github.com/re-cinq/HALEngine/releases/tag/v0.2.0
