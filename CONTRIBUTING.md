# Contributing

Thanks for looking. This file is the short version: what to run, what will fail, and the handful of conventions that are enforced rather than encouraged. Where a rule already lives somewhere else, this links to it instead of copying it — a second copy of a rule is a second thing to keep true.

`AGENTS.md` is the long version and the authority for everything below. `CLAUDE.md` is the architectural orientation.

## Before you open a pull request

```bash
npm ci
npm run verify
```

That is the blocking set CI's `verify` job runs, in the same order. It is not a copy of that list — `scripts/verify-script.test.ts` compares the two and fails if they drift, so following this cannot leave you red on something nobody told you about. Two of that job's steps are missing from it, both because they diff against `origin/main` and neither behaves the same on a checkout: the spec anchor check and the changelog check.

Two further CI jobs are worth running locally when you have touched packaging or dependencies: `npm run check:build-chain` and `npm run smoke`.

`npm run eslint` is `--max-warnings 0`. A warning fails the build, including an `eslint-disable` directive that has stopped suppressing anything.

## What will fail, and why

**Layering.** `src/` is five layers — types → providers → infrastructure → orchestration → transport — declared in `layers.yaml` and enforced by `re-lint/no-cross-layer-import`. A shortcut across them fails lint rather than review, so you find out in seconds instead of in a comment thread.

**Comment length.** A comment may span one line. `re-lint/max-comment-lines` does not exempt JSDoc, and consecutive `//` lines count as one comment. Anything longer belongs in `specs/`, `adrs/` or `docs/`, where it is searchable and linked. Tooling directives are exempt, and an `eslint-disable` may carry its reason after `--`.

**Test traceability.** `re-lint/require-spec-link` wants every test to be cited from a spec or ADR, as `([validated by](path/to/test.ts#L12))` in the statement it validates. A test that validates nothing a spec claims is asking whether it belongs in the traceable suite.

**Documented code blocks.** Every fenced `typescript` block in the ten documents `scripts/check-doc-blocks.mjs` covers (spikes are covered separately: their blocks are opted out wholesale, and one that names a source is reported) carries a marker naming where it comes from — an exported declaration, or a `#region` in a compiled file under `example/`. Run `npm run docs:fix` to regenerate, and read the diff: it will happily delete an annotation the type cannot express. A block that genuinely cannot be generated carries `none -- reason`, and an empty reason fails.

**Changelog.** A pull request that touches non-test files under `src/` must also touch `CHANGELOG.md`. Entries are written for somebody installing the package, not for somebody reading the commit log. The `no-changelog` label is the escape hatch for a change nothing installable can observe, and applying it is a visible act.

## Commits

```
<type>(<scope>): <subject>
```

`feat`, `fix`, `refactor`, `test`, `docs`, `chore` or `perf`; scope from the list in AGENTS.md § Scope. Imperative mood, no capital, no trailing period, subject at most 50 characters.

## Specs and ADRs

Normative specs are `specs/<slug>/spec.md`, decision records are `adrs/`. Each spec opens with a header table whose **`Status` row tracks test-citation coverage, not how finished the feature is**: no cited statement is `Draft`, some is `In Progress`, all is `Shipped`. A spec describing working, shipped behaviour still reads `Draft` until its statements cite tests. `npm run check:spec-status` enforces the correspondence, so raising `Status` without adding citations fails.

An ADR's `status` is different: that one does mean maturity — `proposed`, `accepted`, `superseded` — and is not a coverage tier.

## If you are working from a fork

Your pull request runs a **reduced set of checks**, and nothing is wrong with your branch when it does.

GitHub gives a fork's workflow run a read-only token and withholds every repository secret, whatever a workflow asks for. So:

- **CI runs in full.** `Verify`, `Build chain` and `Smoke (packed tarball)` need no secret. If one of those is red, it is yours.
- **`Lore Spec Impact` does not run at all.** It needs a repository secret to reach its API and a writable token to post its comment, so it is skipped on a fork rather than failed. A missing check there is expected.

A maintainer sees the full set once the branch is merged, and will tell you if anything only they can see is unhappy.

## Security

Do not open a public issue for a vulnerability. `SECURITY.md` has the private intake and what is in scope.
