# Counting a User's Conversations

| Field  | Value                 |
| ------ | --------------------- |
| Issue  | re-cinq/HALEngine#143 |
| Status | Complete              |

`SessionStore` lets consumers page through a user's conversations with `listFor`, but until now offered no way to count them without walking every page. `countFor` closes that gap as an optional member, keeping the interface backward-compatible: a store literal implementing only the five original members still satisfies the interface, and a consumer who cannot count cheaply is not forced to pretend otherwise.

## Counting a user's conversations

`countFor(userId)` is an optional member of `SessionStore` that returns how many conversations that user holds. It is optional for the same reason `listFor` and `latestFor` are: a consumer's own store keeps compiling without it. Counting is not free — on MongoDB it is an index-only scan whose cost grows with the user's conversation count; it is cheap next to reading documents, not cheap next to nothing.

- `InMemorySessionStore.countFor` counts each user's own conversations, answers `0` for a user with none, and leaves `count()` — the store-wide total — unchanged ([validated by: counts each user's own conversations and answers 0 for a user with none, while count() stays global](../../src/infrastructure/stores/inMemorySessionCountFor.test.ts#L7)).
- A session past `maxAgeMs` is excluded from the count, so the number matches only live sessions and agrees with `listFor` on which conversations belong to the user — an aged-out session is counted by neither ([validated by: does not count a conversation that has aged out](../../src/infrastructure/stores/inMemorySessionCountFor.test.ts#L21)).
- `MongoSessionStore.countFor` issues one `countDocuments` call whose filter is `{userId}`, not an empty filter, and passes through whatever it answers ([validated by: calls countDocuments with {userId} as the filter, not an empty filter, and returns what it answers](../../src/infrastructure/stores/mongo/mongoCountFor.test.ts#L21)).
- A `countDocuments` rejection propagates to the caller rather than resolving to `0` — a wrong count of zero reads as "no history" in exactly the place this number gets rendered ([validated by: surfaces a countDocuments rejection to the caller rather than answering 0](../../src/infrastructure/stores/mongo/mongoCountFor.test.ts#L37)).
- `countFor` counts documents rather than cache entries, so a store built on a collection another instance wrote to answers that collection's true count ([validated by: counts documents in the collection, not cache entries — a second store instance sees the right total](../../src/infrastructure/stores/mongo/mongoCountFor.test.ts#L51)).
- **GDPR.** A per-user count is personal data about that user: it confirms the user holds a history on this system. `countFor` answers one user's count and never the store's total. `count()` is an operational figure — total conversations across all users — and must not be shown to an individual user as their own count ([validated by: counts each user's own conversations and answers 0 for a user with none, while count() stays global](../../src/infrastructure/stores/inMemorySessionCountFor.test.ts#L7)).

## Out of scope

`hasMore` on the return value of `listFor` (derivable today by a short page or over-fetch); a total across all users beyond the existing `count()`; caching or approximating the count (`estimatedDocumentCount` is collection-wide and cannot be filtered); and counting anything other than conversations.
