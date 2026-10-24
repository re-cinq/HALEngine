# Session stores

A session store decides where a conversation lives and how long it survives. This page exists for
one reason: **which method erases, and which only evicts**, is not guessable from the names, and
getting it wrong either destroys a customer's history or fails to honour their erasure request.

## Erases or evicts

| Method                         | Cache             | Durable storage                                                          |
| ------------------------------ | ----------------- | ------------------------------------------------------------------------ |
| `delete(sessionId)`            | evicts            | **erases** — the consumer's erasure primitive; the engine never calls it |
| `clear()`                      | evicts everything | untouched                                                                |
| `evict(sessionId)`             | evicts            | **erases** — the engine's own call, for a session no client received     |
| `eraseConversation(sessionId)` | evicts            | **erases that document, permanently**                                    |
| `eraseOlderThan(cutoff)`       | evicts            | **erases every document created before `cutoff`**                        |
| `eraseAll()`                   | evicts everything | **erases every document**                                                |

`delete` is the interface's own member and the engine never calls it, so `MongoSessionStore`
implements it as a durable deletion — the same thing `eraseConversation` does, reachable by a
consumer holding only the `SessionStore` interface. `eraseConversation` is what an erasure request
under GDPR Article 17 calls for; `delete` is its synonym.

**`clear` is not.** Its in-memory twin is a harmless cache reset, so a durable `clear` would be an
unguarded mass erasure reachable by a method name that gives no warning. `eraseAll` is the durable
wipe, and it says so.

**Read this before wiring `onDisconnect`.** Both `delete` and `evict` erase on this store, so the
one-line migration that restores the pre-0.4 close behaviour —
`onDisconnect: sessionId => store.delete(sessionId)` — destroys the conversation on every socket
close, a blip included. **Point `onDisconnect` at neither.** There is nothing to reclaim by hand:
the cache is bounded by `maxAgeMs` and drops stale entries on its own, without touching a
document. A conversation surviving its socket is the feature, not a leak.

## What is never persisted

`MongoSessionStore` strips `authHeaders`, `authorization`, `cookie` and `host` from what it writes,
at **any depth** — not just the top level, because `ToolEntry.toolInput` carries whatever the model
produced and a token can end up nested inside it. The exported `stripCredentialKeys` applies the
same rule, so a store you write yourself can make the same guarantee.

One consequence worth planning for: a conversation reloaded in a fresh process has no
`authHeaders`, so a tool that reads `ToolContext.authHeaders` sees nothing until the caller
re-authenticates. That is the correct trade-off — a bearer token stored beside a conversation
outlives the request it was issued for — and it matches what the transport does on socket close.

`ChatSession.user`, everything `auth.ws` returned for the newest open socket, is never persisted
either. It is connection-scoped: `MongoSessionStore` writes only the fields it lists, so `user`
never reaches a document and a session read back carries none, and the transport re-derives it
from the next upgrade. A store you write yourself must leave it out the same way, since it can
hold any claim your authenticator resolved, a role, an account id, or a token.

## Retention

`eraseOlderThan(cutoff)` is a method you call. The engine ships no scheduler, because a
library-owned timer keeps your process alive; how often you call it, and what cutoff you pass, is
the retention decision, and it belongs to your deployment with a named person behind it.

Two timestamps exist to enforce a retention period against: `ChatSession.createdAt`, written by
the store when it creates a session (never by the engine), and each entry's `timestamp`, written by
`src/orchestration/entryFactories.ts`. Both shipped stores set `createdAt`: `InMemorySessionStore`
at `create`, and `MongoSessionStore` from the creation time it writes to each document, so a session
read back from MongoDB carries the time it was first created. A `SessionStore` you implement is the
other producer of `createdAt`. Both are ISO 8601, and ISO 8601 values may arrive in different forms - `Z`-suffixed UTC
or a numeric offset such as `+01:00` - that parse to the same instant but sort differently as
strings, so parse before comparing. Both are optional on the types: a thinking entry stored before
0.9 has no `timestamp`, and a session has no `createdAt` when its store holds no creation time for
it. `MongoSessionStore` has written one to every document since 0.4.0, so its sessions carry
`createdAt` even when they were stored before 0.9.

**GDPR.** A creation time attached to an identified user's conversation is personal data like the
rest of the session, a retained metadata category of its own; the fields exist precisely so a
retention period can be enforced against them.

`InMemorySessionStore`'s `maxAgeMs` is **not** a retention policy. It is a memory bound so the
default store does not grow without limit, and it defaults to eight hours.

## Truth and cache

`MongoSessionStore` keeps an in-process cache because the orchestrator mutates a session in place
while a turn streams, so `get` has to return a stable object. That cache is bounded by `maxAgeMs`
(eight hours by default, as in `InMemorySessionStore`): a stale entry is dropped on read and swept
when another session is cached, and dropping one erases nothing, because the next `get` reloads it
from the collection. The collection is the truth: a
session saved by one store instance is readable by another built on the same collection. The cache
is not coherent across instances until a `save` — two processes serving the same conversation at
once is not something this store supports.

Erasure relies on reads seeing the writes before them. Each erasure withdraws the reads still
waiting on the collection once its delete resolves, so that none of them re-caches what was erased.
A `get` issued afterwards must therefore read from the primary. Build the store on a client or
collection whose read preference is `primary`, which is the driver's default: on `secondaryPreferred`
or `nearest`, a `get` can reach a secondary that has not yet applied the delete, and it then caches
and returns the erased conversation.

`eraseOlderThan` reads the ids older than the cutoff in pages of a thousand, sorted by `_id`, and
deletes each page by id, so no single command outgrows MongoDB's 16 MiB limit however large the
backlog. Each page leaves the cache as its delete completes. A page whose delete rejects still
leaves the cache, because a write-concern timeout can follow a delete the server applied. The sweep
then stops and the rejection reaches the caller. Pages already deleted stay deleted, and a later
sweep resumes with what is left.

The sweep reads only string ids, which are the only ids this store writes. A document another tool
put in the same collection under a numeric or ObjectId `_id` is left alone. Each page is read with
`hint: {_id: 1}`, so the sweep walks the `_id` index once from start to finish whatever other
indexes exist. That pass reads every document in the collection, not only the backlog, so it needs
no `createdAt` index, and adding one does not change the plan. A collection adapter that implements
no `find` cannot sweep at all, and `eraseOlderThan` rejects with `StoreCannotList` before deleting
anything.

`count()` reports documents, not cache entries, so `delete` does not change it. It counts **every**
user's, not one user's: it is an operational figure, and putting it in front of a user would both
misreport their history and disclose the size of everyone else's. `countFor(userId)` is the per-user
count, see § Listing a user's conversations; `count()` is never a user's own.

## Latest session

With resume's `latest` option on, every connect that names no session id asks `latestFor(userId)`
for the user's most recently active conversation. `MongoSessionStore` answers with the user's
document that has the newest `updatedAt`, which each `save` moves forward, so create this index
where the collection lives; the store creates none itself:

<!-- doc-block: none -- a mongo shell command run against the deployment, not code the package ships -->

```js
db.hal_sessions.createIndex({userId: 1, updatedAt: -1, _id: -1});
```

The trailing `_id` is there for `listFor`, which sorts on `{updatedAt: -1, _id: -1}`; `latestFor`
alone would be served by the first two keys. Create the three-key form and both members are served
— see § Listing a user's conversations for what the two-key form costs.

`InMemorySessionStore` has no `save` to stamp, so it goes by a session's newest entry, or its
creation for a session with none, and never returns one that has aged out. A store you write
yourself can leave `latestFor` out, in which case such a connect simply starts a new session.

## Listing a user's conversations

`listFor(userId, options?)` is optional, and it answers summaries rather than sessions:
`sessionId`, `createdAt`, `updatedAt` and `entryCount`, most recent activity first. A summary
carries no entries and no `authHeaders`, so a conversation list cannot hand over a conversation or
a credential; an optional `preview` is the one field that carries any of its text, and it is asked
for rather than volunteered — see **Labelling a row** below. Its first row is the session `latestFor`
returns, because both read the same activity, so a list and a resume agree about which conversation
is newest.

`options.limit` defaults to 50 and is capped at 200. `options.before` resumes after a row, so a
client pages by passing back the last summary it saw — `SessionCursor` is `{updatedAt, sessionId}`,
which a `SessionSummary` already satisfies, so `listFor(userId, {before: rows.at(-1)})` is the whole
of it. The session id is in the cursor because `updatedAt` alone is not unique: two conversations
saved in the same millisecond would straddle a page boundary and one of them would never be listed.
A `limit` of `0` answers nothing, and a limit that is not a usable number is read as none given.

A store whose database fails rejects rather than answering an empty list: what to show a user who
may have conversations is your decision, and "no conversations" is not a safe guess.

**Labelling a row.** `listFor(userId, {preview: true})` adds a `preview` to each summary: the
conversation's opening question, trimmed, with each run of internal whitespace replaced by one ASCII
space (a lone non-breaking or ideographic space included), and cut to 120 code
points with no ellipsis of its own — mark a cut however your client prefers, bearing in mind that the row
carries no cut flag: a label of 120 code points was almost certainly cut, but a cut one can come back
a little shorter where the cut stranded a space, so read the bound as a hint rather than a signal. It defaults to off,
and a summary from a list that did not ask for one carries no `preview` key at all. Only the first
entry is read, and only if it is the user's: a conversation opening with an entry the model wrote
is labelled with nothing rather than with that entry's words, which is what keeps a list from
showing text a tool deliberately suppressed. A conversation with no user entry carries no label. The
text is that entry's as stored, so if a `beforeUserInput` hook of yours rewrites a user message —
the hook's return value is written back to the entry — a label shows the rewritten text rather than
what was typed. Treat that as a caveat rather than a feature: do not reach for the hook to title a
conversation, because it overwrites what the user actually typed in the history the model reads and a
resume replays. The engine stores no title of its own yet; re-cinq/HALEngine#155 is where a field for
one you write yourself is being tracked.

A preview is conversation content, which a summary otherwise never carries, so treat it as personal
data: an opening question can hold a booking reference, an order number or somebody's name. That is
why it is off by default in both places — here, and again in `transport.history.preview` before the
engine will put one on the wire.

What it costs: on `InMemorySessionStore`, reading one entry per row of the page. On
`MongoSessionStore`, `{entries: {$slice: 1}}` on the projection, so the database returns the first
element of the array and not the rest — one entry per row leaves the collection, never a
conversation. Ask for no preview and no `entries` field is projected at all, so the cheap path
stays exactly as cheap as it was. The index from § Latest session serves both, since the extra
field is fetched from the document Mongo already reads for `createdAt` and `entryCount`.

**Knowing whether another page exists.** `listFor` answers an array and no `hasMore`, so read it off
the page: a page shorter than the `limit` you asked for is the last one. A full page is ambiguous, so
either accept one final round-trip that comes back empty, or ask for one row more than you intend to
show — `{limit: pageSize + 1}`, display the first `pageSize`, and take the cursor from the last row
you displayed. The extra row's presence is your `hasMore`. Because the limit is capped at 200, that
trick works up to a `pageSize` of 199. Do not reach for `count()` for this: it counts every user's
conversations, not this user's. `countFor(userId)` answers this user's total, on both shipped stores;
on MongoDB it is an index-only scan whose cost grows with the user's conversation count, cheap next to
reading documents, not cheap next to nothing, so a consumer labelling a sidebar on every connect
should know that. A per-user count is personal data about that user, and never the store-wide total.

`MongoSessionStore` filters on the user in the query, sorts `{updatedAt: -1, _id: -1}` and projects
the entries away, so a page of summaries never carries a conversation out of the database.

**Create the three-key index from § Latest session.** `{userId: 1, updatedAt: -1}` cannot satisfy a
two-key sort, so Mongo answers with a blocking sort over _every_ conversation the user has and
applies the limit after it: measured on 300 conversations, a 50-row page examined all 300 documents,
where the three-key index made the same page an indexed sort examining exactly the 50 it returns. The
index does not _cover_ the query — `createdAt` and `entryCount` are not in it, so Mongo still fetches
each row it answers with — and that is the point: with it, the work is the page; without it, the work
is the history, so paging a long history that way is quadratic. It crawls rather than fails: the sort
carries a limit, so Mongo bounds it to the page rather than materialising the history — measured, 400
conversations of 600 KB each still answered a 200-row page without hitting the 100 MB sort cap.

`latestFor` needs the same index for a second reason: since 0.6.0 it breaks its tie by `_id`, so it
sorts on the same two keys a list does. It asks two questions — which conversation is newest, and
then what that conversation holds — and only the first is sorted. That first query projects `_id`
alone, so the three-key index covers it and answers which one is newest examining no documents at
all; under the old two-key index it examines every conversation the user has to answer with one.
Either way the session itself is then read by `_id`, through the store's cache, which is one document
and no sort.

It answers a `limit` of `0` without querying at all, because MongoDB reads `limit: 0` as _no_ limit
and would otherwise hand back everything the filter matches. It counts a conversation from an
`entryCount` field each `save` writes beside the entries. A document saved before 0.6 has no such
field and lists as a conversation of no entries until you backfill it:

<!-- doc-block: none -- a mongo shell command run against the deployment, not code the package ships -->

```js
db.hal_sessions.updateMany({entryCount: {$exists: false}}, [{$set: {entryCount: {$size: '$entries'}}}]);
```

`InMemorySessionStore` goes by a session's newest entry, or its creation for a session with none,
and never lists one that has aged out. Where two of a user's conversations are last active in the
same millisecond, both stores put the larger session id first, in `listFor` and in `latestFor` alike,
so the head of the list is always the session a resume rejoins.

A store you write yourself can leave `listFor` out, in which case it has no conversation list to
offer. One built on an injected collection needs that collection to implement `find`: without it,
`listFor` refuses rather than reporting that the user has no conversations.

**GDPR.** A summary is personal data: it shows that a user held a conversation, and when. It
carries no message content, and the user's id is part of the query rather than a filter applied
afterwards, so a list can only ever be one user's. How far back the list reaches is the retention
decision, and it is yours — see § Retention.

## Lookup

`lookup(sessionId)` is optional. It answers one of three things: `{status: 'active', session}`,
`{status: 'expired', userId}`, which carries the owner's id so ownership can be checked and never
the conversation, or `{status: 'missing'}`. `missing` is always a permitted answer, and leaving
`lookup` out behaves exactly as before: resume reads `get`, and a failed resume reads `unknown`.

`lookup` reports a lifetime decision rather than making one: `maxAgeMs` is a memory bound, not a
retention period, and a tombstone index of ids a store no longer holds is rejected, so an expired
session is reported once and then forgotten. `InMemorySessionStore` implements it that way.
`MongoSessionStore` does not implement it: its documents do not expire, and one that
`eraseOlderThan` removed reads `unknown`.

## Data retention statement

This section names every personal-data category the engine holds, where it is held, what bounds it, and what the erasure path is. It is written for a deployer with a data-protection obligation.

### Conversation entries

**Held in:** `ChatSession.entries` — in memory for the session's life; persisted to durable storage by the session store after each turn.

**Default retention:** When `transport.resume` is absent or disabled, `connectionHandler.ts` calls `store.evict(sessionId)` on socket close — the socket lifetime is the retention period by default, and no configuration is required to achieve it.

**With resume enabled:** A conversation outlives its socket. The deployer owns the retention bound. Set `InMemorySessionStore.maxAgeMs` for a memory-eviction limit (not a data-retention policy), or call `MongoSessionStore.eraseOlderThan(cutoff)` on a schedule.

**Content bound:** `history.maxContentEntries` on `HalEngineConfig` clears the content of older entries in place, never removing array elements. No content bound is configured by default.

**Erasure:** `SessionStore.delete(sessionId)` is the consumer's erasure primitive — the method to call for a GDPR Article 17 request. The engine never calls it on its own. Implementations must erase from durable storage, not only from cache.

### Tool inputs

**Held in:** `ToolEntry.toolInput` inside `ChatSession.entries` alongside the conversation.

**Bounds:** `history.redactEntry` on `HalEngineConfig` rewrites a `ToolEntry` before it is stored; a policy returning `{...entry, toolInput: {}}` leaves no arguments in the stored session. No redaction is configured by default.

**Erasure:** Same path as conversation entries — `SessionStore.delete(sessionId)`.

### Session credentials (`authHeaders`)

**Held in:** `ChatSession.authHeaders` — in memory only, for the socket's life. A bearer token stored beside a conversation outlives the request it was issued for; implementations must not write `authHeaders` to durable storage. `MongoSessionStore` enforces this by stripping credential keys at every depth before writing.

**Retention period:** Request lifetime. No configuration needed; the field is never written to disk.

### Connection-scoped user claims (`session.user`)

**Held in:** `ChatSession.user` — in memory only for the socket's life. Never persisted by either shipped store.

**Retention period:** Socket lifetime. No configuration needed.

### Session metadata (`sessionId`, `userId`, `createdAt`)

**Held in:** The session store, alongside conversation entries.

**Erasure:** `SessionStore.delete(sessionId)` removes the session and its metadata together.

### REST chat routes

The REST chat routes (`createChatRoutes`) keep a router-local map separate from the injected session store. They are documented as demo-only; a production deployment that must honour erasure requests must not rely on those routes as its conversation store.

## Driver versions

`MongoSessionStore` runs on `mongodb` 6.10 or later and on 7.x; install whichever your application
already uses, and pass its `MongoClient` or collection as it is, with no cast. Driver 7 needs Node
20.19 or later, which this package's own Node 22 floor already covers. One driver 7 change reaches
the URL you pass: `MONGODB-AWS` no longer takes credentials in the connection string, and needs
`@aws-sdk/credential-providers` installed to resolve them instead.
