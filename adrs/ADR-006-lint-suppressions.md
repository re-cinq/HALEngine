---
adr_number: 6
title: Four re-lint rules suppressed where they misread the domain
status: accepted
date: 2026-09-10
domains:
  - tooling
  - lint
  - ai-providers
  - transport
---

# ADR-006: Four re-lint rules suppressed where they misread the domain

This ADR records four inline suppressions of `@re-cinq/eslint-plugin-re-lint` rules, and why each is a mismatch between a good rule and this repo's domain rather than debt to be paid down. Every other finding the rules report stays reported: three of the four rules remain enabled and still fire elsewhere in the tree, and the suppressions are per-site with a reason attached, never a rule switched off repo-wide. The alternative in each case was to change working code in a direction that made it worse - a breaking public API change, an eagerly-loaded SDK, a lost type narrowing at a trust boundary, and a deleted regression pin. This decision is implemented.

## Context

`eslint.config.mjs` enables 31 of re-lint's 39 rules, several of which other adopters decline. Enabling them was deliberate: the instruction was to integrate every applicable linter and let it fail rather than refactor to suit it, so the backlog would be visible. Working through that backlog separates cleanly into findings whose fix improves the code and findings whose fix does not. These four are the second kind. They were identified while clearing the mechanical findings, each verified by reading the rule's own source or probing it, not inferred from the message text.

## Decision

Six sites carry `eslint-disable-next-line` (or, in one case, a file-level `eslint-disable`) with a `--` reason referring here, under the four decisions below. Together they account for every finding these three rules report: run with `--no-inline-config` and the count is three `no-flag-params`, two `prefer-polymorphism` and one `test-imports-its-subject`.

**`re-lint/no-flag-params` on `AIError`'s `retryable` parameter** (`src/types/ai.ts`). `AIError` is exported from `src/index.ts` and `retryable` is a `public readonly` constructor parameter, so it is part of the published API. The rule's remedy - split the function into two named functions - means two error classes or two factories, which is a breaking change for every consumer constructing an `AIError`. CLAUDE.md routes breaking changes through an issue, a migration guide, a MINOR bump and a deprecation period; a lint sweep is not that process.

The same constraint reaches every other site that constructs a retryable `AIError`, because `retryable` defaults to `false` and there is no other way to express one. Two carry the same suppression: `mapVertexError` in `src/providers/vertex/vertexProvider.ts`, which classifies a rate limit, and one call site in `src/transport/ws/messageHandler.test.ts`, which builds the error a handler is expected to surface. In both the rule's premise is false in the same way - the boolean is not selecting a behaviour, it is a field of a value.

Two further sites in `src/providers/vertex/vertexProvider.test.ts` carried this suppression until those tests stopped constructing an expected `AIError` at all. Asserting on the thrown error's `name`, `code` and `retryable` fields is both stricter and free of the literal: `expect(...).rejects.toThrow(new AIError(msg, code, true))` compares only the message, so it passed against a deliberately mis-classified error.

**`re-lint/prefer-polymorphism` on `createProvider`** (`src/providers/providerFactory.ts`). The five-way `switch` on `config.type` narrows a discriminated union onto five factories that take five different config types. A lookup table keyed by the string loses that narrowing: TypeScript cannot prove the selected arm's parameter matches the value being dispatched, so the table needs a cast at exactly the point the union was buying safety. This is the same premise as the `validateMessage` entry below, and it is not the premise this entry carried before the ESM conversion. Until then each arm `require`d its provider's module lazily and the suppression was justified as a loading boundary - but `src/index.ts` statically re-exports all five factories, so the factory's laziness never prevented a single module load. The boundary that does work lives inside each provider, around the vendor SDK, and stays there.

**`re-lint/prefer-polymorphism` on `validateMessage`** (`src/transport/ws/validation.ts`). The three-way `switch` on `message.type` narrows an untrusted WebSocket frame through a discriminated union, and TypeScript checks the arms against the union's members. A lookup keyed by string loses that narrowing at precisely the point where the input is attacker-controlled and the type is a claim rather than a fact. The `default` arm rejecting unknown types is the security behaviour, and exhaustiveness is what keeps it correct as message types are added.

**`re-lint/test-imports-its-subject` on the layering test** (`scripts/eslint-layers.test.ts`). The rule reports that the file loads no first-party module and so cannot fail when production code changes. It does exercise the real `eslint.config.mjs` - through `spawnSync`, because loading a flat config in-process needs `--experimental-vm-modules` - and the rule cannot see through a subprocess. The file exists because the layering gate's failure mode is silence: `no-cross-layer-import` keys packages by `<package>/src/`, so a misconfigured root matches nothing, reports nothing and looks adopted, which is exactly the state this repo was in until it was probed. Deleting or rewriting the test to satisfy the rule removes the only thing that would notice.

## Rationale

A suppression is honest when the rule's premise is false for the site, and dishonest when it is merely inconvenient. Each of these four fails the rule's premise: the "function" is a public constructor, the "dispatch" is a loading boundary, the "dispatch" is a type narrowing, and the "test that loads nothing real" loads the config under test in another process. In each case the rule's suggested remedy is a change that a reviewer would reject on its merits.

Per-site suppression with a written reason was preferred over disabling any rule repo-wide, because three of the four rules have genuine findings elsewhere that should keep failing. `no-flag-params` reports four other sites, `prefer-polymorphism` one, and both counts should fall.

## Consequences

- Six findings no longer appear across the four decisions; two of the three rules keep firing elsewhere.
- A future reader who removes a suppression sees the reason in the `--` clause before deciding.
- The suppressions are load-bearing in one direction: if `AIError` is ever redesigned through the breaking-change process, or the provider factory becomes async, the corresponding suppression should be reconsidered rather than carried forward.
- `re-lint/no-forwarding-class` remains enabled and inert for an unrelated reason - it needs type information this config does not provide - and is documented at its site in `eslint.config.mjs`, not here.

## Alternatives considered

**Refactor to satisfy each rule.** Rejected: a breaking API change outside the documented process, an eager-loading regression, a lost narrowing at a trust boundary, and a deleted anti-silence pin.

**Disable the three rules repo-wide.** Rejected: the suppressions are per-site and visible, and each names its reason. Turning the rules off would silence them for code not yet written, which is where their value is.

**Leave all four failing.** Rejected: a gate that reports findings nobody intends to act on trains readers to ignore it, and these four would never be acted on.

## References

- `eslint.config.mjs` — the enabled rule set and the `no-forwarding-class` inertness note
- `eslint.config.backlog.mjs` — `require-statement-links` at `warn`, held out of the blocking gate because `npm run eslint` runs `--max-warnings 0`
- [layers.yaml](../layers.yaml) — the layering the suppressed test pins
- [src/types/ai.ts](../src/types/ai.ts), [src/providers/providerFactory.ts](../src/providers/providerFactory.ts), [src/transport/ws/validation.ts](../src/transport/ws/validation.ts), [scripts/eslint-layers.test.ts](../scripts/eslint-layers.test.ts)
