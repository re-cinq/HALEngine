# Definition of Done

> `beforeSession` is awaited before the `try` block, so a throw from it
> escapes before the `catch` and `finally` exist. Neither `onError` nor
> `afterSession` runs.

**Strategy: `direct`** — the seam already exists. `createChatOrchestrator`
returns an orchestrator whose `processMessageStream` calls the installed
`OrchestratorHooks`. A test can install a `beforeSession` that throws, drive
`processMessage` through the real entry point, and observe that `onError` and
`afterSession` do not fire today. No new module is needed.

## Done when these pass

- [ ] **runs onError then afterSession when it throws, and still rejects to the caller** —
      a `beforeSession` that throws still rejects to the caller (unchanged), and now
      also runs `onError` with the thrown error and then `afterSession`. Fails today
      because both hooks are skipped: `onError` never fires (message `undefined`) and
      `callOrder` is `['beforeSession']`, not `['beforeSession', 'onError', 'afterSession']`.
      `src/orchestration/chatOrchestrator.test.ts`

## Facets

- [ ] Move the `beforeSession` call inside the `try` block in
      `src/orchestration/chatOrchestrator.ts` so a throw reaches the same `catch`
      (`onError`) and `finally` (`afterSession`) as any other turn failure.
- [ ] Confirm the non-throwing `beforeSession` path is unchanged — the existing
      hook tests (`called before anything else`, `full lifecycle order`) stay green
      without edits.
- [ ] Criterion 5, owned by the implementer: expand the new guarantee bullet in
      `specs/hal-engine-config-hooks/spec.md` with what a hook may assume about how
      much of the turn happened (how a cleanup hook tells "never allocated" from
      "allocated and finished" — the ticket asks this be decided and recorded), and
      add a CHANGELOG entry describing the behaviour change for an existing consumer.
      This DoD adds only the behavioural guarantee statement + its test citation.

## Out of scope

- The `instanceof Error` gate on `onError` (its own issue) — still recorded as a
  measured-semantics flaw in the spec.
- Usage accounting across tool rounds (HALEngine#93).
- The CHANGELOG entry and the "what a hook can assume" prose (implementer's, per
  acceptance criterion 5 — see Facets).
