# Session stores

A session store decides where a conversation lives and how long it survives. This page exists for
one reason: **which method erases, and which only evicts**, is not guessable from the names, and
getting it wrong either destroys a customer's history or fails to honour their erasure request.

## Erases or evicts

| Method | Cache | Durable storage |
|---|---|---|
| `delete(sessionId)` | evicts | untouched — a later `get` reloads it |
| `clear()` | evicts everything | untouched |
| `evict(sessionId)` | evicts | **erases** — only ever called for a session no client received |
| `eraseConversation(sessionId)` | evicts | **erases that document, permanently** |
| `eraseOlderThan(cutoff)` | evicts | **erases every document created before `cutoff`** |
| `eraseAll()` | evicts everything | **erases every document** |

`delete` is the interface's own member and the engine never calls it. It is yours, and a store may
implement it as a durable deletion if that is what you want it to mean — but `MongoSessionStore`
does not, because the engine's transport used to call it on every socket close.

`eraseConversation` is what an erasure request under GDPR Article 17 calls for.

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
