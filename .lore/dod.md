# Definition of Done

> So the first message after an erasure writes the whole conversation back, every earlier entry included, with a fresh `createdAt`.

**Strategy: `direct`** — The acceptance tests can call the real entry points today and fail on behaviour.

## Done when these pass

- [ ] **create, eraseConversation, then save of the session a socket still holds: await store.count() is 0** — `src/transport/sessionErasure.acceptance.test.ts`
- [ ] **create with createdAt back-dated past a cutoff, eraseOlderThan(cutoff), then save of the held session: no document is written** — `src/transport/sessionErasure.acceptance.test.ts`
- [ ] **GDPR. Over a real socket: a turn, an erasure, a second turn, and the conversation stays erased** — `src/transport/sessionErasure.acceptance.test.ts`
- [ ] **POST /chats then POST /chats/:id/messages stores the chat in the session store, and after its erasure a further message writes nothing** — `src/transport/sessionErasure.acceptance.test.ts`
- [ ] **A live session created after the cutoff is the same object from get before and after eraseOlderThan** — `src/transport/sessionErasure.acceptance.test.ts`
- [ ] **An eraseOlderThan whose delete rejects leaves every cached session cached, asserted with a fake collection whose deleteMany rejects** — `src/transport/sessionErasure.acceptance.test.ts`
- [ ] **A get racing an erasure of the same id never leaves the erased session cached** — `src/transport/sessionErasure.acceptance.test.ts`

## Facets

- [ ] Make `MongoSessionStore.save` an update, never an insert: `updateOne(..., {upsert: false})`
- [ ] The REST router (`src/transport/routes/chats.ts`) calls `sessionStore.create` when it creates a chat
- [ ] Let a consumer tell that a save found nothing
- [ ] Have `eraseOlderThan` evict only what it erased
- [ ] Say in the store's doc-block that REST router's next message after an erasure writes nothing
- [ ] `CHANGELOG.md` carries an entry

## Out of scope

- Erasing a socket's in-flight turn, which completes from memory
- Telling an open socket that its conversation was erased
- The REST router's own `Map`, which stays demo-only
