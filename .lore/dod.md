# Definition of Done

> Add an optional `save(session)` member to `SessionStore`, called by the
> engine exactly once per processed user message ... **A durable store the
> engine ships.** One implementation backed by MongoDB ... It keeps an
> in-process `Map` as its cache and the collection as its truth ... a
> subsequent `get` reloads the conversation from the collection.

**Strategy: `changes_requested` (blocked)** — the ticket bundles two
deliverables (a write signal + a durable Mongo store) across 13 acceptance
criteria, and the durable store cannot be built on the interface that is on
`main`. Two prerequisites the ticket itself declares "land first" are absent,
and one is actively enforced by a passing test. This parks for a human split.

## Why it is blocked

1. **#102 (widen `SessionStore` to `Awaitable`) is not on `main`.** The
   interface in `src/types/sessionStore.ts` is fully synchronous; no
   `Awaitable` type exists in `src/`. The Mongo store's headline behaviour —
   "`delete` evicts from the cache and a subsequent `get` reloads the
   conversation from the collection" — requires an async `get`, which the
   sync interface cannot express. The ticket's tech notes say #102 "lands
   first"; it has not.

2. **#117 (remove the engine's `delete` call on socket close) is not on
   `main`, and is enforced by a test.** `src/transport/ws/connectionHandler.ts:123`
   calls `deps.sessionStore.delete(sessionId)` on `close`, and
   `src/transport/ws/connectionHandler.test.ts:117` asserts it does. Without
   #117 a durable store is written then erased the moment the tab closes —
   the ticket flags this exact hazard.

3. **No MongoDB test harness exists.** No `mongodb` dependency, no
   `mongodb-memory-server`. AC "exercised against a real MongoDB in tests
   with no cloud account" needs test infrastructure this repo does not have.

4. **No session-store spec exists.** AC "The spec states plainly that this
   issue does not deliver conversation resume" implies a new spec under
   `specs/` that is not present.

## What is ready now (the honest split)

- **Deliverable A — the `save` write signal — is buildable today.** It needs
  none of the above: `save?(session): void | Promise<void>` is a new optional
  member, the seam is the orchestrator's `finally` path (`chatOrchestrator.ts:131`)
  plus config wiring, and `MockProvider` covers the streaming and rejecting
  cases. Its four ACs (save once per message with user+assistant entries; save
  once on provider rejection with the rejection still propagating; a rejecting
  `save` not failing the turn and logging one error line with the session id;
  a store without `save` behaving as today) fail for the ticket's stated reason.

- **Deliverable B — the durable Mongo store — waits on #102 and a harness.**
  Its ACs would fail because the async interface and the test infra are
  missing — reasons the ticket assumes are already resolved, not reasons it
  states. Writing B's tests now would be a red bar for a prerequisite, not for
  this ticket.

Committing only A's tests and reporting success would let a merged PR close
the whole issue — including "Give HAL Engine a durable session store", half
the title — without the store. That is the anti-pattern the DoD contract
names, so the ticket is parked rather than shrunk.

## What would unblock it

- Land #102 (Awaitable `SessionStore`) and #117 (drop `delete`-on-close,
  updating `connectionHandler.test.ts`) on `main`.
- Split into two tickets: (a) the `save` write signal, buildable now; (b) the
  durable Mongo store, once #102 is in and a MongoDB test harness
  (`mongodb-memory-server`) is added.
