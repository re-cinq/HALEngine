# Definition of Done

> The orchestrator's `catch` gates `onError` on `error instanceof Error`. A
> rejection that is not an `Error` — a thrown string, a plain object, a value
> from a library that rejects with its own shape — bypasses `onError` entirely
> while still propagating to the caller.

**Strategy: `direct`** — the seam already exists. `createChatOrchestrator`
returns an orchestrator whose `processMessage` is the real entry point, and a
provider whose `sendMessage` rejects drives the `catch` at
`src/orchestration/chatOrchestrator.ts:126`. A provider that throws a non-Error
value is all that was missing; no new module or boundary is needed.

## Done when these pass

- [ ] **wraps a non-Error rejection in an Error whose cause is the original and
  still rejects the caller with the original** — a provider rejecting with a
  string, a plain object, and `undefined` each calls `onError` exactly once with
  an `Error` whose `cause` is the original value, while the caller still receives
  the original rejection unchanged. Covers acceptance criteria 1 and 2.
  `src/orchestration/chatOrchestrator.test.ts`

Criterion 3 (an `Error` rejection reaches `onError` as the same instance, not a
wrapper) is pinned by the existing `onError` tests remaining unedited — they
stay green and no new test is owed for it.

## Facets

- [ ] Red: the new test asserts `onErrorCallCount: 1` / `isError` / `causeIsOriginal`
  for string, object and undefined; today all three read `0` / `false` because
  `error instanceof Error` skips `onError`.
- [ ] Green: in the `catch`, when `hooks?.onError` is set, wrap a non-Error in
  `new Error(...)` with `{cause: error}` (leave an `Error` as-is) and call
  `onError`; keep `throw error` re-throwing the original value unchanged.
- [ ] Refactor: existing `onError` and lifecycle-order tests stay green unedited.
- [ ] Doc (implementer): CHANGELOG `[Unreleased]` entry saying what changes for
  an existing consumer — a hook typed against `Error` now fires for rejections it
  previously never saw; the caller-boundary value is unchanged. The spec
  guarantee bullet is already added and cites this test.

## Out of scope

- `beforeSession` escaping the `try` (its own issue, #94).
- Usage accounting across tool rounds (HALEngine#93).
- The re-thrown value at the caller boundary — it stays exactly what it is today.
