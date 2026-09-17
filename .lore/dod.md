# Definition of Done

> What is left is the part that makes the seam discoverable and pins its measured semantics,
> so that every hook-based issue in this epic — transparency disclosure, audit and usage
> recording, a human-oversight control, a provider-failover path — specifies against actual
> behaviour rather than against what the hook names suggest.

**Strategy: `characterize`** — the seam already ships. `HalEngineConfig.orchestrator.hooks`
is declared, `createHalEngine` forwards it, and the orchestrator awaits all seven hooks.
Every behavioural criterion in this ticket pins behaviour that is already present, and the
ticket forbids production code, so no honest acceptance test can be red. The deliverable is
therefore a committed green characterization bar plus the spec that cites it, which is exactly
what "pins its measured semantics" asks for. The remaining criteria (a doc comment on the
`hooks` field, the `.specify` and architecture-spec lines, the `example/server.ts` block) are
source/doc edits with no behavioural seam; CI's build/typecheck/lint judge them, and they are
left for the implementation round.

## Done when these pass

- [x] **processes a message when the config declares no orchestrator key at all** — an engine
  built with `orchestrator` absent still drives a full `processMessage`, proving the field is
  optional in fact and not only in the type.
  `src/config.test.ts`
- [x] **hands a config-installed beforeModelResponse hook the built base system prompt, not
  merely storing it** — a `beforeModelResponse` installed through `orchestrator.hooks` is
  invoked with the pipeline-built base prompt, proving the hook reaches the orchestrator.
  `src/config.test.ts`
- [x] **fires the lifecycle hooks in documented order for a session that completes without
  error** — the recorded order is
  `['beforeSession','beforeUserInput','afterUserInput','beforeModelResponse','afterModelResponse','afterSession']`.
  `src/config.test.ts`

All three pass now (green bar); see the run output in the delivery message.

## Facets

- [x] Three green config-level characterization tests appended to `src/config.test.ts` (one
  expect each, subject imported, deterministic — satisfies `re-lint/require-spec-link` and the
  test-file rules).
- [x] New spec `specs/hal-engine-config-hooks/spec.md` citing each new test, the existing
  forwarding test, and the three measured semantics against `chatOrchestrator.ts` source lines.
- [x] Implementation round: doc comment on the `hooks` field in `src/config.ts`; add "lifecycle
  hooks" to `.specify/spec.md` line 271; name `orchestrator.hooks` in
  `specs/hal-engine-architecture/spec.md`; add the bearer-token/verbatim-message retention lines
  there; add an `orchestrator.hooks` block with `afterModelResponse` to `example/server.ts`;
  MINOR bump; `no-changelog` label.

## Seam gap worth flagging

`HalEngineConfig.provider` accepts only a `ProviderConfig` (the five-way discriminated union),
and `createHalEngine` builds the provider internally via `createProvider`. There is no way to
inject a recording provider through config, so the criterion's "stub provider that records
`systemPrompt`" cannot observe the provider **through `createHalEngine`**. The config-level test
therefore asserts the hook receives the built base prompt (reach, not storage); the "returned
value replaces the system prompt the provider receives" half is cited in the spec to the
existing orchestrator test `chatOrchestrator.test.ts#L194`. If a future issue wants that
assertion end-to-end through config, it needs a provider-instance seam on `HalEngineConfig` —
out of scope here, which forbids production code.

## Out of scope

- The hook implementations themselves, fixing `onError`'s `instanceof Error` guard, moving
  `beforeSession` inside the `try`, forwarding `promptBuilderOptions`, wiring `createChatRoutes`
  to the injected `SessionStore`, and summing `UsageMetadata` across tool rounds — each a
  separate change this ticket only documents.
