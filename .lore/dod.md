# Definition of Done

> `ChatSession` has no title, `SessionSummary` has none, and the only lever that influences a label today is a `beforeUserInput` hook — whose return value is written back to the stored user entry, so using it to title a conversation means overwriting what the user actually typed, in the history the model reads and a resume replays. That is a workaround nobody should be pushed into, and it is the real gap this issue closes.

**Strategy: `direct`** — The session stores provide a direct seam to test the missing `setTitle` behaviour.

## Done when these pass

- [ ] **stores a title in InMemorySessionStore and returns it in listFor** — verifies that a title can be stored and retrieved for an in-memory session.
  `src/title.acceptance.test.ts`
- [ ] **stores a title in MongoSessionStore and returns it in listFor** — verifies that a title can be stored and retrieved for a MongoDB session.
  `src/title.acceptance.test.ts`

## Facets

- [ ] `ChatSession` and `SessionSummary` gain `title?: string`
- [ ] `SessionStore` gains an optional `setTitle?(sessionId, title)`
- [ ] `setTitle` implemented on `InMemorySessionStore` and `MongoSessionStore`
- [ ] `MongoSessionStore.listFor` reads the title without a second query
- [ ] The `conversation_list` frame carries `title` correctly
- [ ] A title survives a save and is removed upon erasure

## Out of scope

- generating a title inside the engine
- a client-sent frame that sets a title
- renaming through the WebSocket
- searching titles
