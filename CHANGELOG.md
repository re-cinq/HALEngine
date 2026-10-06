# Changelog

All notable changes to `@re-cinq/hal-engine` are documented here.

The format is [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries are written for somebody installing the
package, not for somebody reading this repository's commit log.

## [Unreleased]

### Added

- `SessionStore.listFor(userId, options?)`, an optional store member that answers the summaries of a user's conversations — `sessionId`, `createdAt`, `updatedAt` and `entryCount` — most recent activity first, so a client can offer a conversation list instead of only rejoining one. `InMemorySessionStore` and `MongoSessionStore` both implement it; a store of your own may leave it out. A summary never carries a conversation's entries or its credentials. Page with `limit` (50 by default, 200 at most, and `0` answers nothing) and `before`, which takes the last summary you saw: the cursor carries both `updatedAt` and `sessionId`, so two conversations saved in the same millisecond cannot straddle a page boundary and go unlisted. See `docs/session-stores.md` § Listing a user's conversations.

### Changed

- `MongoSessionStore` now writes an `entryCount` field beside the entries on every save, so a conversation list can count a conversation without reading one. A document saved by an earlier version lists as a conversation of no entries until you backfill it; `docs/session-stores.md` carries the one-line command.

## [0.5.0] - 2026-10-04

**Upgrading from 0.4.x.** One thing is removed, and several things an existing consumer observes change. Check these before you bump:

- Every client must offer `hal.v1` beside its token, `new WebSocket(url, ['hal.v1', token])`. A bare-token offer, accepted with a deprecation warning since 0.3.0, now fails to connect, and `credentialFromSubprotocol` returns `undefined` for it.
- Closing a socket abandons its turn: the run stops reading from the model and abandons its tool calls, no `stream_end` follows the close, and `afterModelResponse` and `onError` do not fire for it, while `afterSession` still does. A missed heartbeat and `stop()` close sockets too, so drain connections before a deploy.
- Every tool call now has 30 seconds to settle, a `beforeToolCall` policy included. A tool that legitimately runs longer needs a larger `toolTimeoutMs`, or `0` for the old unbounded wait.
- `ToolRegistry.execute` no longer throws for a tool name the model invented, or rejects when an executor throws: the model is answered instead. It throws a `TypeError` for an input that is not an object, whatever the tool's schema.
- Messages in one session are answered one at a time, so a message sent while another is streaming starts after that one's `stream_end`.
- Tools now run on Vertex, where a function-calling turn ends `tool_use` instead of `end_turn`. If you read `stopReason` yourself, expect the new value.
- Two new `error` log lines: `authenticator failed` for a `WsAuthenticator` that throws or rejects, and `tool executor threw` for a tool executor that does. Alerting that counts error lines will see both.
- Resume is opt-in and changes nothing until you enable it. With it on, do not erase a conversation in `onDisconnect`: the socket a resume replaced can report `onDisconnect` after the resume.

Upgrade even if you use none of the new features: on every release up to and including 0.4.0, one malformed upgrade request with no credentials ends the process (see Security), and so does a Vertex stream that fails mid-way (see Fixed). Coming from 0.3.x, read the 0.4.0 notes below as well.

### Added

- **Session resume**, opt-in via `transport: {resume: {enabled: true}}` and exported as `SessionResumeOptions`. A client that reconnects to `{basePath}/ws?sessionId=<id>`, with the id from its last `connected` frame, gets its conversation back: the frame carries `resumed: true` and `entryCount`, and each stored entry is replayed as an `entry_upsert` at its index. The id is not a credential. It is resumed only for the stored session's own user; any other id, whether another user's, one never issued or one the store no longer holds, gets a fresh session and `resumed: false`, and the three are indistinguishable, so the answer reveals nothing about which ids exist. A requested id is never adopted for a new session. An entry still streaming when its session is resumed, because its turn is running on the socket that started it, is replayed finished and flagged `truncated: true`, since the rest of that turn goes to the other socket. A session open on more than one socket carries the newest one's credentials and, when that socket closes, takes those of the newest one still open. `onConnect` receives `{resumed}` as a second argument, exported as `ConnectInfo`, so a consumer can tell a resumed connection from a new session. `onConnect` and `onDisconnect` stay per connection and come in pairs, so the socket a resume replaced can report `onDisconnect` after the resume: with resume on, do not erase a conversation in `onDisconnect`. With resume off, nothing changes: the `connected` frame carries neither new field. **GDPR**: with resume on, conversations outlive their sockets, so bound retention yourself, with `maxAgeMs` on `InMemorySessionStore` or `MongoSessionStore`'s erasure methods.
- **Continue the latest session**, opt-in via `resume: {enabled: true, latest: true}`. A connect that names no `?sessionId=`, after a page refresh or from a new tab, rejoins the user's most recently active conversation instead of starting an empty one, and `?new=1` starts a new one on purpose. Stores supply it through the new optional `SessionStore.latestFor(userId)`: `InMemorySessionStore` goes by the newest entry, `MongoSessionStore` by `updatedAt`, so create an index on `{userId: 1, updatedAt: -1}` (see docs/session-stores.md). A store without `latestFor` starts a new session as before. "Latest" is keyed on the authenticated user's id, so it assumes one login per person.
- **Tell an expired session from one that never existed.** `SessionStore` gains an optional `lookup(sessionId)`, exported with its result type `SessionLookup`, that answers `{status: 'active', session}`, `{status: 'expired', userId}` or `{status: 'missing'}`; `InMemorySessionStore` implements it against `maxAgeMs`, reporting an expired session once and then forgetting it. The `connected` frame gains `resumeFailure` when a named id was not rejoined: `expired` only for the session's own owner, `unknown` for every other case, so the answer still reveals nothing about ids that are not the caller's. A store without `lookup` behaves as before, with every failure reading `unknown`; `MongoSessionStore` has none, since its documents do not expire.
- Stored assistant and thinking entries gain an optional `suppressed: true` when a tool suppressed the response and the client was shown the entry blank or not at all. A resumed session replays such an entry as `entry_skip`, so a reconnecting client never sees text a tool hid. The entry keeps its text for the model's history.
- **Cancel a model call.** `SendMessageParams` takes an optional `signal`. Once it aborts, a provider yields nothing more and ends its stream without an error, and a signal already aborted sends nothing to the vendor. `withRetry` now gives every attempt a signal of its own and aborts it once the attempt is over, whether it failed, timed out, finished or its reader stopped, before any next attempt starts, and it composes a signal you pass with that one rather than replacing it. What an abort stops depends on the vendor SDK: Bedrock's closes the request, so the vendor stops sending; `@google-cloud/vertexai`, measured at 1.10.4, cannot cancel a call, so on Vertex the engine stops reading while the vendor request runs to completion. **GDPR**: on Vertex an abandoned or retried call still transfers the whole conversation and its answer, which a record of where personal data goes has to reflect. A custom `AIProvider` that ignores `signal` still compiles and behaves as before; docs/implementing-a-provider.md § Cancellation shows how to honour it.
- **A deadline on every tool call.** `toolTimeoutMs`, on `ChatOrchestratorOptions` and `HalEngineConfig.orchestrator`, abandons a tool call that has not settled in time and answers the model with a `tool_result` saying the tool did not answer within the deadline; the round's other calls keep their results. The default is `30000`, and `0` waits forever. `ToolContext` gains a `signal` that is aborted at that moment, with a `TimeoutError` as its reason, so a tool that passes it to `fetch` stops its own request too; a tool that ignores it keeps running unobserved, and keeps sending whatever its request carries. **Behaviour change**: a tool call used to be awaited for as long as it took, so a tool that never returned held its turn, and the socket, open with no `stream_end`; it is now abandoned at 30 seconds. Set `toolTimeoutMs: 0` to keep the old wait. The deadline also covers a `beforeToolCall` policy, so a policy that waits on a person needs a larger `toolTimeoutMs`, and a call abandoned while its policy was still deciding is never started. Each call in a round now gets its own `ToolContext`, so a tool that changes a field of its context no longer affects the other calls in its round. The timeout result and its log line carry the tool's name and the elapsed time, nothing from the call's input.

### Removed

- **A bare-token subprotocol offer is no longer accepted.** `0.3.x` and `0.4.x` still echoed an offer without `hal.v1` for one MINOR, which put the access token in the 101 response headers and the socket's `protocol` property. Such an offer is now answered with no `Sec-WebSocket-Protocol` header, which `ws` and Chromium both fail, and the deprecation warning is gone. **Migration**: every client must offer `hal.v1` beside its token, `new WebSocket(url, ['hal.v1', token])`, the shape documented since `0.3.0`.

### Changed

- `credentialFromSubprotocol` returns `undefined` unless the offer includes `hal.v1`, so a bare-token offer no longer authenticates a connection its client is about to fail. A `WsAuthenticator` that already expects the marker needs no change.
- A `WsAuthenticator` that throws or rejects is now logged at `error` as `authenticator failed`, with the error's type alone in `errorType`. Its message is never logged, since it can carry the credential being checked. Such a request was already answered `500`, but with no log line.
- **Closing a socket abandons its turn.** A turn used to run to completion after its socket closed: the model kept generating billed tokens, tools kept running on behalf of a user who had left, and frames went to a socket nobody read. Now the run stops pulling from the model and passes the abort on: the provider gets it through `SendMessageParams.signal` (Bedrock closes the request, Vertex can only stop reading), and a tool call is abandoned at once, its `ToolContext.signal` aborted. A message queued behind the turn is dropped, and no `stream_end` is sent, since nobody is left to read it. `afterSession` still fires, `afterModelResponse` and `onError` do not, and the session keeps the answer as it stood, committed and flagged `truncated`, so a resumed session shows it cut off. A missed heartbeat and `stop()` close sockets too, so a deploy that stops the server abandons every turn in flight: drain connections first. `ChatOrchestrator.processMessageStream` takes an optional `{signal}` that does the same for a caller of its own.

### Fixed

- **Messages in one session are answered one at a time, in the order they arrived.** A `user_message` sent while another was still streaming used to start a second run on the same session: the two interleaved their entries, both streamed to the socket, and the second run handed the model the first answer half-written as if it were settled. The second message now waits for the first one's `stream_end`, which also makes the reconnect flush of queued messages safe. A consumer that sent overlapping messages now gets sequential answers, so the second starts later than before. A `ping`, malformed or not, is still answered at once. A `user_message` that fails validation is answered in turn, its `INVALID_MESSAGE` and `stream_end` after the run in progress, since an `error` frame names no message. A queued message whose socket closed before its turn came is dropped rather than answered to nobody.
- An answer still streaming when a tool suppresses the response is now committed and retracted like an answer already sent, instead of staying on screen half-written and never committed. A thought still streaming is committed as the client saw it. Whatever the model writes after suppression opens a new entry the client is only sent as `entry_skip`.
- **A Vertex stream that failed mid-way ended the process.** `@google-cloud/vertexai` fills a `response` promise from a copy of the stream it returns, and nothing observed that promise, so when the stream failed, through a dropped connection or a malformed chunk, its rejection went unhandled and Node exited, although the engine had already caught the same failure. The promise is now observed. Every release up to and including `0.4.0` is affected.
- **No tool ever ran on Vertex.** The tool loop continues only on `stopReason: 'tool_use'`, but Gemini finishes a function-calling turn `STOP`, which the Vertex provider reported as `end_turn`. So on Vertex a tool call was streamed and then dropped, and the turn ended without running the tool or answering. A turn that called a tool now ends `tool_use`, as on Bedrock. A turn cut off at `MAX_TOKENS` still ends `max_tokens` and does not run its call, and every Vertex stream now ends with exactly one `stop` chunk, even when no chunk names a finish reason. **Behaviour change**: if you read `stopReason` yourself, a function-calling turn on Vertex now ends `tool_use` where it ended `end_turn`. Every release up to and including `0.4.0` is affected.
- **A failing tool call no longer fails the turn.** A tool name the model invented made `ToolRegistry.execute` throw `Unknown tool: <name>`, and an executor that threw made it reject; either way the round's other results were lost and the turn ended with a `SERVER_ERROR`. Now the model is answered instead: an invented name with a result naming it and the registered tools, a throwing executor with a result saying the call failed, and the turn goes on to its answer. The thrown message is never shown to the model, since a third-party error can carry an internal host name or another user's identifier: it is logged at `error`, cut to 500 characters, and nothing from the call's input reaches the answer or the log. A throw once the turn was abandoned, such as a tool's `fetch` rejecting after a closed socket aborted its `signal`, is logged at `info` as `tool call abandoned` instead, since a user leaving is not a tool failing; a throw after the call's deadline is still logged at `error`. **Behaviour change**: `execute` no longer throws or rejects for these, so a caller catching `Unknown tool: <name>` stops seeing it. An input that is not an object, such as `null` or an array, now throws a `TypeError` whatever the tool's schema, where it used to be answered to the model under some schemas and throw under others: no provider sends the model's arguments as anything but an object, so it can only be a caller's bug.

### Security

- **One malformed WebSocket upgrade could end the process.** An upgrade request with an empty or missing `Host` header, or with a request-target that is not a URL such as `//`, threw from the server's `upgrade` listener, where nothing catches it, so a single request with no credentials ended the process and every conversation on it. Such a request is now answered `400 Bad Request`. A `WsAuthenticator` that throws synchronously, instead of rejecting, is now answered `500` rather than ending the process too, and one that returns a user without a promise is accepted as if it had resolved to it. Every release up to and including `0.4.0` is affected. A proxy in front that always sets `Host` does not close this on its own, since a `//` target with a valid `Host` is enough.

## [0.4.0] - 2026-09-29

**Upgrading from 0.3.x.** Nothing is removed and no existing signature changes, but check these before you bump:

- The engine no longer erases a conversation when its socket closes. If you relied on that, pass `onDisconnect: sessionId => store.delete(sessionId)` — and do not point it at `MongoSessionStore`, where `delete` destroys the document.
- `afterModelResponse` now receives the sum of every provider call in the turn, so a tool-heavy turn reports a larger number than it did on 0.3.x. Billing and audit consumers will see the totals rise; that is the corrected figure, not a regression.
- `onError` now fires for rejections that are not `Error` instances, wrapped in an `Error` whose `cause` is the original value. A hook that counts failures will count calls it never saw before.
- `SessionStore` members are now `Awaitable<T>`. A synchronous store needs no change.
- New optional peer dependency: `mongodb`, loaded only if `MongoSessionStore` actually connects.

### Added

- `SessionStore` gains an optional `save(session)` member: the write signal a durable store needs. The engine calls it once per processed user message, from the same `finally` path that runs `afterSession`, so it fires for a turn that ended in a provider error as well as one that succeeded — a store that only heard about successes would lose exactly the conversations a customer complains about. By the time it runs, the turn's entries are committed, so the assistant entry's `isStreaming` is already `false` — including when a provider threw mid-stream, where the engine now closes the open entry before saving, recording `truncated` on it, rather than persisting a half-streamed entry that looks finished. An `afterSession` hook that throws no longer costs the turn its write signal. What `save` throws or rejects with is caught and logged as one line carrying the session id, and the turn continues: the client still receives its full stream and `stream_end`, because a database outage is not a reason for the agent to stop answering. The member is typed `void | Promise<void>`, so a synchronous implementation and an `async` one both satisfy it. Additive: `InMemorySessionStore` does not implement `save` and is unchanged, and a store that omits it behaves exactly as before.
- `SessionStore` gains an optional `evict(sessionId)` member, and `InMemorySessionStore` implements it. The engine calls it only for a session whose socket closed while `create` was still pending — one that no client ever received and that has no entries to keep. `InMemorySessionStore` now also takes `{maxAgeMs}` (default `28_800_000`, eight hours), exported as `InMemorySessionStoreOptions`. Expired sessions are evicted when read and swept at the head of `create`, which stops at the first live session, so the bound costs nothing on a busy store. There is no timer: a library-owned interval would keep your process alive.
- **`MongoSessionStore`**, a durable session store, exported as `MongoSessionStore` and `createMongoSessionStore`. It takes a collection, a client with a database name, or a connection URL — nothing in the package reads the environment or assumes a host. The collection is the truth and the in-process cache is an optimisation: a session written by `save` is readable by a second store on the same collection. `delete` removes the document — it is the consumer's erasure primitive and the engine never calls it — as do `eraseConversation`, `eraseOlderThan(cutoff)` and `eraseAll`, while `clear` alone touches only the cache; `docs/session-stores.md` opens with the table that says which is which, because the previous documentation would have led you to believe `delete` erased. Documents carry `createdAt` and `updatedAt`, so a retention period is expressible without per-entry timestamps. **No credential is ever written**: `authHeaders`, `authorization`, `cookie` and `host` are stripped at any depth, not just the top level, and the same `stripCredentialKeys` is exported for stores you write yourself. `mongodb` is an optional peer dependency loaded only when the store actually connects, so a consumer who installs no optional peer can still import the package root and use the in-memory store. **Migration note**: `delete` and `evict` both erase on this store, so the one-line `onDisconnect: sessionId => store.delete(sessionId)` that restores the pre-0.4 close behaviour destroys the conversation on every socket close — point `onDisconnect` at neither. Nothing needs reclaiming by hand: the in-process cache is bounded by `maxAgeMs` (eight hours by default) and drops stale entries without touching a document. This does **not** deliver conversation resume, and it does not make the engine safe to run as more than one instance against one conversation.
- `withRetry(provider, policy)` decorator wraps any `AIProvider` with per-attempt retry and timeout logic. Pass it a `RetryPolicy` — all fields optional — to absorb transient provider failures before they reach the caller. Defaults: `maxAttempts: 3`, `baseDelayMs: 500`, `maxDelayMs: 5000`, `firstChunkTimeoutMs: 30000`, `idleChunkTimeoutMs: 30000`. A hung request (first chunk never arrives) is abandoned and retried; a stalled stream (idle after the first chunk) surfaces as an `AIError` with code `TIMEOUT` and is not retried, because chunks already streamed cannot be un-sent. Backoff is exponential with full jitter. Both `withRetry` and `RetryPolicy` are exported from the package root.
- `HalEngineConfig` gains an optional `resilience?: RetryPolicy` field. When present, `createHalEngine` wraps the provider with `withRetry` between `createProvider` and `createChatOrchestrator`; when absent, behaviour is unchanged. This is a strictly additive change — no existing call to `createHalEngine` is affected, so the version bump is MINOR.

### Changed

- Every `SessionStore` member is now `Awaitable<T>` (`T | Promise<T>`) rather than a bare `T`, so a store backed by a database is expressible for the first time. `Awaitable` is exported from the package root. **A synchronous implementation needs no change** — `T` is assignable to `T | Promise<T>` in a return position — and `InMemorySessionStore` is unedited. The WebSocket connection handler now awaits `create` and the release that follows a close: it pauses the socket across the await so a frame sent before `connected` arrives is buffered rather than dropped, attaches its `close` listener before the await so a socket that closes mid-create leaves no session behind, and catches a rejection from either call so one store failure closes one socket instead of ending the process with an unhandled rejection. **Migration note**: the `connected` frame now arrives one tick later, after the awaited `create`, so a client that waits for it (as the protocol already requires) sees no difference; only code that assumed the frame was emitted synchronously with the upgrade does.
- **The engine no longer erases a conversation when its socket closes.** The WebSocket close handler called `sessionStore.delete(sessionId)` unconditionally, which meant that behind a durable store every conversation was written and then destroyed the moment the customer closed their tab — the opposite of what this engine's own documentation promised. `SessionStore.delete` now has no engine-internal caller at all and is purely your erasure primitive. The credentials the socket carried are cleared from the session on close, since they were issued for a request that is over; the entries are untouched. **Migration note**: to restore the old behaviour exactly, pass `onDisconnect: sessionId => store.delete(sessionId)` — that one line is the whole migration. If you rely on the default store not growing, note that it is now bounded by `maxAgeMs` (eight hours) rather than by the close handler; that is a memory bound, not a retention policy, and the retention decision remains yours.
- The `afterModelResponse` hook now receives the accumulated usage across every provider call in the turn, not only the last one. Existing consumers that use this hook for billing or audit will see larger totals for turns that called tools — this is the correct number. A turn with no tool calls is unchanged.
- `onError` now fires for every rejection, not only those where the thrown value is an `Error` instance. A value that is not already an `Error` is wrapped in one whose `cause` is the original, so a hook typed against `Error` keeps compiling; a hook that wants the raw value can retrieve it via `error.cause`. **Migration note**: a deployer whose `onError` hook previously never fired for string or plain-object rejections will now see those calls; the caller-boundary rejection value is unchanged.

### Fixed

- `onError` and `afterSession` hooks now fire when `beforeSession` throws, matching the guarantee the hook names imply. Previously, a throw from `beforeSession` escaped the `try`/`finally` block entirely, so neither hook ran. **Migration note**: if your `afterSession` hook assumed it would only be called after a full session turn, it will now also be called when `beforeSession` itself fails — the hook can inspect the session to detect this case (no entries beyond the initial user message will have been processed).

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

[Unreleased]: https://github.com/re-cinq/HALEngine/compare/v0.5.0...main
[0.5.0]: https://github.com/re-cinq/HALEngine/releases/tag/v0.5.0
[0.4.0]: https://github.com/re-cinq/HALEngine/releases/tag/v0.4.0
[0.3.0]: https://github.com/re-cinq/HALEngine/releases/tag/v0.3.0
[0.2.1]: https://github.com/re-cinq/HALEngine/releases/tag/v0.2.1
[0.2.0]: https://github.com/re-cinq/HALEngine/releases/tag/v0.2.0
