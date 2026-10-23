# Definition of Done

> Add missing documentation for chat routes.

**Strategy: `mechanical`** — The ticket asks for a doc correction in a file header, which is a small, fully-specified edit that owes no new permanent test.

## Done when these pass

- [ ] **chat routes tests** — Existing tests must stay green to prove no behaviour was broken.
      `src/transport/routes/chats.test.ts`

## Facets

- [x] Replace the multi-line file-head comments in `src/transport/routes/chats.ts` with a single-line comment stating that the store is unused by design, the `Map` is process-local, and a REST-created chat id is not a WebSocket session id.

## Out of scope

- Changing the implementation or signature of `createChatRoutes`.
- Adding new routes or changing how chats are stored.
