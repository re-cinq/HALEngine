# Conversation List

| Field  | Value                 |
| ------ | --------------------- |
| Issue  | re-cinq/HALEngine#143 |
| Status | Shipped               |

Resume gets a client back into one conversation: the id it names, or the user's most recently active one. Neither tells it which conversations exist, and every other member of `SessionStore` answers about a session the caller can already name, so a consumer wanting to offer a conversation list had to query the collection behind the engine's back, against a document shape and a key the engine owns. `listFor` answers the list instead, as summaries rather than sessions. **GDPR.** A summary is personal data — that a user held a conversation, and when — so it carries no conversation content, it is filtered to one user by the query rather than in application code afterwards, and the retention bound stays the consumer's, through the store's `maxAgeMs` and erasure methods and re-cinq/HALEngine#41.

## The summary

- A summary is `sessionId`, `createdAt`, `updatedAt` and `entryCount`, and nothing else: neither the conversation's entries nor its credentials, so a list can never hand over either, even for a session created with credentials ([validated by: carries only its four fields, so a list can never hand over a conversation or a credential](../../src/infrastructure/stores/sessionStoreListSignature.test.ts#L22)).
- `listFor` is optional, like `latestFor` and `lookup` before it: a store written against the five original members still satisfies the interface, and both shipped stores implement it ([validated by: leaves a store with only the five original members satisfying the interface beside both shipped ones](../../src/infrastructure/stores/sessionStoreListSignature.test.ts#L11)).

## The order a list answers in

- Summaries come back most recent activity first ([validated by: answers newest activity first, headed by the very session latestFor returns](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L27)).
- The first summary is the session `latestFor` returns, because both read the same activity ([validated by: answers newest activity first, headed by the very session latestFor returns](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L27)).
- The order is total rather than merely sorted: two conversations last active in the same millisecond are ordered by session id, the larger first, which is what lets a page resume without dropping one of them ([validated by: keeps a conversation tied on activity rather than dropping it across a page boundary](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L141)).
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
- Paging walks every conversation exactly once even when all of them share an activity time, because the cursor carries the session id the order breaks ties on: a tie cannot fall between two pages and be skipped ([validated by: keeps a conversation tied on activity rather than dropping it across a page boundary](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L141)).
- `MongoSessionStore` pages the same way ([validated by: pages with before and a limit, down the same newest-first order](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L62)).
- It walks a tie exactly once too, through the same cursor ([validated by: keeps a conversation tied on updatedAt rather than dropping it across a page boundary](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L127)).
- A list is at most 200 summaries however many are asked for, and 50 when none is asked for, so no caller can ask for an unbounded page ([validated by: answers at most two hundred conversations however many are asked for, and fifty when none is](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L94)).
- That limit bounds the rows answered, not the rows the database reads to answer them: on `MongoSessionStore` the work is bounded by the `{userId: 1, updatedAt: -1, _id: -1}` index `docs/session-stores.md` prescribes, and under the two-key form Mongo sorts the user's whole history before applying the limit ([validated by: needs the three-key index to answer without sorting the whole history, which the two-key form does not](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L192)).
- A fractional limit is floored rather than refused, since a slip in a limit is not a reason to deny a user their history ([validated by: floors a fractional limit, and reads a negative or unusable one as none given rather than as nothing](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L104)).
- A negative limit, and one that is not a usable number, are read as no limit given at all rather than as a limit of none: handing a user an empty history for a typo is the worse reading ([validated by: floors a fractional limit, and reads a negative or unusable one as none given rather than as nothing](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L104)).
- Only a limit of exactly `0` answers no conversations ([validated by: answers nothing only for a limit of exactly none](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L116)).
- `MongoSessionStore` answers a limit of `0` without querying, because MongoDB reads `limit: 0` as no limit at all and would otherwise answer with every conversation the filter matches ([validated by: answers a limit of none without asking the database, which reads a limit of zero as no limit at all](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L143)).

## The two shipped stores answer one order

- `InMemorySessionStore` and `MongoSessionStore` list the same conversations in the same order, so a consumer swapping one for the other sees the same conversation list ([validated by: answer the same order for conversations whose activity differs](../../src/infrastructure/stores/storeListAgreement.test.ts#L43)).
- They break a tie on activity the same way, by session id ([validated by: break a tie on activity the same way, by session id](../../src/infrastructure/stores/storeListAgreement.test.ts#L52)).
- They page identically through the documented call, `listFor(userId, {limit, before: rows.at(-1)})`, a page at a time until a page comes back empty ([validated by: page the same way through the documented call, two rows at a time from the last row seen](../../src/infrastructure/stores/storeListAgreement.test.ts#L61)).

## Asking for the list over the socket

- Serving a list is its own switch, `transport.history`, and not part of `transport.resume`: resume on with history off still refuses the frame. Rejoining hands a client back a conversation it was already in, while a list tells it what else the user has, and a deployer who agreed to the first did not thereby agree to the second ([validated by: refuses the frame with resume on but history off, since one switch is not the other](../../src/transport/conversationList.test.ts#L121)).
- With `history.enabled`, a `list_conversations` frame is answered with one `conversation_list` carrying the user's conversations newest activity first, each `createdAt` and `updatedAt` an ISO string rather than a `Date`, which is what survives the wire ([validated by: answers the user's conversations newest first, with both times as ISO strings](../../src/transport/conversationList.test.ts#L67)).
- The list is the connecting user's, taken from the connection: a frame carrying a `userId` of somebody else is answered with the caller's own conversations, and the store is asked for the caller's id ([validated by: answers the connecting user's own conversations even when the frame names another user](../../src/transport/conversationList.test.ts#L86)).
- `limit` and `before` reach the store as the frame sent them, so a client pages the socket the way a consumer pages the store ([validated by: carries a limit and a cursor through to the store as the frame sent them](../../src/transport/conversationList.test.ts#L97)).
- A client picks a conversation by reconnecting with `?sessionId=` from a row, which session resume already authorises and replays: there is no switch frame and no second replay path ([validated by: hands a client an id it can rejoin the conversation with](../../src/transport/conversationList.test.ts#L200)).
- A `list_conversations` sent while a turn is streaming is answered before that turn ends, because a history request is not a turn and waits on no lock ([validated by: answers a list while a turn is still streaming, rather than queueing behind it](../../src/transport/conversationList.test.ts#L179)).

## When the frame cannot be answered

- Without `transport.history`, the frame is answered with an `error` of code `UNSUPPORTED` and no list ([validated by: refuses the frame when conversation history is not turned on](../../src/transport/conversationList.test.ts#L109)).
- A store implementing no `listFor` is answered with the same code, never an empty list: a client cannot tell "no conversations" from "the server could not look", and a history view is the one place that difference matters ([validated by: refuses the frame when the store cannot list, rather than reporting no conversations](../../src/transport/conversationList.test.ts#L132)).
- A store that fails is answered `SERVER_ERROR` with none of the store's own words, the socket stays open, and the log carries the error's type rather than its message, since a driver's message can hold a connection string and its password ([validated by: answers a failing store with a server error, keeps the socket open, and logs no word the store said](../../src/transport/conversationList.test.ts#L144)).

- A store that rejects with something that is not an `Error` is logged by that value's type, so a driver throwing a string is still described ([validated by: reports the type of a rejection that is not an Error, rather than failing to describe it](../../src/transport/conversationList.test.ts#L166)).

## Reading the frame

- A `list_conversations` naming no window is accepted, and a field the frame does not define — a `userId`, for one — is dropped rather than forwarded ([validated by: accepts list_conversations with no window, and keeps no field the frame does not define](../../src/transport/ws/validation.test.ts#L23)).
- `limit` is accepted as a whole number from 1 to 200, the bound the store caps a page at ([validated by: accepts a whole-number limit inside the page bound and a cursor carrying both halves](../../src/transport/ws/validation.test.ts#L29)).
- Anything else is refused rather than clamped, since a limit of `0`, `201`, `1.5`, `'10'` or `NaN` is a client bug worth reporting ([validated by: refuses a limit that is not a whole number from one to two hundred](../../src/transport/ws/validation.test.ts#L37)).
- `before` is accepted only carrying both halves, an ISO `updatedAt` and a `sessionId` of the shape the upgrade reads one in: a cursor missing its id would page on a time alone and skip a conversation on a tie ([validated by: refuses a cursor missing either half, or carrying a time nothing can parse](../../src/transport/ws/validation.test.ts#L45)).
- The validator dispatches through a `Map`, so a frame whose `type` names an inherited member — `constructor`, `__proto__`, `toString` — is an unknown type rather than something that reaches it ([validated by: answers a frame naming an inherited member as an unknown type, rather than reaching it](../../src/transport/ws/validation.test.ts#L58)).

## A cursor the caller can actually hold

- A cursor's `updatedAt` may be a `Date`, an ISO string or an epoch number, so a summary that went through JSON on its way to a client and back still pages ([validated by: pages on a cursor that has been through JSON, and refuses one carrying no usable moment](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L123)).
- `MongoSessionStore` reads such a cursor as a date before it queries, since a string compares against no stored BSON date and would quietly match none of them ([validated by: pages on a cursor that has been through JSON, where a string would have matched no stored date](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L150)).
- A cursor carrying no usable moment is refused with an error naming it, rather than read as no cursor at all, which would answer the first page again and repeat rows a client has already shown ([validated by: pages on a cursor that has been through JSON, and refuses one carrying no usable moment](../../src/infrastructure/stores/inMemoryConversationList.test.ts#L123)).

## A collection that cannot list

- `find` is optional on `CollectionLike`, so an adapter written before conversation lists existed still satisfies the port ([validated by: refuses to list on a collection that implements no find, rather than reporting no conversations](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L175)).
- A store built on a collection without it refuses to list, rather than reporting that the user has no conversations ([validated by: refuses to list on a collection that implements no find, rather than reporting no conversations](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L175)).

## When the store cannot answer

- A store whose collection fails rejects rather than answering a partial or empty list: what to show a user who may have conversations is the caller's decision, and an empty history is not a safe guess ([validated by: rejects rather than answering a partial list when the collection fails](../../src/infrastructure/stores/mongo/mongoConversationList.test.ts#L225)).
