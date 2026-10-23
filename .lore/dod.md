# Definition of Done

> State which install path is supported

**Strategy: `mechanical`** — The ticket is a fully-specified documentation edit to README.md and AGENTS.md that requires no new behavioural tests. README.md already has the section, leaving only AGENTS.md to update.

## Done when these pass

- [ ] **check-doc-blocks** — existing doc-block tests that must stay green
  `scripts/check-doc-blocks.test.ts`

## Facets

- [ ] Add an Install section to AGENTS.md naming the registry specifier as the supported path and warning about the git specifier.

## Out of scope

- Changes to actual code or install scripts.