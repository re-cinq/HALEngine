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

## Opt-in

- Resume is the optional `transport.resume` config, off by default; without it, a reconnect naming an earlier id gets a new id, a `connected` frame with exactly its four original fields, and no replay ([validated by: with resume absent, answers a reconnect naming the first id with a new id and no replay](../../src/transport/sessionResume.test.ts#L127)).
- With resume off, a socket opened at `{basePath}/ws/undefined` still completes the handshake and gets a server-minted id ([validated by: with resume off, still completes a handshake at /hal/ws/undefined and mints an id](../../src/transport/sessionResume.test.ts#L280)).

## Rejoining a conversation

- The owner reconnecting with the id from their first `connected` frame receives `resumed: true` and `entryCount` equal to the stored entries, followed by one `entry_upsert` per entry at its own index, equal to what is stored ([validated by: with resume on, answers the owner reconnecting with resumed true, entryCount 2 and both stored entries](../../src/transport/sessionResume.test.ts#L143)).
- A stored entry a tool suppressed is replayed as `entry_skip`, so the client sees the conversation it saw live and never the text a tool hid ([validated by: replays a suppressed entry as a skip, so the client never sees text a tool suppressed](../../src/transport/sessionResume.test.ts#L223)).
- For that, suppression is recorded on the stored entry: an assistant entry the client was sent and then shown blank is marked `suppressed`, and keeps its text for the model's history ([validated by: marks a sent assistant entry it blanked as suppressed in the session, keeping its text](../../src/transport/ws/messageHandler.test.ts#L240)).
- A segment opened after suppression, which the client was only ever sent as a skip, is marked `suppressed` too ([validated by: marks a segment opened after suppression as suppressed in the session](../../src/transport/ws/messageHandler.test.ts#L249)).
- A thinking entry the client kept seeing is left unmarked, matching what the live stream showed ([validated by: leaves a thinking entry the client kept seeing unmarked, and marks the blanked answer](../../src/transport/ws/messageHandler.test.ts#L258)).

## Ownership and existence

- An id is resumed only for the stored session's own user: another user naming it receives a fresh session and `resumed: false`, with frames identical in shape to the response for an id that was never issued, so the answer cannot be used to learn which ids exist ([validated by: answers another user naming the id exactly as it answers an id that was never issued](../../src/transport/sessionResume.test.ts#L160)).
- An id that was never issued receives `resumed: false`, no replay and no `error` frame ([validated by: answers a never-issued id with resumed false and no replay or error](../../src/transport/sessionResume.test.ts#L174)).
- A requested id is never adopted as the key of a new session, which would be session fixation: the store then holds one session, under the id the server minted ([validated by: never adopts a requested id as a key: one session, under the id the server minted](../../src/transport/sessionResume.test.ts#L186)).

## The store decides what is live

- Whether an id is resumable is the store's `get` answer alone: an id it returns a session for is resumed and one it returns nothing for starts fresh, and the connection handler holds no age rule of its own, so expiry stays the store's ([validated by: resumes the id its store knows and starts fresh for one it does not, with no age rule of its own](../../src/transport/sessionResume.test.ts#L208)).
- A resumed session whose socket closes before its replay is kept, never evicted: eviction erases, and it is reserved for a new session no client ever received ([validated by: keeps a resumed session whose socket closed before the replay, rather than evicting it](../../src/transport/sessionResume.test.ts#L246)).
- A socket closing under resume still calls `onDisconnect` with its session id ([validated by: still calls onDisconnect with the session id when a socket closes under resume](../../src/transport/sessionResume.test.ts#L199)).

## Compatibility

- `ConnectedMessage` gains only the optional `resumed` and `entryCount`, so a `connected` literal carrying neither still type-checks ([validated by: still types a connected frame literal that carries neither resume field](../../src/transport/sessionResume.test.ts#L288)).

## Out of scope

Telling an expired session from one that never existed (re-cinq/HALEngine#46); what `delete` means once a store is durable; a creation time on `ChatSession`; serializing concurrent messages within a resumed session (re-cinq/HALEngine#47); re-authorising a downstream credential on resume, since `authHeaders` are simply re-captured from the new upgrade request as they are for a new session; and the client-side reconnect experience.
