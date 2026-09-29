# Session Lifetime

| Field  | Value            |
| ------ | ---------------- |
| Issue  | re-cinq/Otto#117 |
| Status | Implemented      |

The WebSocket `close` handler called `sessionStore.delete(sessionId)` unconditionally, and it was the only caller of `delete` in the engine outside the store's own tests. Composed with a durable store that destroys data: the one persistent store the engine's own documentation sketches implements `delete` as a real deletion, so mounted behind this transport every conversation was written and then erased the moment the customer closed their tab. The engine's own spec already promised the opposite — sessions persist across disconnections — and the transport did the reverse. The call is gone. `SessionStore.delete` keeps its name and now has no engine-internal caller at all, which makes it purely the consumer's erasure primitive and makes the existing GDPR erasure documentation true for the first time. Because nothing erases on close any more, the default in-memory store would grow without bound, so it gains an age bound of its own — a memory bound, not a retention decision, which belongs to the deployment with a named human behind it.

## What a close now does

- A conversation survives its socket: after a full turn and a clean close, the store still holds the session and its entries are intact ([validated by: survives the close with its entries intact](../../src/transport/sessionSurvivesClose.test.ts#L40)).
- `onDisconnect` is the consumer's seam and fires while the store still holds the session, so a consumer that wants the old behaviour writes `onDisconnect: sessionId => store.delete(sessionId)` — that one line is the whole migration ([validated by: is called with the session id while the store still holds the session](../../src/transport/ws/connectionHandler.test.ts#L135), [validated by: reaches an onDisconnect that can still read the session it names](../../src/transport/sessionSurvivesClose.test.ts#L52)).
- **GDPR data minimisation, Art. 5(1)(c).** The credentials the socket carried are cleared from the session on close. They were issued for a request that is over, and without this they would sit in memory for as long as the conversation does; the entries, which are what the consumer keeps, are untouched ([validated by: survives the close with its entries intact](../../src/transport/sessionSurvivesClose.test.ts#L40)).

## Evicting what nobody received

- A session whose socket closed while `create` was still pending is dropped through the optional `evict` member rather than `delete`: it has no entries and nothing to migrate, so dropping it erases nothing a consumer would want kept, and the close path of a delivered session calls no store method at all ([validated by: logs a rejecting evict rather than dropping it](../../src/transport/ws/connectionHandler.test.ts#L192)).
- A session whose socket closed before it was delivered has its credentials cleared too, because `evict` is optional and a store that implements none still holds it ([validated by: clears the credentials of a session whose socket closed before it was delivered](../../src/transport/ws/connectionHandler.test.ts#L222)).
- An `evict` that rejects is caught and logged with the session id rather than dropped, so a cleanup that failed is reported ([validated by: logs a rejecting evict rather than dropping it](../../src/transport/ws/connectionHandler.test.ts#L192)).

## The default store's memory bound

- `InMemorySessionStore` takes `{maxAgeMs}` and defaults to eight hours ([validated by: defaults to eight hours](../../src/infrastructure/stores/sessionAgeBound.test.ts#L17)).
- An expired session is evicted lazily when it is read ([validated by: evicts lazily on get once maxAgeMs has passed](../../src/infrastructure/stores/sessionAgeBound.test.ts#L26)).
- It is also swept at the head of `create`, so a session nobody ever reads again still leaves ([validated by: sweeps an expired session on the next create without anyone reading it](../../src/infrastructure/stores/sessionAgeBound.test.ts#L35)).
- The sweep stops at the first live session, so a thousand live sessions with one expired at the head cost two iterations rather than a thousand ([validated by: stops the sweep at the first live session rather than scanning all 1,000](../../src/infrastructure/stores/sessionAgeBound.test.ts#L45)).
- A session stamped with an unusable clock reading never ages out, rather than expiring immediately ([validated by: never expires a session whose creation time was not a finite number](../../src/infrastructure/stores/sessionAgeBound.test.ts#L57)).
- **NIS-2 availability.** With no sockets open, the store returns to zero once every session has passed `maxAgeMs`, so the removed `delete` is not quietly replaced by unbounded growth ([validated by: returns to zero once every session has passed maxAgeMs](../../src/infrastructure/stores/sessionAgeBound.test.ts#L68)).
- Eviction removes the index entry, not a live connection's held reference: a socket open past `maxAgeMs` keeps streaming normally, and only a later lookup of that id starts fresh ([validated by: keeps streaming on a socket held open past maxAgeMs, whose id has left the index](../../src/transport/sessionSurvivesClose.test.ts#L62)).

## Why it works this way

The clearing is an in-memory measure. `authHeaders` is transport state rather than conversation content, and no store should persist it at all: the credentials reach a store only if that store writes them, and by then the close event has not yet fired, so no engine-side hook could un-write them. `MongoSessionStore` enforces the rule instead of advising it, stripping every credential key from what it writes, and `stripCredentialKeys` is exported for a store a consumer writes themselves.

There is no timer. A library-owned `setInterval` keeps a consumer's process alive unless it is unref'd, and the engine already owns one interval; age is checked when the store is touched instead. The creation time is held in a record beside the session rather than as a field on `ChatSession`, because `ChatSession` is exported and a new field there would become public API every custom store had to populate — and because a separate map could desync, leaving a session that carries credentials with no timestamp and therefore no expiry. Insertion order only approximates age order: `Map.set` on an existing key keeps its original position, and the clock can step backwards. Both make the sweep stop early, which is conservative, and anything it skips is still collected when it is read.

Renaming `delete` to `evict` outright was considered and rejected: that is a breaking interface change for the one live consumer that implements `SessionStore`, while dropping the call is not, since the interface itself does not change.

## Compatibility

- `evict` is optional, so no existing implementation breaks; `InMemorySessionStore` implements it, where eviction and erasure coincide because it is only a cache ([validated by: logs a rejecting evict rather than dropping it](../../src/transport/ws/connectionHandler.test.ts#L192)).
- The behaviour change is real rather than typed: a consumer relying on the store being emptied on close restores it with the one-line `onDisconnect` above, so the bump is MINOR with the note in the release notes ([validated by: is called with the session id while the store still holds the session](../../src/transport/ws/connectionHandler.test.ts#L135)).

## Out of scope

The retention period itself, which is a deployment's decision; bounding and redacting what a session keeps (re-cinq/Otto#89); resuming a conversation from a session id (re-cinq/Otto#103); the Mongo-backed store and its erasure methods (re-cinq/HALEngine#92); a session-count cap or LRU eviction, since age is the only policy here; and the two other paths that end conversations with no customer action — a missed heartbeat's `terminate()` and `stop()` closing every socket on shutdown.
