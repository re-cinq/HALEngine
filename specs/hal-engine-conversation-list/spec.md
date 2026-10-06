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

- Summaries come back most recent activity first ([validated by: answers newest activity first, headed by the very session latestFor returns](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L27)).
- The first summary is the session `latestFor` returns, because both read the same activity ([validated by: answers newest activity first, headed by the very session latestFor returns](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L27)).
- The order is total rather than merely sorted: two conversations last active in the same millisecond are ordered by session id, the larger first, which is what lets a page resume without dropping one of them ([validated by: keeps a conversation tied on activity rather than dropping it across a page boundary](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L144)).
- In `InMemorySessionStore` that tie-break is the list's alone: `latestFor` breaks the same tie by creation order, so for two tied conversations the head of the list and the session a resume rejoins can differ ([validated by: breaks a tie on activity by session id, where latestFor takes the session created later](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L42)).
- `MongoSessionStore` answers in order of `updatedAt`, which each `save` moves forward, and its first summary is the session its own `latestFor` returns ([validated by: answers the user's conversations newest saved first, headed by the one latestFor returns](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L31)).
- It breaks a tie by `_id` in both members, so there the head of the list is the session a resume rejoins even when every conversation shares an `updatedAt` ([validated by: heads the list with the session latestFor returns even when every conversation shares an updatedAt](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L161)).

## What a summary reports

- `InMemorySessionStore` reports the moment `create` was called, the newest entry time as the activity, and the conversation's entry count ([validated by: reports a creation time, the newest activity and the entry count of each conversation](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L53)).
- `MongoSessionStore` reports the document's `createdAt`, the `updatedAt` its last save wrote, and the counter written beside the entries ([validated by: reports the creation time, the last save and the entry count of each conversation](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L49)).
- That counter is what a save writes, so a list never reads a conversation to count one ([validated by: counts a conversation from the field a save writes beside the entries](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L95)).
- A document written before the counter existed reads as a conversation of no entries rather than failing the list, which is what the backlog documented in `docs/session-stores.md` is for ([validated by: reads a conversation saved before the counter existed as one of no entries, rather than failing](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L79)).

## Whose conversations

- A list holds only the asking user's conversations: another user's never appear, and a user with none gets an empty list ([validated by: omits a conversation that aged out and another user's, and answers nothing for a user with none](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L65)).
- `InMemorySessionStore` omits a conversation that has aged out, as `latestFor` does ([validated by: omits a conversation that aged out and another user's, and answers nothing for a user with none](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L65)).
- `MongoSessionStore` filters on the user in the database, sorts on `{updatedAt: -1, _id: -1}` — the `{userId: 1, updatedAt: -1}` index `latestFor` already needs serves its leading keys — and asks for a projection that leaves the entries behind ([validated by: asks the database to filter on the user, sort on the index with the id behind it, and never for the entries](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L108)).
- It answers from that projection alone, so a collection that never returns an entry still lists conversations — the conversation does not leave the database to be listed ([validated by: answers from a projection alone, so a collection that never returns entries still lists conversations](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L181)).

## Paging

- `limit` takes that many of the newest, and `before` resumes after a row, so a client pages by passing back the last summary it saw — `SessionCursor` is `updatedAt` and `sessionId`, which a `SessionSummary` already satisfies ([validated by: pages down the same order: a limit takes the newest, and before takes what is older than it](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L78)).
- Paging walks every conversation exactly once even when all of them share an activity time, because the cursor carries the session id the order breaks ties on: a tie cannot fall between two pages and be skipped ([validated by: keeps a conversation tied on activity rather than dropping it across a page boundary](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L144)).
- `MongoSessionStore` pages the same way ([validated by: pages with before and a limit, down the same newest-first order](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L62)).
- It walks a tie exactly once too, through the same cursor ([validated by: keeps a conversation tied on updatedAt rather than dropping it across a page boundary](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L127)).
- A list is at most 200 summaries however many are asked for, and 50 when none is asked for, so no caller can ask for an unbounded page ([validated by: answers at most two hundred conversations however many are asked for, and fifty when none is](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L94)).
- That limit bounds the rows answered, not the rows the database reads to answer them: on `MongoSessionStore` the work is bounded by the `{userId: 1, updatedAt: -1, _id: -1}` index `docs/session-stores.md` prescribes, and under the two-key form Mongo sorts the user's whole history before applying the limit ([validated by: needs the three-key index to answer without sorting the whole history, which the two-key form does not](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L192)).
- A fractional or negative limit is read as a count a caller can use rather than failing the list, since a slip in a limit is not a reason to deny a user their history ([validated by: reads a fractional or negative limit as a count a caller can use rather than failing the list](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L104)).
- A limit of `0` answers no conversations, and a limit that is not a usable number is read as none given at all ([validated by: answers nothing for a limit of none, and the default for a limit that is not a number](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L115)).
- `MongoSessionStore` answers a limit of `0` without querying, because MongoDB reads `limit: 0` as no limit at all and would otherwise answer with every conversation the filter matches ([validated by: answers a limit of none without asking the database, which reads a limit of zero as no limit at all](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L143)).

## A cursor the caller can actually hold

- A cursor's `updatedAt` may be a `Date`, an ISO string or an epoch number, so a summary that went through JSON on its way to a client and back still pages ([validated by: pages on a cursor that has been through JSON, and refuses one carrying no usable moment](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L126)).
- `MongoSessionStore` reads such a cursor as a date before it queries, since a string compares against no stored BSON date and would quietly match none of them ([validated by: pages on a cursor that has been through JSON, where a string would have matched no stored date](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L150)).
- A cursor carrying no usable moment is refused with an error naming it, rather than read as no cursor at all, which would answer the first page again and repeat rows a client has already shown ([validated by: pages on a cursor that has been through JSON, and refuses one carrying no usable moment](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L126)).

## A collection that cannot list

- `find` is optional on `CollectionLike`, so an adapter written before conversation lists existed still satisfies the port ([validated by: refuses to list on a collection that implements no find, rather than reporting no conversations](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L175)).
- A store built on a collection without it refuses to list, rather than reporting that the user has no conversations ([validated by: refuses to list on a collection that implements no find, rather than reporting no conversations](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L175)).

## When the store cannot answer

- A store whose collection fails rejects rather than answering a partial or empty list: what to show a user who may have conversations is the caller's decision, and an empty history is not a safe guess ([validated by: rejects rather than answering a partial list when the collection fails](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L218)).
