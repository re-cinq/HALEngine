# Definition of Done

> Provider failures are already classified retryable or not (`AIError.retryable`
> in `src/types/ai.ts`; both shipped providers set it), but nothing in the engine
> reads the flag. [...] And there is no deadline at all — a provider that accepts
> a request and never streams a chunk hangs the session until the client gives up.

**Strategy: `direct`** — the seam is the `AIProvider` interface itself. The ticket
creates a new `src/providers/withRetry(provider, policy)` decorator at that boundary,
so the acceptance tests call the real entry point directly against hand-written
`AIProvider` fixtures (real objects, no mocking library). The module is entirely
absent today, so the suite fails to load; a temporary pass-through stub confirmed
each test then fails on its own behavioural assertion (see Validation below), not on
a typo or a missing fixture.

## Done when these pass

All eight live in `src/providers/withRetry.test.ts` and drive the real `withRetry`:

- [ ] **retries a retryable failure and streams the eventual success, calling the provider three times** — the central claim: a retryable `AIError` is now retried and the eventual output reaches the caller.
- [ ] **does not retry a non-retryable failure and propagates the same error unchanged** — the flag is read both ways: a non-retryable failure is attempted once and the exact instance/`code` propagates.
- [ ] **does not retry once the first chunk has been handed off, even on a retryable failure** — after the first chunk streams, the attempt is uninterruptible.
- [ ] **gives up after maxAttempts and throws an AIError carrying the last attempt code** — exhaustion surfaces an `AIError` (so `instanceof Error` holds) with the final attempt's `code`, ready for a failover path.
- [ ] **abandons an attempt whose first chunk never arrives, calls return on it, and retries** — `firstChunkTimeoutMs` deadline; a `finally` flag proves `iterator.return()` ran.
- [ ] **throws a TIMEOUT AIError without retrying when the stream stalls after its first chunk** — `idleChunkTimeoutMs` deadline surfaces code `TIMEOUT`, no retry.
- [ ] **backs off with full jitter, bounding attempt two to baseDelay and attempt three to twice it** — delays are read off `setTimeout`, not slept through; bounded `[0,500]`, `[0,1000]`, none over `maxDelayMs`.
- [ ] **retries generateStructured under the same attempt-and-backoff loop** — the second half of the `AIProvider` contract is wrapped too.

`src/providers/withRetry.test.ts`

## Facets

- [ ] Create `src/providers/withRetry.ts` exporting `withRetry` and `RetryPolicy` (all fields optional, defaulting `3 / 500 / 5000 / 30000 / 30000`); make tests 1, 4, 7 green first (retry loop), then 5a/5b (deadlines + `return()`), then 6 (jittered backoff), then 3 (after-first-chunk lock).
- [ ] Re-export `withRetry` and `RetryPolicy` from `src/index.ts`, no `any` in the signature.
- [ ] Add `resilience?: RetryPolicy` to `HalEngineConfig` and wrap the provider in `createHalEngine` between `createProvider` and `createChatOrchestrator` when present (see Out of scope for why this has no runtime RED test).
- [ ] Ensure the decorator's log lines carry only attempt number, `AIError.code` and delay — never message content, prompt, tool args or auth headers.
- [ ] `CHANGELOG.md` entry + MINOR version bump (`0.3.0` → `0.4.0`); note it in the PR body. CI's `check-changelog.sh` only fires once a non-test `src/` file lands, i.e. in the implementation round.
- [ ] Run `npm run spec:names -- --fix` from `origin/main` if the citation lines drift as the test file grows.

## Out of scope

- **`createHalEngine` wiring has no honest RED runtime test.** `createHalEngine` builds its provider from a `ProviderConfig` discriminated union (`createProvider`); there is no seam to inject a fail-then-succeed `AIProvider` through the public config, and the only shipped non-failing provider is `MockProvider`. A runtime test adding `resilience` to the config would pass today (an unknown key is ignored at runtime), so it cannot go red. The wiring is a one-line composition verified by the type addition + CI build; its behaviour is fully pinned by the eight `withRetry` tests. Widening the config to accept a pre-built provider is a separate seam this ticket does not own.
- Cancelling the underlying HTTP request of an abandoned attempt (tracked as *Carry a cancellation signal into the provider SDK*); the failover path itself; widening a provider's retryable classifier (Vertex's `429`/`RESOURCE_EXHAUSTED`-only match); inbound rate limiting; per-tool-call retry; summing usage across retried attempts.

## Validation

Committed state (no production code): the suite fails to load — `Could not locate
module ./withRetry.js` — because the decorator does not exist yet. Against a
throwaway pass-through stub (`withRetry = provider => provider`, deleted before
commit), `6 failed, 2 passed`: the six behaviour-forcing tests failed on their own
assertions/timeouts, and the two that a pass-through already satisfies (non-retryable
once; after-first-chunk lock) passed — proof the tests are well-formed and that the
retry/timeout/backoff behaviour is what turns them green.

Test count note: eight is above the "prefer three" guideline, but each pins a
distinct, independently-breakable invariant the ticket enumerates as its own
acceptance criterion, all belonging to one cohesive decorator. Splitting the
decorator across tickets would leave partial resilience and contradicts the epic's
tier-one design.
