# Definition of Done

> Frame order matches code output

**Strategy: `mechanical`** — The ticket corrects the frame order in a documentation example. The existing fixture test pins the true output.

## Done when these pass

- [ ] **records thinkingThenTool as nine frames, the commit at index 1 after the upsert at index 2** — the existing test that pins the code output the spec must match
  `src/testing/frames.test.ts`

## Facets

- [x] Update the §8.1 code block in `specs/hal-engine-websocket-protocol/spec.md` to match the exact `recordedFrames.thinkingThenTool` output sequence.

## Out of scope

- programmatic testing of the markdown against the fixture, as tests asserting on source text are forbidden by the DoD contract.
