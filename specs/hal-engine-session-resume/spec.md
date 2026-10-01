# Session Resume

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#45 |
| Status | Implemented          |

A reconnect used to resume nothing: the server minted a fresh id on every connection and never read the store, so a user whose socket dropped mid-conversation got an empty session and their next question reached the model with no context. Resume lets a reconnect name the session it had and rejoin it. The obvious implementation is the dangerous one, since accepting any id off the upgrade request would turn it into a bearer token for someone else's conversation, so resume ships with an ownership check, opt-in. **GDPR.** Enabling resume keeps conversation content past disconnect: the consumer owns the retention bound, through the store's `maxAgeMs` and erasure methods and re-cinq/HALEngine#41, and an unbounded retained store is a retention breach, not a memory leak.

## Reading the requested id

- The id is the `sessionId` query parameter of the upgrade request, never a path segment, and only 1–128 characters of `[A-Za-z0-9_-]` count: an empty value, a longer one and a path-traversal value read as no id at all ([validated by: reads abc-123 from the query and nothing from a bare path, a path segment, an empty, a 129-character or a traversal value](../../src/transport/ws/helpers.test.ts#L6)).
- A 128-character id is the longest one read ([validated by: reads a 128-character id, the longest it accepts](../../src/transport/ws/helpers.test.ts#L24)).
- An upgrade outside `{basePath}/ws` carries no id ([validated by: reads nothing from an upgrade outside the base path](../../src/transport/ws/helpers.test.ts#L30)).
- Reading the id never throws: a target that is not a URL, such as `//`, or an empty one carries no id ([validated by: reads nothing, without throwing, from a target that is not a URL or is empty](../../src/transport/ws/helpers.test.ts#L34)).

## Opt-in

- Resume is the optional `transport.resume` config, off by default; without it, a reconnect naming an earlier id gets a new id, a `connected` frame with exactly its four original fields, and no replay ([validated by: with resume absent, answers a reconnect naming the first id with a new id and no replay](../../src/transport/sessionResume.test.ts#L178)).
- With resume off, a socket opened at `{basePath}/ws/undefined` still completes the handshake and gets a server-minted id ([validated by: with resume off, still completes a handshake at /hal/ws/undefined and mints an id](../../src/transport/sessionResume.test.ts#L409)).

## Rejoining a conversation

- The owner reconnecting with the id from their first `connected` frame receives `resumed: true` and `entryCount` equal to the stored entries, followed by one `entry_upsert` per entry at its own index, equal to what is stored ([validated by: with resume on, answers the owner reconnecting with resumed true, entryCount 2 and both stored entries](../../src/transport/sessionResume.test.ts#L194)).
- A resumed session takes the credentials of the socket that resumed it, and the socket it replaced closing afterwards leaves them alone, though that close still calls `onDisconnect`, since the hooks are per connection ([validated by: keeps the credentials of the socket that resumed a session when the socket it replaced closes](../../src/transport/sessionResume.test.ts#L259)).
- A session open on more than one socket carries the credentials of the newest; when that socket closes, it takes those of the newest one still open, so a tab left open keeps working, and they are cleared only when the last one closes ([validated by: gives a session back the credentials of a socket still open when the socket that resumed it closes](../../src/transport/sessionResume.test.ts#L278)).
- `onConnect` receives `{resumed}` as its second argument: `false` for the connection that started a session and `true` for each one that resumed it ([validated by: tells onConnect whether a connection started its session or resumed it](../../src/transport/sessionResume.test.ts#L298)).
- An entry still streaming when its session is resumed, because its turn is running on the socket that started it, is replayed with `isStreaming: false` and `truncated: true`, since its deltas and commit go to that socket and a client shown it streaming would wait for a commit that never comes, while the stored entry stays as the running turn leaves it ([validated by: replays an entry whose turn is still running as finished and truncated, leaving the stored entry as it is](../../src/transport/sessionResume.test.ts#L361)).
- A stored entry a tool suppressed is replayed as `entry_skip`, so the client sees the conversation it saw live and never the text a tool hid ([validated by: replays a suppressed entry as a skip, so the client never sees text a tool suppressed](../../src/transport/sessionResume.test.ts#L325)).
- For that, suppression is recorded on the stored entry: an assistant entry the client was sent and then shown blank is marked `suppressed`, and keeps its text for the model's history ([validated by: marks a sent assistant entry it blanked as suppressed in the session, keeping its text](../../src/transport/ws/messageHandler.test.ts#L241)).
- A segment opened after suppression, which the client was only ever sent as a skip, is marked `suppressed` too ([validated by: marks a segment opened after suppression as suppressed in the session](../../src/transport/ws/messageHandler.test.ts#L250)).
- An answer still open when suppression begins is first committed as streamed so far, then retracted and marked like any sent answer, and the text after it opens a new entry the client is only sent as a skip, so a replay leaves the client as blank as the live stream did ([validated by: commits and retracts an answer still open when suppression begins, and skips what follows as a new entry](../../src/transport/ws/messageHandler.test.ts#L271), [validated by: replays an answer suppressed while it was still open as skips, as blank as the live client was left](../../src/transport/sessionResume.test.ts#L348)).
- A thinking entry committed before suppression began is left unmarked, since the client kept seeing it, matching what the live stream showed ([validated by: leaves a thinking entry the client kept seeing unmarked, and marks the blanked answer](../../src/transport/ws/messageHandler.test.ts#L259)).
- A thought still open when suppression begins is committed as the client saw it and left unmarked, and its remaining text opens a new entry marked `suppressed` ([validated by: commits a thought still open when suppression begins as the client saw it, and skips what follows](../../src/transport/ws/messageHandler.test.ts#L292)).

## Ownership and existence

- An id is resumed only for the stored session's own user: another user naming it receives a fresh session and `resumed: false`, with frames identical in shape to the response for an id that was never issued, so the answer cannot be used to learn which ids exist ([validated by: answers another user naming the id exactly as it answers an id that was never issued](../../src/transport/sessionResume.test.ts#L211)).
- An id that was never issued receives `resumed: false`, no replay and no `error` frame ([validated by: answers a never-issued id with resumed false and no replay or error](../../src/transport/sessionResume.test.ts#L225)).
- A requested id is never adopted as the key of a new session, which would be session fixation: the store then holds one session, under the id the server minted ([validated by: never adopts a requested id as a key: one session, under the id the server minted](../../src/transport/sessionResume.test.ts#L237)).

## The store decides what is live

- Whether an id is resumable is the store's `get` answer: an id it returns a session for is resumed, and one it returns nothing for starts fresh ([validated by: resumes the id its store knows and starts fresh for one it does not](../../src/transport/sessionResume.test.ts#L310)).
- A resumed session whose socket closes before its replay is kept, never evicted: eviction erases, and it is reserved for a new session no client ever received ([validated by: keeps a resumed session whose socket closed before the replay, rather than evicting it](../../src/transport/sessionResume.test.ts#L375)).
- A socket closing under resume still calls `onDisconnect` with its session id ([validated by: still calls onDisconnect with the session id when a socket closes under resume](../../src/transport/sessionResume.test.ts#L250)).

## Continuing the latest session

- With `latest` on, a connect that names no `?sessionId=` rejoins the user's most recently active session, which the store's optional `latestFor(userId)` returns, with the same `resumed: true`, `entryCount`, replay and `onConnect` `{resumed: true}` as a named resume ([validated by: with latest on, rejoins the most recently active session of a user whose connect names none](../../src/transport/sessionResume.test.ts#L425)).
- It starts a new session for a user who has none, and for a connect that sends `?new=1`, which is how a client starts a new conversation on purpose while a latest one exists ([validated by: with latest on, starts a new session for a user with none, and on ?new=1 even when one exists](../../src/transport/sessionResume.test.ts#L442)).
- A connect that names an id rejoins that session, whichever is latest ([validated by: with latest on, still rejoins the session a connect names rather than the latest one](../../src/transport/sessionResume.test.ts#L457)).
- A session `latestFor` answers for another user is never rejoined, and a `latestFor` that throws or that the store does not implement starts a new session ([validated by: starts a new session when the store's latestFor answers another user's session, throws, or is absent](../../src/transport/sessionResume.test.ts#L469)).
- Without `latest`, a connect that names no id starts a new session, as before ([validated by: with resume on but latest off, starts a new session for a connect that names none](../../src/transport/sessionResume.test.ts#L493)).
- `?new=1` counts only when it is exactly `1`, and only on an upgrade inside `{basePath}/ws` ([validated by: reads exactly ?new=1 inside the base path as a request for a new session, and nothing else](../../src/transport/ws/helpers.test.ts#L40)).
- `InMemorySessionStore.latestFor` goes by a session's newest timed entry, so the conversation the user last wrote to beats one created later, and an entry with no time, such as a thought, counts for nothing ([validated by: returns the user's session with the newest entry, not the one created last, a thought counting for nothing](../../src/infrastructure/stores/inMemoryLatestSession.test.ts#L17)).
- A session with no entries counts from its creation, and of two created at the same moment the later one wins ([validated by: falls back to creation time for sessions with no entries, the one created later winning a tie](../../src/infrastructure/stores/inMemoryLatestSession.test.ts#L30)).
- It never returns a session that has aged out, nor one belonging to another user ([validated by: returns nothing for a user whose only session aged out, nor another user's live one](../../src/infrastructure/stores/inMemoryLatestSession.test.ts#L45)).
- It reads a conversation of any length, folding the entry times rather than spreading them into one call ([validated by: reads a conversation too long to spread into a function call](../../src/infrastructure/stores/inMemoryLatestSession.test.ts#L57)).
- `MongoSessionStore.latestFor` returns the user's conversation with the newest `updatedAt`, read through `get`, so a live one is the cached object its running turn writes to ([validated by: returns the user's session saved last, as the cached object while it is live](../../src/infrastructure/stores/mongo/mongoLatestSession.test.ts#L12)).
- It reads the collection when its cache is cold, so a second instance or a restarted process finds the same latest conversation ([validated by: finds the latest session in the collection when its cache is cold](../../src/infrastructure/stores/mongo/mongoLatestSession.test.ts#L32)).

## Compatibility

- `ConnectedMessage` gains only the optional `resumed` and `entryCount`, so a `connected` literal carrying neither still type-checks ([validated by: still types a connected frame literal that carries neither resume field](../../src/transport/sessionResume.test.ts#L417)).

## Out of scope

Telling an expired session from one that never existed (re-cinq/HALEngine#46); an age rule of the connection handler's own, since what is live is the store's `get` answer alone; what `delete` means once a store is durable; a creation time on `ChatSession`; serializing concurrent messages within a resumed session (re-cinq/HALEngine#47); the rest of a turn still running when its session is resumed, which keeps streaming to the socket that started it, so the model's next turn sees the whole answer the rejoining client saw cut off (abandoning that run when its socket closes is re-cinq/HALEngine#49); re-authorising a downstream credential on resume, since `authHeaders` are simply re-captured from the new upgrade request as they are for a new session; keeping two tabs on one session in sync live, since a reply streams to the tab that sent the message and the other sees it on its next connect; a list of a user's conversations to choose from; and the client-side reconnect experience.
