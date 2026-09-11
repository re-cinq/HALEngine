# Sonar dial fixture

Invented content for tests/check-spec-links.test.ts. Nothing here describes a
real component, and every citation is placed where the trailing-parenthetical
rule wants it. The paths climb four levels because this fixture sits two
directories deeper than a real `specs/<slug>/spec.md`.

## Statements

- The dial reports one reading per sweep
  ([validated by](../../../../tests/check-at-pass.test.ts#L14)).
- The dial idles at zero between sweeps
  ([validated by](../../../../tests/check-at-pass.test.ts#L22)).

The sweep completes in under a second
([validated by](../../../../tests/check-at-pass.test.ts#L30)). The needle settles
without overshooting ([validated by](../../../../tests/check-at-pass.test.ts#L38)).

The gauge is repainted by ([the resize helper](../../../../scripts/check-spec-links.mjs#L3))
on every frame, which is a link to a script rather than to a test.

An inline `([validated by](../../../../tests/check-at-pass.test.ts#L46))` example is
prose about the convention, not a citation.
