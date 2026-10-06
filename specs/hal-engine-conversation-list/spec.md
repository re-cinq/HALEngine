# Conversation List

| Field  | Value                 |
| ------ | --------------------- |
| Issue  | re-cinq/HALEngine#143 |
| Status | Implemented           |

Resume gets a client back into one conversation: the id it names, or the user's most recently active one. Neither tells it which conversations exist, and every other member of `SessionStore` answers about a session the caller can already name, so a consumer wanting to offer a conversation list had to query the collection behind the engine's back, against a document shape and a key the engine owns. `listFor` answers the list instead, as summaries rather than sessions. **GDPR.** A summary is personal data — that a user held a conversation, and when — so it carries no conversation content, it is filtered to one user by the query rather than in application code afterwards, and the retention bound stays the consumer's, through the store's `maxAgeMs` and erasure methods and re-cinq/HALEngine#41.

## The summary

- A summary is `sessionId`, `createdAt`, `updatedAt` and `entryCount`, and the type carries neither the conversation's entries nor its credentials, so a list can never hand over either ([validated by: carries no entries and no credentials, so a list can never hand over a conversation](../../src/infrastructure/stores/sessionStoreListSignature.test.ts#L22)).
- `listFor` is optional, like `latestFor` and `lookup` before it: a store written against the five original members still satisfies the interface, and both shipped stores implement it ([validated by: leaves a store with only the five original members satisfying the interface beside both shipped ones](../../src/infrastructure/stores/sessionStoreListSignature.test.ts#L11)).

## The order a list answers in

- Summaries come back most recent activity first ([validated by: answers newest activity first, headed by the very session latestFor returns](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L17)).
- The first summary is always the session `latestFor` returns, because both read the same activity: a list and the latest session cannot disagree about which conversation is newest ([validated by: answers newest activity first, headed by the very session latestFor returns](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L17)).
- They agree on a tie too, where the session created later wins ([validated by: heads the list with the same tie-break latestFor applies, the session created later winning](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L32)).
- `MongoSessionStore` answers in order of `updatedAt`, which each `save` moves forward, and its first summary is the session its own `latestFor` returns ([validated by: answers the user's conversations newest saved first, headed by the one latestFor returns](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L34)).

## What a summary reports

- `InMemorySessionStore` reports the moment `create` was called, the newest entry time as the activity, and the conversation's entry count ([validated by: reports a creation time, the newest activity and the entry count of each conversation](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L43)).
- `MongoSessionStore` reports the document's `createdAt`, the `updatedAt` its last save wrote, and the counter written beside the entries ([validated by: reports the creation time, the last save and the entry count of each conversation](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L52)).
- That counter is what a save writes, so a list never reads a conversation to count one ([validated by: counts a conversation from the field a save writes beside the entries](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L98)).
- A document written before the counter existed reads as a conversation of no entries rather than failing the list, which is what the backlog documented in `docs/session-stores.md` is for ([validated by: reads a conversation saved before the counter existed as one of no entries, rather than failing](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L82)).

## Whose conversations

- A list holds only the asking user's conversations: another user's never appear, and a user with none gets an empty list ([validated by: omits a conversation that aged out and another user's, and answers nothing for a user with none](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L55)).
- `InMemorySessionStore` omits a conversation that has aged out, as `latestFor` does ([validated by: omits a conversation that aged out and another user's, and answers nothing for a user with none](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L55)).
- `MongoSessionStore` filters on the user in the database and sorts on `{userId: 1, updatedAt: -1}`, the index `latestFor` already needs, and asks for a projection that leaves the entries behind ([validated by: asks the database to filter on the user and sort on the resume index, and never for the entries](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L111)).
- It answers from that projection alone, so a collection that never returns an entry still lists conversations — the conversation does not leave the database to be listed ([validated by: answers from a projection alone, so a collection that never returns entries still lists conversations](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L126)).

## Paging

- `limit` takes that many of the newest, and `before` takes the conversations older than a moment, so a client pages by passing back the `updatedAt` it last saw ([validated by: pages down the same order: a limit takes the newest, and before takes what is older than it](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L68)).
- `MongoSessionStore` pages the same way ([validated by: pages with before and a limit, down the same newest-first order](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L65)).
- A list is at most 200 summaries however many are asked for, and 50 when none is asked for, so no caller can ask for an unbounded scan ([validated by: answers at most two hundred conversations however many are asked for, and fifty when none is](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L84)).
- A fractional or non-positive limit is read as a count a caller can use rather than failing the list, since a slip in a limit is not a reason to deny a user their history ([validated by: reads a limit of none and a fractional one as a count a caller can use rather than failing the list](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L94)).

## When the store cannot answer

- A store whose collection fails rejects rather than answering a partial or empty list: what to show a user who may have conversations is the caller's decision, and an empty history is not a safe guess ([validated by: rejects rather than answering a partial list when the collection fails](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L137)).
