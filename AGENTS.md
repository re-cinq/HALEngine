# AGENTS.md

## Context Loading Order

Agents should read files in this order to understand the HAL Engine codebase:

1. **README.md** - Overview, features, quick start, and project structure
2. **package.json** - Dependencies, scripts, tech stack validation
3. **tsconfig.json** - TypeScript configuration and compilation targets
4. **src/index.ts** - Public API exports and module surface
5. **src/config.ts** - Main factory function `createHalEngine()` and configuration schema
6. **src/types/** - Core type definitions (ai.ts, session.ts, messages.ts, auth.ts, sessionStore.ts)
7. **src/providers/** - AI provider implementations (bedrock, vertex, openai, anthropic, mock)
8. **src/infrastructure/** - Support layers (builders, stores, parsers)
9. **src/orchestration/** - Business logic (chatOrchestrator, tools, context management)
10. **src/transport/** - Server setup (Express app, WebSocket, routes)
11. **specs/** - Normative specs (architecture, WebSocket protocol, providers, tool responses)
12. **adrs/** - Architecture Decision Records
13. **docs/** - How-to guides, coding practices, and research spikes under docs/spikes/
14. **.specify/spec.md** - Repo-level system spec (exempt from the spec header table convention)

## Workflow Commands

### Development
```bash
npm run dev          # Start example/server.ts with hot reload (tsx watch)
npm run typecheck    # Run TypeScript type checking without emitting
```

### Building
```bash
npm run build        # Compile TypeScript to dist/ (tsc)
npm start            # Run compiled JavaScript from dist/index.js
```

### Testing
```bash
npm test             # Run Jest test suite
# Tests use ts-jest for TypeScript compilation
# Configuration: jest.config.js
```

### Code Quality
```bash
npm run eslint       # Run ESLint with max-warnings 0 (zero-tolerance)
npm run prettier     # Format all src/**/*.ts with Prettier
npm run prettier:check  # Check formatting without writing
```

### All Checks (Recommended Pre-Commit)
```bash
npm run verify
```

That is the blocking set `.github/workflows/ci.yml`'s `verify` job runs on every
pull request, in the same order, and `scripts/verify-script.test.ts` fails if the
two stop agreeing - so this command cannot quietly become a subset of what CI
demands. Two gates in that job are missing from it because both diff against
`origin/main` and neither runs the same way on a checkout: the spec anchor check
and the changelog check.

Two further CI jobs are worth running locally before a release or a change that
touches packaging: `npm run check:build-chain` (audit and action pins) and
`npm run smoke` (packs the tarball and installs it outside this tree).

## Spec Header Table

Every `specs/*/spec.md` opens with its title, then a two-column header table,
and carries a lead paragraph of prose before its first `##` section:

```markdown
# <spec title>

| Field  | Value                  |
| ------ | ---------------------- |
| Issue  | re-cinq/HALEngine#<n> |
| Status | Draft                  |

<lead paragraph>
```

The lead paragraph does not have to sit immediately after the table: a spec
carrying a metadata block of its own may place that block between the two. What
the convention requires is that prose, rather than a section heading, follows
the header material, and that the prose runs to at least 40 characters -
anything shorter is reported as no lead paragraph at all.

`Issue` names the issue the spec was written against, or `n/a` for the specs
that predate this convention.

`Status` is one of `Draft`, `In Progress` or `Shipped`. It is not a mood, and
it is not a claim about how finished the feature is: it is the spec's own
test-citation coverage. No testable statement cited is `Draft`, some cited is
`In Progress`, all cited is `Shipped`. A spec describing shipped, working
behaviour still reads `Draft` until its statements cite the tests that
validate them.

A spec that should no longer be graded takes a terminal value instead. The
parser buckets roughly sixteen labels into five buckets, and the two terminal
ones skip the coverage check whatever the citation count:

| Written into the spec                                            | Bucket                       |
| ---------------------------------------------------------------- | ---------------------------- |
| `Draft`                                                          | `draft`                      |
| `In Progress`, `In Review`, `Planning`, `WIP`, `Proposed`        | `in-progress`                |
| `Shipped`, `Implemented`, `Complete`, `Accepted`, `Done`, `Live` | `shipped`                    |
| `Retired`, `Superseded`, `Removed`, `Deprecated`, `Obsolete`     | `retired` - skips the check  |
| `Rejected`, `Abandoned`                                          | `rejected` - skips the check |

Prefer the canonical `Draft` / `In Progress` / `Shipped` for a live spec; reach
for `Retired` or `Rejected` rather than leaving a superseded spec to claim a
coverage tier it will never earn.

ADRs do not carry this table. They declare their state as YAML frontmatter
`status:` instead - `accepted` for a decision the code implements, `proposed`
for one it does not. That field does mean maturity, which the spec `Status` row
explicitly does not. The difference is deliberate: ADRs are exempt from the
coverage tier, because asking a decision record to cite a test for every
statement it makes is the wrong ask of a decision record.

`.specify/spec.md` is exempt from this section. It is the repo-level system
spec, it predates the convention, and its content is deliberately frozen -
giving it a header table and a lead paragraph would mean writing new prose into
a file that is meant to stay unchanged. The exemption covers the header table
and the lead paragraph only: the Lore coverage job does scan
`.specify/spec.md`, so link placement still applies to it.

## Spec Test Links

Statements in `specs/*/spec.md` cite their validating test in a trailing
parenthetical at the end of the statement, where a list item counts as one
statement and a paragraph counts per sentence. Tests live beside their source
in this repo, so the path points into `src/`:

```markdown
- All entries within a single assistant response are committed before the next
  user message is processed
  ([validated by: commits every entry before the next user message](../../src/orchestration/chatOrchestrator.test.ts#L42)).
```

The citation carries the test's **name** as well as its line. The name is what the
author cited; the line is a derived pointer, and it goes stale on its own - adding
an import above a suite moves every test below it, and the citation lands on a
different, still-valid declaration without anything noticing. `npm run spec:names`
holds each citation to the test it names, and `npm run spec:names:fix` repoints the
line from the name. The `#Lnn` stays because the lint rule and the coverage job
both index by it; a citation without one marks the whole file covered rather than
one test.

A citation counts as coverage only where it is trailing, and a test link placed
anywhere else in the statement is a misplaced citation rather than a weaker one.
Upstream `check:spec-links` reports it and exits 1, and the coverage job that
consumes these specs records nothing for it - so a spec can read as fully cited while its coverage is
zero. A mid-statement link to something that is not a test file - a script, a
doc, another spec - is ordinary prose, is never reported, and was never coverage
to begin with. A misplaced citation is fixed by moving it to the end of its
statement, never by deleting it.

In a test file the `#Lnn` anchor must land on the `it(`, `test(` or `describe(`
declaration itself - not a blank line, not one holding only closing punctuation,
and not a line inside the test body. A citation onto an `expect` renders and
resolves like any other, and proves nothing: no reader can turn that line back
into the name of a case. `scripts/repoint-spec-anchors.mjs` reports all four as
`rotten` and exits 1 in both modes. A citation into a file that is not a test -
a workflow, a config, `package.json` - has no declaration to land on and is held
only to existing and carrying content.

What no gate can catch is an anchor aimed at the wrong declaration: a real but
unintended `it(` passes every check. The tell is that the test the statement
meant to cite goes on reading as uncited in the `require-spec-link` backlog.

Anchors drift silently whenever a cited file gains or loses lines above them, so
after editing any cited file re-run `node scripts/repoint-spec-anchors.mjs`
rather than hand-correcting the numbers. That script cannot repair a spec absent
from the base ref, since it has no baseline to translate from; on the branch that
introduces a spec, its anchors have to be corrected by hand.

The convention's tooling is wired up here: `npm run check:spec-links`, `npm run check:spec-status` and
`node scripts/repoint-spec-anchors.mjs --check origin/main` all gate CI, and
`re-lint/require-status-matches-coverage` derives each `Status` row from its
spec's citations. `re-lint/require-spec-link` gates in `eslint.config.mjs`: every test cites a
statement, so an uncited new test fails the build. Its statement-side mirror,
`require-statement-links`, runs at `warn` from `eslint.config.backlog.mjs` and
reports without blocking - the severities the rule pair is designed for.

## Commit Conventions

### Format
Follow conventional commits:
```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types
- `feat` - New feature (provider, tool, config option)
- `fix` - Bug fix
- `refactor` - Code restructuring without behavior change
- `test` - Test additions or modifications
- `docs` - Documentation only
- `chore` - Build, deps, config, tooling
- `perf` - Performance improvement

### Scope
Optional but recommended. Use domain areas:
- `bedrock` / `vertex` / `openai` / `anthropic` / `mock` - Provider-specific
- `tools` - Tool registry and execution
- `orchestrator` - Chat orchestrator
- `transport` - Express/WebSocket
- `session` - Session management
- `types` - Type definitions
- `build` - Build/packaging

### Examples
```
feat(tools): add parallel tool execution batching
fix(bedrock): handle streaming timeouts gracefully
refactor(orchestrator): extract context building logic
docs(providers): add Vertex AI implementation guide
test(tools): add registry conflict detection
```

### Rules
- Use imperative mood: "add" not "added" or "adds"
- Do not capitalize first letter of subject
- No period (.) at end of subject
- Limit subject to 50 characters
- Reference issues in footer: `Fixes #123`, `Relates to #456`
- Breaking changes in footer: `BREAKING CHANGE: description`

## PR Requirements

### Before Opening
1. Run full check suite and ensure all pass:
   ```bash
   npm run verify
   ```
2. Create a feature branch from `main`: `git checkout -b feat/description`
3. Commit with conventional format

### PR Description Template
```markdown
## Description
Brief summary of changes and rationale.

## Type of Change
- [ ] Feature
- [ ] Bug fix
- [ ] Breaking change
- [ ] Documentation

## Changes
- Bullet list of concrete changes
- What was added/modified/removed

## Testing
- How to test locally
- Any new test cases added
- Edge cases considered

## Checklist
- [ ] Code follows style guide (eslint passes)
- [ ] No console.logs or debugging code
- [ ] TypeScript strict mode passes
- [ ] Tests added/updated for new behavior
- [ ] Documentation updated (README, specs/, adrs/, docs/)
- [ ] Spec `Status` rows re-evaluated if any spec gained or lost a test citation
- [ ] No new warnings in build output
```

### Acceptance Criteria
- [ ] All GitHub Actions CI checks pass. `.github/workflows/ci.yml` is three
      jobs - `verify` (sixteen steps, of which `npm run verify` reproduces
      fourteen), `build-chain` (audit, action pins) and `smoke` (packed tarball,
      both peer variants)
- [ ] Reviewed by somebody other than the author. `main` requires a pull request
      but is configured for zero required approvals and carries no `CODEOWNERS`,
      so this one is convention rather than a gate
- [ ] No merge conflicts
- [ ] Commit messages follow conventional format
- [ ] Tests cover new functionality (aim for >80% coverage on modified files)
- [ ] No dependencies added without discussion (especially AI provider SDKs)
- [ ] Breaking changes clearly documented and justified
- [ ] Public API changes described in `specs/`, not in comments (see Code Style)

### Provider Implementation PRs
For new provider support:
- [ ] Provider in `src/providers/<name>/` with index.ts exporting public API
- [ ] Implements `AIProvider` interface fully
- [ ] Handles streaming with `MessageChunk` protocol
- [ ] Tool/function calling mapped correctly
- [ ] Error handling with `AIError` type
- [ ] Tests for success and error scenarios
- [ ] Added to README.md provider table
- [ ] specs/hal-engine-providers/spec.md updated with implementation notes

## Compliance Constraints

### TypeScript
- `strict: true` in tsconfig.json is non-negotiable
- All public exports must be typed (no `any` in public APIs)
- Use `type` for type-only imports: `import type { ... } from '...'`
- Generics preferred over union types for reusability

### Code Style
- ESLint config: `eslint.config.mjs` (flat config format)
- Max warnings: 0 (all warnings treated as errors)
- Comments: one line maximum (`re-lint/max-comment-lines`), and it counts a run
  of consecutive `//` lines as one comment. JSDoc is **not** exempt — a one-line
  `/** … */` passes, a multi-line block does not, which is exactly what
  `@param`/`@returns`/`@throws` needs. Prose lives in `specs/`, `adrs/` and
  `docs/`. Exempt: tooling directives (`eslint-disable`/`eslint-enable`,
  `@ts-expect-error`/`@ts-ignore`/`@ts-nocheck`, triple-slash references,
  istanbul/c8 hints, `jscpd:ignore`, the shebang). An `eslint-disable` carries
  its reason after `--`
- Prettier config: `.prettierrc` (run before commit)
- Line length: 120 (`printWidth` in `.prettierrc`)
- Semicolons: Required
- Quotes: Single quotes (`singleQuote: true` in `.prettierrc`)

### Testing
- Jest configuration: `jest.config.js`
- ts-jest for TypeScript support
- Minimum coverage: 70% lines for new code. That is review guidance; the gate is
  `coverageThreshold` in `jest.config.js`, set to what each path measured rather
  than to a flat 70, which had handed four groups an 18-30 point regression budget
- The floors ratchet: raise one when coverage rises, never lower one to make a
  change pass. A floor that moves down is a regression with the alarm switched off
- The exception is a change of instrument. An upgrade that counts branch points the
  old version never saw re-reads every floor at once, and a group whose denominator
  grew can fall while nothing about the suite changed. Settle it on covered/total
  absolutes rather than percentages, and record them where the floors live
- All public APIs require at least one test
- Async code must have proper await/done handling

### Architecture Constraints
- **Layered structure mandatory** (types → providers → infrastructure → orchestration → transport)
- No circular dependencies between layers
- Providers must be pluggable (no hardcoded provider logic in orchestrator)
- Session store must be swappable (interface-based)
- Tools must be composable and testable in isolation
- WebSocket protocol defined in types/messages.ts (additive changes only for backward compatibility)

### Dependency Management
- Core dependencies only (Express, ws, uuid, cookie, cors, cookie-parser)
- `@types/express`, `@types/node` and `@types/ws` are dependencies rather than
  devDependencies, because the emitted `.d.ts` files import `express`, `http`,
  `stream` and `ws`. Moving them back breaks a consumer's `tsc`, not ours
- Provider SDKs as optional peerDependencies
- No peer dependency version conflicts
- Security: `npm run check:audit` fails at `high` and above on the full installed
  tree. Moderate and low advisories do not block. An advisory that cannot be
  fixed yet goes in `.github/audit-acknowledgements.json` carrying advisory,
  package, reason, ISO expiry and who acknowledged it; an expired entry fails
  the gate, so an acceptance cannot become permanent by neglect
- License: Apache-2.0, declared in `package.json` and carried in `LICENSE`. No
  per-file licence headers: `re-lint/max-comment-lines` caps a comment at one
  line and exempts only tooling directives, so the thirteen-line Apache notice
  cannot go in a source file. Apache-2.0 recommends headers, it does not
  require them

### Documentation Requirements
- A comment may span at most one line, JSDoc included — see Code Style. What a
  public function is and does belongs in `specs/`; what a signature is, the
  signature already says
- A one-line comment states the one constraint the code cannot show — "why", not
  "what". Anything longer goes to `specs/` or `adrs/`
- README.md kept in sync with actual features/examples
- specs/ directory is source of truth for architecture and protocols; adrs/ records decisions
- `.specify/spec.md` is the repo-level system spec. It is ingested by context
  tooling and served as authority, so a claim left stale there reaches every
  agent that assembles context for this repo. Keep it true when the manifest
  changes
- `CHANGELOG.md` at the repo root, Keep a Changelog 1.1.0, newest first under
  `## [Unreleased]`. Anything a consumer of the published package can observe
  gets an entry, written for somebody installing it rather than for somebody
  reading this repo's commit log. Enforced in CI: a pull request touching
  non-test files under `src/` fails unless it also touches `CHANGELOG.md`, and
  the `no-changelog` label is the deliberate escape hatch for a change nothing
  installable observes. Not derived from commit messages - a release note and a
  commit subject have different readers

### Releasing
- Five human steps: bump `version` in `package.json` inside the pull request,
  merge it, draft a GitHub Release on `main` tagged `vX.Y.Z`, publish it, approve
  the staged version. Everything between the release and the approval is CI
- Release notes are hand-written on Keep a Changelog 1.1.0, not generated from
  commit subjects. The audience is somebody installing the package, who cannot
  act on `refactor(transport):` and needs to know what changed for them
- Rename `CHANGELOG.md`'s `## [Unreleased]` heading to the version being
  released in that same pull request, and open a fresh `## [Unreleased]` above it.
  `npm run check:version -- vX.Y.Z` fails if the heading does not name the version
- Run `npm run check:version -- vX.Y.Z` before publishing the release. A release
  and its tag can be deleted; an approved version cannot be replaced, and after
  72 hours cannot be withdrawn
- The tag must be `vMAJOR.MINOR.PATCH` and match `package.json` exactly.
  Prerelease tags are rejected because nothing passes `--tag`, so one would
  publish as `latest` and every plain `npm install` would resolve to it. A
  release ticked as a pre-release is refused before a runner starts
- Cut the release from a commit already merged to `main`. The workflow refuses a
  tag whose commit is not an ancestor of `origin/main`: a release can be drafted
  against any branch or commit, so without that check the protection on `main` is
  not the boundary the release rests on
- `.github/workflows/publish.yml` runs on a published release. A draft fires
  nothing, and `workflow_dispatch` on the release's tag is how a publish that
  failed after the release exists is re-run. It re-runs the version guard, the
  build-chain checks and the packed-tarball smoke test against the tagged commit,
  and refuses a pack list carrying any `*.test.*` entry, before anything is
  published. A tag points wherever its author chose, so a green run on `main` is
  not evidence about what is being released
- Authentication is npm Trusted Publishing over OIDC. There is no `NPM_TOKEN`
  secret, and the trusted publisher is registered against the workflow file's
  path - renaming or moving `publish.yml` stops publishing until it is
  re-registered
- The publish carries `--provenance`, which is available only because ADR-007
  makes the source repository public
- The publish is staged. The workflow puts the tarball, its dist-tag and its
  provenance on the registry, and the version stays uninstallable until a
  maintainer approves it with 2FA - the package page's Versions tab, or
  `npm stage list` then `npm stage approve <id>`. A staged version nobody
  approves reaches nobody, which is the closest thing to an undo that exists
  once a tag has fired

### Breaking Changes
- MUST be discussed in issue before implementation
- MUST include migration guide in PR
- MUST increment MINOR version (semver)
- MUST update README quick start example if API changes
- MUST publish the migration guide as a `### Changed` entry in `CHANGELOG.md` as
  well as in the pull request: the PR is where reviewers read it, the changelog is
  where the consumer it affects reads it
- MUST add deprecation period (1 minor version) when possible. The unit is a
  published registry version and the audience is a consumer resolving one:
  a deprecation runs from the version that announces it to the version that
  removes the behaviour. A consumer on a git specifier is outside the clause -
  they pin a commit, so nothing announces anything to them and no minor
  elapses on their side

### AI Provider Compliance
- No hardcoded API keys or secrets (use environment variables)
- Providers must handle rate limiting gracefully
- Tool calling must match JSON Schema spec
- Streaming must support cancellation/cleanup
- Usage tracking must be optional (SessionStore integration)
- Error messages must be actionable (not raw SDK errors)