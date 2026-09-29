# MongoDB Session Store

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#92 |
| Status | Implemented          |

The engine shipped `InMemorySessionStore` and nothing else, so a conversation died with the process. That is not only a resume problem: a conversation that cannot outlive its socket cannot have a retention period applied to it, cannot be handed to a human on escalation, and cannot be replayed when a customer disputes what the agent told them. In the OLT deployment its content is the customer's own booking data. Every consumer that needed durability wrote the same workaround, because the interface offered no write signal and its `delete` meant eviction to the engine and erasure to a database; `the-expert`'s `MongoSessionStore` is the worked example, a cache over an in-process `Map` with three private methods doing the real work. Shipping one store here is what stops a third consumer writing a fourth variant. **This issue does not deliver conversation resume, and this store does not make the engine safe to run as more than one instance against one conversation.**

## The collection is the truth

- A session written by `save` is returned by `get` in a second store built on the same collection, so the cache is an optimisation rather than the record ([validated by: is returned by a second store built on the same collection](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L12)).
- `delete` evicts from the cache and returns that outcome; the document survives and the next `get` reloads it ([validated by: reloads from the collection after delete evicts the cache](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L24)).
- `clear` empties the cache alone, and every document survives it ([validated by: empties the cache on clear while every document survives](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L95)).
- `evict` drops a session the client never received, without touching the collection ([validated by: drops a session from the cache on evict without touching the collection](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L104)).
- `count` reports documents rather than cache entries, which is why `delete` does not change it ([validated by: reloads from the collection after delete evicts the cache](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L24)).
- `get` reports `undefined` for a session no collection holds ([validated by: returns undefined for a session no collection holds](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L119)).
- `create` returns the session with the `authHeaders` and `workspaceId` it was given, which live in memory for the tools and are never written ([validated by: carries the create options onto the session it returns](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L125)).
- A `create` whose write fails caches nothing: the rejection reaches the caller and the store keeps no session it never stored, so a database outage cannot fill memory with conversations — or with the credentials they carry ([validated by: keeps nothing in the cache, so a failing database cannot fill memory](../../src/infrastructure/stores/mongo/mongoWriteFailure.test.ts#L20)).

## Erasing, as opposed to evicting

- `eraseConversation` removes the document permanently, and a later `get` reports `undefined` ([validated by: is gone for good once eraseConversation removes it](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L40)).
- It reports `false` for a session it never held, rather than pretending to have erased one ([validated by: reports false when eraseConversation names a session it never held](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L53)).
- `eraseOlderThan(cutoff)` removes every document whose `createdAt` precedes the cutoff and no others, asserted at the boundary with one document a second either side ([validated by: erases only what was created strictly before the cutoff](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L59)).
- `eraseAll` removes every document this store can see ([validated by: erases every conversation on eraseAll](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L111)).
- **GDPR erasure, Art. 17.** `eraseConversation` is the method an erasure request calls for, and `docs/session-stores.md` opens with the table that says which member erases and which only evicts — a reader of the previous documentation would reasonably have concluded it was `delete`, and would have been wrong ([validated by: is gone for good once eraseConversation removes it](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L40)).

## Retention needs whole-conversation timestamps

- Each document carries `createdAt` and `updatedAt`, so a retention period is expressible without a timestamp on every entry. A second `save` advances `updatedAt` and leaves `createdAt` where it was, because the write is one upsert whose `createdAt` is set only on insert — there is no read-modify-write for a concurrent save to lose ([validated by: advances updatedAt on a second save while createdAt stays where it was](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L75)).
- The clock is injectable, because `Date` has millisecond resolution and two saves inside one millisecond would otherwise produce an `updatedAt` that had not moved ([validated by: advances updatedAt on a second save while createdAt stays where it was](../../src/infrastructure/stores/mongo/mongoDurability.test.ts#L75)).

## What is never written

- **GDPR data minimisation, Art. 5(1)(c).** No persisted document holds an `authHeaders`, `authorization`, `cookie` or `host` key at any depth, asserted by walking every key of the serialised document rather than checking its top-level fields — depth is the point rather than a flourish, since `ToolEntry.toolInput` is model-supplied data and a token can arrive nested inside a tool's input, so stripping only the top level would be theatre ([validated by: holds no credential key at any depth of the stored document](../../src/infrastructure/stores/mongo/mongoRedaction.test.ts#L43)).
- The redaction removes credentials and nothing else, so the guarantee is not met by writing an empty document ([validated by: keeps everything that is not a credential, so the redaction is not simply emptying the document](../../src/infrastructure/stores/mongo/mongoRedaction.test.ts#L53)).
- Sanitising copies rather than mutates, because the live session keeps the credentials the orchestrator hands to tools through `ToolContext` ([validated by: leaves the caller their in-memory credentials, which the tools still need](../../src/infrastructure/stores/mongo/mongoRedaction.test.ts#L65); a conversation reloaded in a fresh process therefore has no `authHeaders`, and a tool that reads them sees nothing until the caller re-authenticates, which is the intended trade-off and matches what the transport already does on socket close).

## The connection is the consumer's

- The store takes a collection, a client with a database name, or a URL with one; nothing in `src/` reads the environment or carries a default host ([validated by: connects from a url the consumer supplied, and closes the client it opened](../../src/infrastructure/stores/mongo/mongoConnection.test.ts#L19)).
- `close` closes only a client the store opened, so a client the consumer owns stays open and usable afterwards ([validated by: uses a client the consumer owns and leaves it open](../../src/infrastructure/stores/mongo/mongoConnection.test.ts#L29)).
- The collection name defaults when the consumer names none ([validated by: defaults the collection name when the consumer names none](../../src/infrastructure/stores/mongo/mongoConnection.test.ts#L46)).
- `createMongoSessionStore` builds the same store from the same options, matching how the providers are exported ([validated by: is built by the factory the package exports, on the same options](../../src/infrastructure/stores/mongo/mongoConnection.test.ts#L58)).

## Costing nobody else the driver

- `mongodb` is an optional peer dependency mirrored into `devDependencies`, exactly as the two provider SDKs are, and a consumer with none of the optional peers installed can still import the package root and construct the in-memory store ([validated by: can import the package root and use the in-memory store](../../src/infrastructure/stores/mongo/optionalPeers.test.ts#L20)).

## Rationale

The driver is reached through `await import('mongodb')` inside the connect path rather than a top-level import, which the widened `Awaitable` interface makes possible without an asynchronous factory. The optional-peer check runs the built package in a child process with the three optional peers made unresolvable, because ts-jest erases a type-only import either way and an in-process assertion would prove nothing. The exported option types are structural ports rather than the driver's own, so `mongodb` appears nowhere in the published declarations and a consumer without the driver installed can still type-check against the package.

The cache is load-bearing rather than an optimisation of convenience: the orchestrator mutates a session in place while a turn streams, so `get` has to hand back a stable object for the same id. The consequence is that two store instances in one process are not coherent with each other until a `save`, and two processes serving one conversation at once is not something this store supports.

## Out of scope

Conversation resume from a session id (re-cinq/Otto#103); telling an expired session from one that never existed (re-cinq/Otto#141); bounding and redacting what a session keeps (re-cinq/Otto#89); the retention period itself, which is a deployment's decision and belongs in the consumer's configuration with a named human behind it; and any scheduler — `eraseOlderThan` is a method the consumer calls, because a library-owned timer keeps a consumer's process alive.
