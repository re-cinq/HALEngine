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

`count()` reports documents, not cache entries, so `delete` does not change it.

## Latest session

With resume's `latest` option on, every connect that names no session id asks `latestFor(userId)`
for the user's most recently active conversation. `MongoSessionStore` answers with the user's
document that has the newest `updatedAt`, which each `save` moves forward, so create this index
where the collection lives; the store creates none itself. `listFor` sorts on the same index, so
this one serves both and there is no second index to create:

<!-- doc-block: none -- a mongo shell command run against the deployment, not code the package ships -->
```js
db.hal_sessions.createIndex({userId: 1, updatedAt: -1});
```

`InMemorySessionStore` has no `save` to stamp, so it goes by a session's newest entry, or its
creation for a session with none, and never returns one that has aged out. A store you write
yourself can leave `latestFor` out, in which case such a connect simply starts a new session.

## Listing a user's conversations

`listFor(userId, options?)` is optional, and it answers summaries rather than sessions:
`sessionId`, `createdAt`, `updatedAt` and `entryCount`, most recent activity first. A summary
carries no entries and no `authHeaders`, so a conversation list cannot hand over a conversation or
a credential. Its first row is always the session `latestFor` returns — both read the same
activity, so a list and a resume cannot disagree about which conversation is newest.

`options.limit` defaults to 50 and is capped at 200, and `options.before` takes the conversations
older than a moment, so a client pages by passing back the `updatedAt` of the last row it saw. A
store whose database fails rejects rather than answering an empty list: what to show a user who may
have conversations is your decision, and "no conversations" is not a safe guess.

`MongoSessionStore` filters on the user in the query, sorts on the § Latest session index and
projects the entries away, so a page of summaries never carries a conversation out of the database.
It counts a conversation from an `entryCount` field each `save` writes beside the entries. A
document saved before 0.6 has no such field and lists as a conversation of no entries until you
backfill it:

<!-- doc-block: none -- a mongo shell command run against the deployment, not code the package ships -->
```js
db.hal_sessions.updateMany({entryCount: {$exists: false}}, [{$set: {entryCount: {$size: '$entries'}}}]);
```

`InMemorySessionStore` goes by a session's newest entry, or its creation for a session with none,
and never lists one that has aged out. A store you write yourself can leave `listFor` out, in which
case it has no conversation list to offer.

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
