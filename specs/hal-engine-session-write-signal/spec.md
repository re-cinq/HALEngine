# Session Write Signal

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#91 |
| Status | Implemented          |

`SessionStore` had five members — `create`, `get`, `delete`, `count`, `clear` — and none of them was a write signal. The engine mutates `ChatSession.entries` in place through `appendEntry`, `appendDelta` and `commitEntry`, and called no store method afterwards, so a store that wanted to persist a finished turn had to guess when one ended. The gap had already been paid for in a consumer's own code: a `MongoSessionStore` that satisfies the interface out of an in-process `Map` and does every durable operation through three private methods that are not on the interface at all, so what is called a `SessionStore` is really a cache plus a hidden API. `save` is that missing signal, and it is only the signal — no database, and no change to the synchronous shape of the other five members. Swallowing its failures is the design rather than an oversight: a database outage is not a reason for the agent to stop answering a customer mid-sentence, and a store that needs its write failures to be loud raises them from inside its own implementation, where it knows what a failed write means for its data.

## When it fires

- `save` fires exactly once for one processed user message ([validated by: saves once for one processed user message](../../src/orchestration/sessionSave.test.ts#L31)).
- It is called from the orchestrator's `finally` path, the same one that runs `afterSession`, rather than from the success path, because a turn that ended in a provider error still produced a user entry worth keeping and a store that only heard about successes would silently lose exactly the conversations a customer complains about: a provider that rejects still produces one `save`, and the rejection still reaches the caller ([validated by: saves once and still rethrows when the provider fails](../../src/orchestration/sessionSave.test.ts#L39)).
- The store reaches the orchestrator through `ChatOrchestratorOptions.sessionStore`, which `createHalEngine` forwards from `HalEngineConfig.session` — the same store the transport already received ([validated by: forwards the session store, so its write signal reaches the orchestrator](../../src/config.test.ts#L327)).

## What it carries

- The session handed to `save` carries the turn's user entry and its assistant entry, with the assistant's `isStreaming` already `false` ([validated by: saves the user entry and the committed assistant entry](../../src/transport/ws/sessionSave.test.ts#L34)).
- That holds however the turn ended. On the success path the transport has already committed the entry by then, because `processStopChunk` runs on the provider's `stop` chunk and a generator's `finally` only runs once its consumer pulls after the last chunk. When a provider throws mid-stream it has not: the throw reaches the orchestrator's `finally` first, so the orchestrator closes any entry still marked streaming before saving, and nothing persists a half-streamed entry ([validated by: saves a committed assistant entry even when the provider dies mid-stream](../../src/transport/ws/sessionSave.test.ts#L47)).
- An entry still open when the turn ended was cut short, so closing it also records `truncated`, and a store therefore persists the failure rather than a conversation that merely looks finished ([validated by: saves a committed assistant entry even when the provider dies mid-stream](../../src/transport/ws/sessionSave.test.ts#L47)).
- A turn that ended on the provider's `stop` records no `truncated` flag, because nothing was still open to close ([validated by: saves the user entry and the committed assistant entry](../../src/transport/ws/sessionSave.test.ts#L34)).
- A turn driven through the orchestrator alone never produces an assistant entry at all, since the orchestrator only ever appends the user's, which is why the statement above is validated from the transport side rather than beside the other four ([validated by: saves once for one processed user message](../../src/orchestration/sessionSave.test.ts#L31)).

## When it fails

- **NIS-2 Article 21.** A `save` that rejects does not fail the turn: the caller still receives the answer, and the failure becomes exactly one logged line under category `orchestrator`, message `session save failed`, carrying the session id and the error's message ([validated by: keeps the turn alive and logs once when save rejects](../../src/orchestration/sessionSave.test.ts#L48)).
- A `save` that throws synchronously is handled identically, so an implementation that forgets to be async cannot take the turn down ([validated by: keeps the turn alive when save throws synchronously](../../src/orchestration/sessionSave.test.ts#L57)).
- An `afterSession` hook that throws does not cost the turn its write signal: `save` still fires, and the hook's error still reaches the caller ([validated by: saves even when an afterSession hook throws](../../src/orchestration/sessionSave.test.ts#L73)).

## Compatibility

- `save` is optional: a store that omits it behaves exactly as it did before the member existed, and logs nothing ([validated by: logs nothing for a store that implements no save](../../src/orchestration/sessionSave.test.ts#L67)).
- `InMemorySessionStore` is deliberately not edited, and the member is typed `void | Promise<void>` rather than `Promise<void>`, so its absence of `save` is the compatibility case while a synchronous implementation and an `async` one both satisfy the interface, owing nothing to the queued `Awaitable` change ([validated by: accepts a synchronous save, an async save, and the shipped store that has none](../../src/infrastructure/stores/sessionStoreSaveSignature.test.ts#L11)).
- No exported name or signature changes and no existing behaviour changes, so the bump is MINOR ([validated by: logs nothing for a store that implements no save](../../src/orchestration/sessionSave.test.ts#L67)).

## Out of scope

The Mongo-backed store, its erasure methods and its test harness (re-cinq/HALEngine#92); widening the five existing members to `Awaitable` (re-cinq/HALEngine#42); removing the engine's `delete` call on socket close (re-cinq/HALEngine#44); bounding and redacting what a session keeps (re-cinq/HALEngine#41); and resume from a session id (re-cinq/HALEngine#45). None of those is needed for a write signal to exist and be tested.
