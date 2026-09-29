# Awaitable Session Store

| Field  | Value                 |
| ------ | --------------------- |
| Issue  | re-cinq/Otto#102      |
| Status | Implemented           |

`SessionStore` was fully synchronous — `create` returned `T`, `get` returned `T | undefined`, `delete` returned `boolean` — and no store backed by a real database can honour that. The org already had the proof: `the-expert`'s `MongoSessionStore` satisfies the interface out of an in-process `Map` and does every durable operation through three private methods that are not on the interface at all, so what is called a `SessionStore` is really a cache plus a hidden API. Every member is now `Awaitable<T>`, which is `T | Promise<T>` rather than a hard `Promise<T>`, so a synchronous implementation needs no change while a database-backed one becomes expressible for the first time. The only call site that had to change is the WebSocket connection handler, and the care there is about what happens to a socket while the store is still thinking. The known consumer, `the-expert`, types its store as the concrete `MongoSessionStore` class rather than as the interface, so it is unaffected either way.

## The widened interface

- Every member is `Awaitable`, so a fully synchronous store and a fully asynchronous one both satisfy the same interface with `InMemorySessionStore` unedited; `create`'s parameter list is unchanged, so widening the return types is the whole of the type change, and `Awaitable<T>` is exported from the package root beside `SessionStore` because a consumer writing an implementation needs to name what it is satisfying ([validated by: accepts a fully synchronous store and a fully asynchronous one](../../src/infrastructure/stores/sessionStoreAwaitable.test.ts#L18)).

## Waiting without dropping a frame

- The socket is paused before the awaited `create` and resumed only once the `message` listener is attached, so a client that sends its first frame in its `open` handler — before `connected` has arrived — is answered rather than ignored; the `connected` frame still precedes every entry frame ([validated by: delivers a frame sent before the connected frame arrives](../../src/transport/awaitedSessionCreate.test.ts#L33)).
- The `connected` frame is no longer sent inside the connection listener's own tick, since it now follows an awaited `create`. The hook ordering it anchors is unchanged: `onConnect` still runs after that frame is sent ([validated by: runs after the connected frame is sent, not before it](../../src/transport/ws/connectionHandler.test.ts#L82)).

## When the socket loses the race

- A socket that closes while `create` is still pending leaves no session behind: the `close` listener is attached before the await rather than after it, since one attached afterwards would miss the event entirely, so the handler releases the session once the create resolves and sends no `connected` frame to a socket that is already gone ([validated by: leaves no session behind when the socket closes during create](../../src/transport/awaitedSessionCreate.test.ts#L42)).
- `onDisconnect` is the other half of `onConnect` rather than of the socket: a connection that was never handed a session — because `create` rejected, or because the socket closed before the `connected` frame — fires neither hook ([validated by: stays silent for a connection that was never handed a session](../../src/transport/ws/connectionHandler.test.ts#L216)).

## When the store fails

- **NIS-2 Article 21.** A `create` that rejects closes that one socket with an `error` frame carrying `SERVER_ERROR` and produces no `unhandledRejection`, since an async connection listener that rejects would otherwise end the process and take every other conversation on the server with it; the socket is resumed before it is closed, because `ws.close()` on a paused socket waits for a close frame it can never read and gives up only after the library's own thirty-second timeout ([validated by: answers a rejecting create with SERVER_ERROR rather than an unhandled rejection](../../src/transport/awaitedSessionCreate.test.ts#L56)).
- **GDPR.** A store call that rejects while releasing a session is caught and logged with the session id, so a cleanup that failed is reported rather than silently recorded as done ([validated by: logs a rejecting evict rather than dropping it](../../src/transport/ws/connectionHandler.test.ts#L192)).

## Compatibility

- A synchronous implementation needs no change: `T` is assignable to `T | Promise<T>` in a return position, so `InMemorySessionStore` satisfies the widened interface unedited and its own suite passes with no `await` added ([validated by: accepts a fully synchronous store and a fully asynchronous one](../../src/infrastructure/stores/sessionStoreAwaitable.test.ts#L18)).
- The one observable change is timing rather than type: the `connected` frame now arrives a tick later than it did. A client that waits for the frame, as the protocol already requires, cannot tell the difference ([validated by: delivers a frame sent before the connected frame arrives](../../src/transport/awaitedSessionCreate.test.ts#L33)).

## Out of scope

Resuming a conversation from a session id (re-cinq/Otto#103); removing the engine's `delete` call on socket close, which this issue only makes observable rather than settles (re-cinq/Otto#117); what `delete` should mean once a store is durable; bounding and redacting what a session keeps (re-cinq/Otto#89); and the Mongo-backed store itself (re-cinq/HALEngine#92).
