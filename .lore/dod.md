# Definition of Done

> What no consumer can get is **how many conversations this user has**. `SessionStore.count()` is not it: both shipped stores count every document in the store (`this.sessions.size`, and `countDocuments()` with no filter), so a consumer reaching for it to label a sidebar would both misreport that user's history and put the size of everyone else's on their screen.

**Strategy: `direct`** — `InMemorySessionStore` and `MongoSessionStore` are the real entry points; calling `countFor` on either fails today with `TypeError: store.countFor is not a function` because the method does not exist yet on either class or the `SessionStore` interface.

## Done when these pass

- [x] **counts each user's own and answers 0 for none, count() stays global** — `InMemorySessionStore.countFor` returns the right per-user total and does not include other users'; a user with no sessions gets 0; `count()` still returns the store-wide total
  `src/infrastructure/stores/inMemorySessionCountFor.test.ts`

- [x] **does not count an aged-out conversation** — a session past `maxAgeMs` is excluded from `countFor`, so the number matches only live sessions
  `src/infrastructure/stores/inMemorySessionCountFor.test.ts`

- [x] **calls countDocuments with {userId} filter** — `MongoSessionStore.countFor('u1')` issues exactly one `countDocuments({userId: 'u1'})` on the collection, not an empty filter; the return value is passed through
  `src/infrastructure/stores/mongo/mongoCountFor.test.ts`

- [x] **surfaces a countDocuments rejection** — a `countDocuments` that rejects propagates to the caller rather than resolving to 0
  `src/infrastructure/stores/mongo/mongoCountFor.test.ts`

- [x] **counts documents not cache entries (second instance)** — a `MongoSessionStore` with an empty cache built on the same collection as the writer answers the correct per-user and global count
  `src/infrastructure/stores/mongo/mongoCountFor.test.ts`

## Facets

- [x] Add `countFor?(userId: string | number): Awaitable<number>` to `SessionStore` in `src/types/sessionStore.ts` (optional, beside `listFor` once #143 lands)
- [x] Add `countFor` to `InMemorySessionStore` using the same `ownedBy(userId)` filter as `listFor` (or equivalent: filter sessions by userId, exclude aged-out, return length)
- [x] Add `countFor` to `MongoSessionStore` calling `collection.countDocuments({userId})`
- [x] Add `§ Counting a user's conversations` to `specs/hal-engine-conversation-list/spec.md` (create spec if not yet created by #143); include GDPR note (per-user count is personal data; `count()` stays operational)
- [x] Update `docs/session-stores.md` § Listing a user's conversations and § Truth and cache per ticket
- [x] Add `## [Unreleased]` CHANGELOG entry; stamp new spec statements with validated-by citations; MINOR bump
- [ ] Verify `src/infrastructure/stores/` coverage stays at 100% (jest coverage threshold)

## Out of scope

- `hasMore` on the return value of `listFor` (derivable today by short page or over-fetch)
- A total across all users beyond the existing `count()`
- Caching or approximating the count (`estimatedDocumentCount` is collection-wide)
- `listFor` itself (that is #143)
- Any store other than `InMemorySessionStore` and `MongoSessionStore`
