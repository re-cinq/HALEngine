# Session stores

A session store decides where a conversation lives and how long it survives. This page exists for
one reason: **which method erases, and which only evicts**, is not guessable from the names, and
getting it wrong either destroys a customer's history or fails to honour their erasure request.

## Erases or evicts

| Method | Cache | Durable storage |
|---|---|---|
| `delete(sessionId)` | evicts | **erases** — the consumer's erasure primitive; the engine never calls it |
| `clear()` | evicts everything | untouched |
| `evict(sessionId)` | evicts | **erases** — only ever called for a session no client received |
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

**Read this before wiring `onDisconnect`.** Because `delete` erases here, the one-line migration
that restores the pre-0.4 close behaviour — `onDisconnect: sessionId => store.delete(sessionId)` —
destroys the conversation on every socket close when it is pointed at this store. Use `evict` if
you want the old memory behaviour without the erasure.

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
while a turn streams, so `get` has to return a stable object. The collection is the truth: a
session saved by one store instance is readable by another built on the same collection. The cache
is not coherent across instances until a `save` — two processes serving the same conversation at
once is not something this store supports.

`count()` reports documents, not cache entries, so `delete` does not change it.
