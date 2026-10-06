# Session stores

A session store decides where a conversation lives and how long it survives. This page exists for
one reason: **which method erases, and which only evicts**, is not guessable from the names, and
getting it wrong either destroys a customer's history or fails to honour their erasure request.

## Erases or evicts

| Method | Cache | Durable storage |
|---|---|---|
| `delete(sessionId)` | evicts | **erases** — the consumer's erasure primitive; the engine never calls it |
| `clear()` | evicts everything | untouched |
| `evict(sessionId)` | evicts | **erases** — the engine's own call, for a session no client received |
| `eraseConversation(sessionId)` | evicts | **erases that document, permanently** |
| `eraseOlderThan(cutoff)` | evicts | **erases every document created before `cutoff`** |
| `eraseAll()` | evicts everything | **erases every document** |

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

## Retention

`eraseOlderThan(cutoff)` is a method you call. The engine ships no scheduler, because a
library-owned timer keeps your process alive; how often you call it, and what cutoff you pass, is
the retention decision, and it belongs to your deployment with a named person behind it.

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

`count()` reports documents, not cache entries, so `delete` does not change it. It counts **every**
user's, not one user's: it is an operational figure, and putting it in front of a user would both
misreport their history and disclose the size of everyone else's. There is no per-user count — see
§ Listing a user's conversations for what to do instead.

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
a credential. Its first row is the session `latestFor` returns, because both read the same activity,
so a list and a resume agree about which conversation is newest.

`options.limit` defaults to 50 and is capped at 200. `options.before` resumes after a row, so a
client pages by passing back the last summary it saw — `SessionCursor` is `{updatedAt, sessionId}`,
which a `SessionSummary` already satisfies, so `listFor(userId, {before: rows.at(-1)})` is the whole
of it. The session id is in the cursor because `updatedAt` alone is not unique: two conversations
saved in the same millisecond would straddle a page boundary and one of them would never be listed.
A `limit` of `0` answers nothing, and a limit that is not a usable number is read as none given.

A store whose database fails rejects rather than answering an empty list: what to show a user who
may have conversations is your decision, and "no conversations" is not a safe guess.

**Knowing whether another page exists.** `listFor` answers an array and no `hasMore`, so read it off
the page: a page shorter than the `limit` you asked for is the last one. A full page is ambiguous, so
either accept one final round-trip that comes back empty, or ask for one row more than you intend to
show — `{limit: pageSize + 1}`, display the first `pageSize`, and take the cursor from the last row
you displayed. The extra row's presence is your `hasMore`. Because the limit is capped at 200, that
trick works up to a `pageSize` of 199. Do not reach for `count()` for this: it counts every user's
conversations, not this user's, and there is no per-user total today.

`MongoSessionStore` filters on the user in the query, sorts `{updatedAt: -1, _id: -1}` and projects
the entries away, so a page of summaries never carries a conversation out of the database.

**Create the three-key index from § Latest session.** `{userId: 1, updatedAt: -1}` cannot satisfy a
two-key sort, so Mongo answers with a blocking sort over *every* conversation the user has and
applies the limit after it: measured on 300 conversations, a 50-row page examined all 300 documents,
where the three-key index made the same page a covered query examining none. Two consequences, not
just a slow query — paging a long history that way is quadratic, and a blocking sort is bounded by
Mongo's 100 MB sort limit, so a large enough history makes `listFor` fail rather than merely crawl.

It answers a `limit` of `0` without querying at all, because MongoDB reads `limit: 0` as *no* limit
and would otherwise hand back everything the filter matches. It counts a conversation from an
`entryCount` field each `save` writes beside the entries. A document saved before 0.6 has no such
field and lists as a conversation of no entries until you backfill it:

<!-- doc-block: none -- a mongo shell command run against the deployment, not code the package ships -->
```js
db.hal_sessions.updateMany({entryCount: {$exists: false}}, [{$set: {entryCount: {$size: '$entries'}}}]);
```

`InMemorySessionStore` goes by a session's newest entry, or its creation for a session with none,
and never lists one that has aged out. One divergence to know about, in that store only: where two
of a user's conversations are last active in the same millisecond, the list puts the larger session
id first while `latestFor` takes the one created later, so for tied conversations the head of the
list and the session a resume rejoins can differ. `MongoSessionStore` breaks that tie the same way
in both members, so the two agree there.

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
