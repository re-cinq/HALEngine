# Definition of Done

> `chatOrchestrator.ts` assigns `lastUsage = outcome.usage ?? lastUsage` on
> each round, so what the hook receives is the usage of the final provider
> call alone. [...] For a turn that called tools, it is the last leg of
> several, and the earlier rounds — including the one carrying the customer's
> question and the full tool results — are not counted anywhere.

**Strategy: `direct`** — the seam already exists. `afterModelResponse` takes a
`usage?: UsageMetadata`, the tool loop already runs multiple rounds, and the
test file's `scriptedProvider` drives one round per `sendMessage`, so a test can
script two rounds with known token counts and read what the hook receives. No
new module is needed; the fix is at the `lastUsage` local and the call site.

## Done when these pass

- [x] **sums the usage of every round, not only the last** — two tool rounds
      report `{10,5,15}` and `{20,7,27}`; the hook must receive the sum
      `{30,12,42}`. Fails today because only the last round's `{20,7,27}` survives.
      `src/orchestration/chatOrchestrator.test.ts`

- [x] **counts every reporting round even when a round between them reports
      none** — three rounds report `{10,5,15}`, nothing, `{1,2,3}`; the hook must
      receive `{11,7,18}`. Fails today (gets the last round's `{1,2,3}`) and pins
      that a silent round neither erases the earlier count nor turns the total to
      `NaN`.
      `src/orchestration/chatOrchestrator.test.ts`

## Facets

- [x] Red: two new tests above fail because usage is the last round, not the sum.
- [x] Green: accumulate usage across rounds at the `lastUsage` local; pass the
      sum to `afterModelResponse`.
- [x] Type: name/type the argument so a reader sees it is a sum without opening
      the orchestrator (acceptance criterion 4 — a review concern, not a test; no
      honest behavioural red bar exists for a type name).
- [x] Preserve (already green, must stay green): `receives collected response
text and usage` (no-tool turn reports its single round unchanged — acceptance
      criterion 2, existing test left unedited) and `keeps the usage an earlier
round reported when a later round reports none` (report-then-silent still
      yields the reported usage, and guards against `NaN` on the gap).
- [x] Docs (not acceptance tests): `specs/hal-engine-config-hooks/spec.md`
      under-counting line and the CHANGELOG entry — see Out of scope.

## Out of scope

- The audit/billing record itself, and token accounting for anything other than
  the provider calls the orchestrator makes.
- A "turn where nothing reported still reports nothing → `undefined`" red test:
  that is already the behaviour today (`undefined`), so no honest red bar exists;
  it is preserved by criterion, and a naive zero-accumulator regression to
  `{0,0,0}` would be a review catch, not a currently-failing test.
- `specs/hal-engine-config-hooks/spec.md`: the ticket says to replace its
  recorded under-counting line, but that spec does not exist on this branch (it
  lives in git history under HALEngine#83, never merged to `main`). On this
  branch the behaviour is recorded in `specs/hal-engine-architecture/spec.md`
  § Across rounds, where the two new statements were added and linked. The
  CHANGELOG line stating the behaviour change is the implementer's, not a test.
