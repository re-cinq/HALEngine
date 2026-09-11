# Buoy beacon fixture

Invented content for tests/check-spec-links.test.ts. Nothing here describes a
real component, and every citation below sits somewhere the rule rejects. The
paths climb four levels because this fixture sits two directories deeper than a
real `specs/<slug>/spec.md`.

## Statements

- The beacon clamps its range ([validated by](../../../../tests/check-at-pass.test.ts#L14)) and
  redraws on resize ([validated by](../../../../tests/check-at-pass.test.ts#L22)), which is the
  whole of its contract.
- The beacon idles dark between pulses
  ([validated by](../../../../tests/check-at-pass.test.ts#L30)).

The lamp turns clockwise
([validated by](../../../../tests/check-at-pass.test.ts#L38)) once every minute. The lens
settles within a second ([validated by](../../../../tests/check-at-pass.test.ts#L46)).

The legend is repainted ([validated by](../../../../tests/check-at-pass.test.ts)) before the
frame ends.
