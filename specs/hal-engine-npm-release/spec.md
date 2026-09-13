# HAL Engine on npm

| Field  | Value           |
| ------ | --------------- |
| Issue  | n/a             |
| Status | In Progress     |

This package has never been published. It is `hal-engine@0.1.0`, CommonJS, unlicensed, and reachable only through a git specifier that clones the repository and builds from source. This spec describes what has to become true for `npm install @re-cinq/hal-engine` to resolve from the public registry: the module format it ships, the manifest that describes it, the pipeline that releases it from a `v*` tag without a stored token, and the handful of defects a first public release must not carry — an authentication fallback that opens a chat API, a hook that is declared and never called, a factory arm that drops its configuration, and an optional peer that is not optional. It also covers the documentation, because npm renders `README.md` and nothing else.

The scope is this repository. One decision it depends on — whether the source repository is publicly resolvable, which is what npm provenance requires — is recorded in [ADR-007](../../adrs/ADR-007-repository-visibility.md): the repository becomes public, so the release carries provenance.

## The package that ships

### Module format

The package is ESM-only. `package.json` carries `"type": "module"`, and `tsconfig.json` already targets `NodeNext`/`NodeNext` with every relative import in `src/` ending in `.js`, so no import rewriting is needed.

Three ways to keep that lazy load were available, and the third is what shipped:

| | Approach | Cost |
|---|---|---|
| A | `await import()`, making `createProvider` async | `createHalEngine` becomes async too, and every consumer's construction site changes. A breaking change to the one function the README opens with |
| B | Static imports, dropping laziness | Importing the package root pulls in every provider SDK, which is the defect T002 exists to fix |
| C | `createRequire(import.meta.url)` at the call site | Keeps `createProvider` and `createHalEngine` synchronous, keeps the load lazy, and confines the CommonJS interop to one helper |

C. `createHalEngine` stays synchronous - that is the point of the choice, not a side effect of it - and the interop lives in `src/providers/requireOptionalPeer.ts` rather than being spread across `providerFactory.ts` and `bedrockProvider.ts:24`.

- The five `require()` calls in `src/providers/providerFactory.ts` do not survive, because `require` does not exist under ESM.
- The lazy-load they implement must survive in some form: `createProvider` MUST NOT load a provider SDK for an arm the caller did not select.
- `jest.config.js` uses `module.exports`, which is illegal under `"type": "module"`, and becomes an ESM config with a default export. The suite runs as real ESM under `--experimental-vm-modules` rather than being compiled to CommonJS: an ESM-only package whose tests exercise CJS output would hide the failure class this conversion exists to prevent, and `import.meta` in the provider layer cannot compile to CommonJS at all. Every spawn of jest needs the flag, not only the `test` script.
- The `dev` and `test` scripts both run TypeScript through a CommonJS loader today and need an ESM-compatible answer.

This is a breaking change under AGENTS.md § Breaking Changes and inherits that section's obligations: a migration guide in the pull request and a MINOR bump. The version that carries it is `0.2.0`.

### Optional peers

`@aws-sdk/client-bedrock-runtime` and `@google-cloud/vertexai` are declared optional peers, and exactly one of them behaves like one. `src/index.ts:21` re-exports `createVertexProvider` as a value from a module whose first line statically imports `@google-cloud/vertexai`, so importing the package root loads the Vertex SDK whether or not the caller ever names Vertex.

- Importing the package root MUST NOT require either optional peer to be installed. Measured on the built `dist/`: a bare root import loaded 38 `@google-cloud/vertexai` modules before this change and 0 after, with Bedrock at 0 throughout. The `full` smoke variant holds that number: it is the only place both peers are installed, so it is the only place a barrel that went eager again would be visible at all, and it counts the SDK modules loaded by the root import rather than asserting a directory is absent.
- An absent peer MUST fail at provider construction, not at import — the contract `src/providers/bedrock/bedrockProvider.ts` already kept and `createVertexProvider` now matches.
- Both providers route their absent-peer failure through one helper, so the message names the package and its install command rather than surfacing a raw `MODULE_NOT_FOUND` from inside `dist/` ([validated by: throws an error naming the absent package and the command that installs it](../../src/providers/requireOptionalPeer.test.ts#L15)).
- That failure is an `AIError` carrying the code `OPTIONAL_PEER_MISSING`, not a bare module-resolution error ([validated by: tags the absent-peer failure with OPTIONAL_PEER_MISSING rather than a raw module error](../../src/providers/requireOptionalPeer.test.ts#L22)).
- It is not retryable, because installing a package is not a retry ([validated by: does not mark an absent peer retryable, because installing a package is not a retry](../../src/providers/requireOptionalPeer.test.ts#L26)).
- An installed peer is returned unchanged ([validated by: returns the installed module untouched when the peer is present](../../src/providers/requireOptionalPeer.test.ts#L11)).
- The helper decides "absent" structurally rather than with `instanceof Error`, because a module loader running in another realm throws an `Error` this one disowns — measured under jest, where `instanceof Error` is `false` for exactly that failure.
- "Absent" is decided from the first line of the loader's message, which names the module that was not found. The Require stack below that line holds the peer's own files, so a substring test reports a peer whose own dependency is missing as the peer being absent — telling the caller to install what they already have and discarding the real cause.
- An installed peer whose own dependency is missing rethrows the loader's error ([validated by: rethrows the loader error rather than reporting the peer itself as absent](../../src/providers/requireOptionalPeer.test.ts#L58)).
- That failure is not dressed as an absent optional peer ([validated by: does not dress that failure as an absent optional peer](../../src/providers/requireOptionalPeer.test.ts#L62)).
- The helper lives at the providers-layer root, not in `src/shared/`. `layers.yaml` declares `shared: []` — it may import nothing, `types` included — so `AIError` is unreachable from there, and a helper that could not build the error would defeat its own purpose.
- Subpath exports are explicitly not the answer here; the `exports` map stays a single root entry.

### Manifest

| Field | Today | After |
|---|---|---|
| `name` | `hal-engine` | `@re-cinq/hal-engine` |
| `version` | `0.1.0` | `0.2.0` |
| `type` | absent | `module` |
| `license` | absent | `Apache-2.0`, with a matching `LICENSE` file |
| `repository` | absent | `git+https://github.com/re-cinq/HALEngine.git` |
| `exports` | absent | a single `.` entry resolving `types` then `default` |
| `publishConfig` | absent | `{"access": "public"}` |
| `engines` | absent | `{"node": ">=22"}` |
| `bugs` | absent | the vulnerability-disclosure intake address |
| `files` | `["dist"]` | unchanged |

`main` and `types` are kept alongside `exports`, matching the reference implementation. `prepare: "npm run build"` is kept, which means npm runs it on both `npm ci` and `npm publish` — every CI install in this repository therefore uses `--ignore-scripts`.

`@types/express`, `@types/node` and `@types/ws` move from `devDependencies` to `dependencies`. The emitted `.d.ts` files import `express`, `http`, `stream` and `ws` unconditionally — `types/auth.d.ts` and three files under `transport/` — so with those packages dev-only a consumer resolves the runtime fine and fails to type-check. Measured on the packed tarball in an empty project: eight `TS7016`/`TS2591`/`TS2307` errors before the move, and a clean `tsc` exit after it. This is a manifest defect rather than a smoke-test finding, which is why it lands with the manifest; the smoke test is what stops it returning.

The `@aws-sdk/client-bedrock-runtime` reference in the emitted types is not the same problem. It survives the peer being absent, because it is a `typeof import(...)` inside a function body rather than a type in the public surface — verified by type-checking a consumer with neither optional peer installed.

### What `dist/` contains

`tsconfig.build.json` already excludes `**/*.test.ts` from emit while `tsconfig.json` keeps type-checking them, so compiled test files no longer reach the package. What is missing is a check: the publish workflow MUST fail when the pack list contains any `*.test.*` entry, so this cannot silently regress.

`tsconfig.build.json` also turns `declarationMap` and `sourceMap` off, which the root config leaves on for local work. `files` is `["dist"]`, so a published map named a `../src/*.ts` that the tarball did not carry and held no `sourcesContent` — 98 dead maps, half the file list, resolving to nothing in any consumer's debugger. Turning them off rather than adding `src` to `files` keeps the published artifact to what the package runs: measured at the change, 199 files and a 55.6 kB tarball became 101 files and 33.8 kB. A consumer wanting to step through the source has the repository.

The list itself, rather than a count that drifts unnoticed: `npm pack --dry-run` prints 101 entries, and every one falls in four groups.

| Group | Entries | What it is |
|---|---|---|
| `dist/` | 98 | the compiled package - `.js` and `.d.ts` only, no maps and no `*.test.*` |
| `package.json` | 1 | the manifest, which `files: ["dist"]` cannot exclude |
| `README.md` | 1 | what npm renders on the package page |
| `LICENSE` | 1 | Apache-2.0, which npm includes whether or not `files` names it |

Nothing from `src/`, `example/`, `smoke/`, `docs/`, `specs/`, `adrs/` or `scripts/` appears, and the publish workflow fails the job if one does. Sizes move with every source change and are not pinned here; the group table is what a reviewer checks. The publish workflow's pack-list check MUST fail on a `*.map` entry for the same reason it fails on a `*.test.*` one.

## The release pipeline

### Coverage floor

`.github/workflows/ci.yml` runs typecheck, lint, the traceability backlog report, format, test, build, and three spec-consistency checks. It does not measure coverage.

- `jest.config.js` gains `collectCoverageFrom` and `coverageThreshold`, and `package.json` gains a `test:coverage` script. CI's existing `Test` step calls it instead of `npm test`, so the floor gates the suite rather than adding a second full run.
- Coverage is collected from `src/` only. The `scripts/` suites drive their subjects through `spawnSync`, so an instrumented `.mjs` would report zero however well it is tested. `providerTestSupport.ts` is excluded as test scaffolding rather than shipped source.
- The floor is set at the measured baseline, not an aspiration, and exactly at it rather than rounded down: an integer floor leaves roughly a percent of slack, which was measured to let four untested lines through without failing.
- Measured at `3186f07` with those exclusions: 67.96% statements, 57.54% branches, 68% functions, 68.34% lines, across 206 tests in 17 suites. The earlier figure of 61.32% lines predates the exclusions and three of this branch's commits.
- The floor is a ratchet: a change that lowers coverage fails the job and is fixed by adding the missing test, never by lowering the number; a change that raises coverage should raise the floor with it.
- `coverage/` is gitignored already, so nothing is added for it.

### Build-chain audit

AGENTS.md § Quality Gates already commits this repository to "npm audit must show no vulnerabilities", and nothing enforced it. Measured before this work: 18 advisories — 1 critical, 6 high, 8 moderate, 3 low — and `ws`, a direct production dependency, was one of the six high.

- A check fails on any unacknowledged advisory at `high` or above, over the full installed tree rather than production dependencies only. The dev tree is what a runner installs before building `dist/`, and after the release workflow exists that runner holds `id-token: write`.
- Acceptances live in `.github/audit-acknowledgements.json`, one entry per advisory, each naming the advisory, the package, the reason, an ISO expiry and who accepted it. An entry that is expired, malformed, or matches no current advisory fails the check too — a stale acceptance is a claim nobody has rechecked.
- A second check fails when any `uses:` reference in `.github/workflows/` is not a 40-character commit SHA, skipping `./` and `docker://` references, which cannot be pinned that way. All five references across the three workflows were tag-pinned and are now SHA-pinned with the tag kept in a trailing comment.
- Both checks run as their own CI job rather than as steps on the existing one, because they report on what the build chain pulls in rather than on what the code does, and again before `npm publish`.
- `npm audit fix` clears the backlog to 3 advisories — 2 moderate, 1 low, none at high or above — touching only `package-lock.json`. No dependency range in `package.json` changes, and the suite passes unchanged, so no acceptance entry is needed to go green.
- `supertest` and `@types/supertest` stay. An earlier measurement found zero occurrences under `src/`, but `src/transport/routes/chats.test.ts` has imported `supertest` since the chat-ownership tests landed, and removing it would take 11 tests with it. Its `form-data` advisory is resolved by the lockfile update instead.

The gate runs immediately before `npm publish`, so the two ways it can report a clean tree without having checked one are part of its contract rather than details of its implementation. It shells out to `npm audit`, whose registry failures are themselves JSON and carry no `vulnerabilities` key; and an acceptance names an advisory, which means an acceptance recorded for one advisory must not absorb the next one in the same package.

- A report carrying no vulnerability data fails the check rather than reading as nothing-to-report ([validated by: refuses to report clean when npm returns its registry-failure document](../../scripts/check-audit.test.ts#L81)).
- That failure names the reason rather than exiting silently ([validated by: names the reason rather than failing silently](../../scripts/check-audit.test.ts#L87)).
- Output that is not JSON at all fails the same way ([validated by: refuses to report clean when npm returns no JSON at all](../../scripts/check-audit.test.ts#L93)).
- An unacknowledged advisory at `high` or above fails the check ([validated by: fails on an unacknowledged critical advisory](../../scripts/check-audit.test.ts#L101)).
- The blocking line carries the package, the version installed, the affected range, the advisory id, its title and the path it is reached through ([validated by: names the package, version range, advisory id and path in the blocking line](../../scripts/check-audit.test.ts#L105)).
- The installed version is read from the tree rather than taken from the report, which carries only the affected range - a maintainer deciding whether an upgrade exists needs the version they actually have ([validated by: names the installed version when the package is resolvable on disk](../../scripts/check-audit.test.ts#L114)).
- A package the report names but the tree does not carry is said to be unresolvable rather than given a version the gate does not know ([validated by: names the package, version range, advisory id and path in the blocking line](../../scripts/check-audit.test.ts#L105)).
- An acceptance naming that advisory passes it ([validated by: passes when the acceptance names that advisory](../../scripts/check-audit.test.ts#L122)).
- An acceptance naming a different advisory in the same package does not ([validated by: does not let an acceptance for one advisory cover a different one in the same package](../../scripts/check-audit.test.ts#L129)).
- Such an acceptance is itself reported as matching no current advisory ([validated by: reports the unmatched acceptance as stale rather than ignoring it](../../scripts/check-audit.test.ts#L136)).
- A second advisory in an otherwise accepted package still fails ([validated by: still fails on a second unacknowledged advisory in an otherwise accepted package](../../scripts/check-audit.test.ts#L157)).
- An expired acceptance fails the check ([validated by: fails on an acceptance whose expiry has passed](../../scripts/check-audit.test.ts#L143)).
- An expired acceptance is named by advisory and package ([validated by: names the expired acceptance by advisory and package](../../scripts/check-audit.test.ts#L150)).
- A clean report with no acceptances passes ([validated by: passes a clean report with no acceptances](../../scripts/check-audit.test.ts#L169)).


A `uses:` reference is pinned to a commit SHA because a tag is a mutable pointer its owner can repoint under a job holding repository credentials. The scan covers the whole of `.github/`, not `workflows/` alone: a composite action carries its own `uses:` lines and runs inside whichever job calls it, so scanning only workflows leaves it unpinnable with nothing to notice.

The documents are parsed rather than scanned line by line. A line scan reads one YAML spelling and misses every other one that means the same thing: `steps: [{uses: actions/checkout@v4}]` is legal flow style, and it passed a gate that exists to stand between a mutable tag and publish rights. A parser sees the reference wherever the author put it.

- A reference pinned to a 40-hex commit SHA is accepted ([validated by: accepts a reference pinned to a 40-hex commit SHA](../../scripts/check-action-pins.test.ts#L16)).
- A reference pinned to a tag is refused ([validated by: refuses a reference pinned to a tag](../../scripts/check-action-pins.test.ts#L20)).
- The report names the file, the line and the reference ([validated by: names the file, the line and the reference it refused](../../scripts/check-action-pins.test.ts#L24)).
- A local `./` reference is skipped, having no SHA to pin ([validated by: skips a local reference, which cannot be pinned to a SHA](../../scripts/check-action-pins.test.ts#L28)).
- An unpinned reference written in YAML flow style is refused ([validated by: refuses an unpinned reference written in YAML flow style](../../scripts/check-action-pins.test.ts#L33)).
- It is named in the report, which no line grep reached ([validated by: names the reference it found in flow style, which no line grep could reach](../../scripts/check-action-pins.test.ts#L37)).
- An unpinned reference inside a composite action is refused ([validated by: refuses an unpinned reference inside a composite action, not just a workflow](../../scripts/check-action-pins.test.ts#L42)).
- That same composite passes under a workflows-only scan, which is the gap the wider scope closes ([validated by: would have passed that composite under a workflows-only scan, which is why the scope widened](../../scripts/check-action-pins.test.ts#L46)).

The pack list is checked for what it must carry as well as what it must not. A pure absence check calls an empty `dist/` clean: `npm publish` would then ship a package with no entry point, unpublishable after 72 hours and permanent after that. The required set is `package.json`, `README.md`, `LICENSE`, `dist/index.js` and `dist/index.d.ts`.

`npm` is installed at `^11.5.1` rather than `latest` in the publish job. Trusted publishing needs 11.5.1 or newer, and that job is the one holding `id-token: write` - `latest` lets a major nobody here has run decide how the publish behaves.

The trust-boundary check runs before the gates rather than after them. A tag pushed from a branch that never reached `main` is rejected in seconds instead of after a full build and test run.
Three holes in the first version of this gate, each of which let it pass on something it should have stopped. `metadata.vulnerabilities` was accepted as an alternative to the real map, so a report carrying counts but no listing printed a critical count and the word clean in the same sentence; every modern `npm audit --json` carries the map, so the alternative bought nothing. The `unknown:` fallback for a missing advisory id was applied on a cycle-pruned re-entry, so an ordinary circular `via` pair fabricated an advisory that no acceptance could name and no maintainer could clear, on a tag that cannot be re-pointed. And `source` is npm's id for the package rather than the advisory, so two advisories on one package collapsed to one id and a single acceptance silenced both.

- A report carrying only metadata counts is rejected rather than read as zero findings ([validated by: rejects a report carrying only metadata counts, which declares vulnerabilities it cannot list](../../scripts/check-audit.test.ts#L178)).
- A `via` cycle produces no fabricated advisory ([validated by: does not fabricate an advisory when two packages reach each other through via](../../scripts/check-audit.test.ts#L184)).
- An advisory reached twice through `via` is reported once ([validated by: reports an advisory reached twice through via once, not twice](../../scripts/check-audit.test.ts#L215)).
- Two advisories on one package stay distinct when neither carries a GHSA url ([validated by: keeps two advisories on one package distinct when neither carries a GHSA url](../../scripts/check-audit.test.ts#L234)).

### Tarball smoke test

Nothing in this repository has ever installed the package from a tarball. A git specifier builds from source and therefore exercises neither the `exports` map, nor `files`, nor the dependency list, nor the emitted `.d.ts` files.

- A committed consumer fixture under `smoke/` — its own `package.json`, an ESM entry point, a TypeScript file that imports the types, and a `tsconfig.json` — is installed from the packed tarball and run by `scripts/smoke.sh`.
- The install happens in a temp directory **outside** the repository tree. Installed inside it, Node and `tsc` walk up to this repo's own `node_modules` and every missing dependency resolves anyway, so the check passes on a package that would fail for a real consumer.
- Everything is installed in one `npm install`. A later `--no-save` install prunes packages absent from `package.json`, which silently removes the subject and turns the type check into a "cannot find module" false negative — measured while writing T004.
- The fixture asserts that neither optional peer is present, then that the mock provider streams to a `stop` chunk, then that constructing Vertex or Bedrock throws an `AIError` with code `OPTIONAL_PEER_MISSING` naming the missing package.
- It type-checks with `skipLibCheck: false`, so the published `.d.ts` files must compile on their own rather than being waved through. That setting is what surfaced `@types/express`, `@types/node` and `@types/ws` sitting in devDependencies.
- `smoke/` is excluded from `tsconfig.json` and `tsconfig.build.json` the way `example` is, because it compiles against the published package rather than against `src/`. It is outside the jest roots and outside `files`, so it is neither tested in place nor published.
- It runs as its own CI job, and T011 calls it in the publish workflow before `npm publish`.
- The check is load-bearing rather than decorative: reverting the T004 dependency move reproduces 8 `tsc` errors, and restoring the top-level Vertex import from before T002 reproduces `ERR_MODULE_NOT_FOUND` — both caught by this script alone.

Importing a package is not installing it. The fixture originally stopped at the package root - imports, a mock stream, and the absent-peer errors - which exercises none of `express`, `ws`, `cors`, `cookie-parser` or `uuid`, so a dependency missing from the manifest would have passed. It now builds an engine and drives it.

- The fixture calls `createHalEngine` and `start()` on port `0`, so the OS picks a free port and CI cannot collide with whatever else is listening.
- `GET {basePath}/health` answers `200` with `status: ok` and a timestamp. This is what proves the runtime dependencies resolve from the tarball's own `dependencies` rather than from a lucky hoist.
- One full turn runs through the orchestrator and the mock provider, and the assistant text is asserted. It is compared trimmed: the mock yields each word with a trailing space, so the last chunk leaves one behind — a fixture artefact rather than anything the orchestrator promises.
- `stop()` is called, and the runner fails the variant if the process does not then exit on its own within 15 seconds. A smoke test that needs killing is hiding a leaked handle from every consumer, which the engine's unreferenced heartbeat timer once was. Proved by leaking a handle deliberately and watching the runner refuse it.
- The consumer directory is asserted to be outside the repository rather than assumed to be: `mktemp` honours `TMPDIR`, and a `TMPDIR` inside the tree would quietly restore the resolution the whole script exists to prevent.

Two variants, because a consumer is in one of two states and they fail differently.

- `bare` installs neither optional peer — a mock-provider consumer. It asserts both peers are absent, runs the engine, and type-checks.
- `full` installs both at the versions `peerDependencies` names, and asserts both providers construct with their SDK loaded. Nothing here holds cloud credentials, so construction is the whole assertion; a call would fail for reasons that say nothing about this package.
- Neither variant is advisory. `bare` proves an absent peer fails well, `full` proves a present one is reached, and a provider that is dead on arrival passes the first and fails the second.
- The type check runs under `moduleResolution: "nodenext"` and again under `"bundler"`. NodeNext reads `exports.types` through the node condition; `bundler` is what a Next.js consumer uses and resolves differently, and a package can satisfy one and not the other.

### Release workflow

The repository has zero git tags. `0.1.0` was never tagged and never published, so there is no existing convention to fit around.

- A `v*` tag triggers one publish job. There is no `workflow_dispatch` trigger: a publish that can be started by hand is a publish whose input is a branch somebody chose in a dropdown, and the tag is the only thing the version guard and the ancestry check can be stated against.
- Prereleases are refused rather than routed to a dist-tag. Nothing here passes `--tag`, so a `v0.3.0-rc.1` would publish as `latest` and every plain `npm install` would resolve to it. Adding a dist-tag is a decision for whoever first needs one.
- The guard reads the committed version with `node -p "require('./package.json').version"` rather than by parsing the file, so it reads it the way npm will.
- The job authenticates with npm Trusted Publishing over OIDC. No `NPM_TOKEN` secret exists in the repository after bootstrap.
- `id-token: write` is scoped to the `publish` job rather than declared at workflow level, so the `verify` job - which runs the tests, the build and the packed-tarball smoke test - cannot mint an OIDC token at all. The issue specified a workflow-level pair; narrowing it costs nothing and removes a capability from every step that does not publish.
- A guard fails the job when the tag and the committed `package.json` version disagree. It is a committed script rather than an inline step, so a developer can run it before pushing a tag they cannot un-push ([validated by: refuses a tag that disagrees with the committed version](../../scripts/check-version.test.ts#L39)).
- A matching tag is accepted ([validated by: accepts a tag that matches the version under a changelog heading naming it](../../scripts/check-version.test.ts#L35)).
- A prerelease tag is refused, because nothing here passes `--tag` and one would publish as `latest` ([validated by: refuses a prerelease tag, because nothing here passes a dist-tag](../../scripts/check-version.test.ts#L43)).

The same guard holds `CHANGELOG.md` to the version being tagged. `check-changelog.sh` asks only that the file was touched, so the release rename was ungated, and the version reached the registry under a heading that never named it.

- A version the changelog never names is refused ([validated by: refuses a version the changelog never names](../../scripts/check-version.test.ts#L48)).
- The report names the heading that is missing ([validated by: says which heading is missing rather than only that something is wrong](../../scripts/check-version.test.ts#L52)).
- A heading matching the version only as a pattern does not satisfy it ([validated by: does not accept a heading that merely matches the version as a pattern](../../scripts/check-version.test.ts#L57)).
- A heading carrying no date is accepted, which Keep a Changelog allows ([validated by: accepts a heading carrying no date, which Keep a Changelog allows](../../scripts/check-version.test.ts#L61)).
- A guard fails the job when the tagged commit is not an ancestor of `origin/main`. A tag is pushable from any branch, so without it the protection on `main` is not the boundary the release rests on.
- Whether the publish carries `--provenance` is decided by [ADR-007](../../adrs/ADR-007-repository-visibility.md), which makes the repository public, so it does. npm generates provenance only from a public source repository, and refuses it for any repository an unauthenticated client cannot read.
- AGENTS.md gains a § Releasing section covering the four human steps: bump in the pull request, merge, tag `vX.Y.Z` on `main`, push the tag.

### Release notes

AGENTS.md claimed "CHANGELOG implied by conventional commits". Nothing implemented it, and no generator was ever added.

A conventional-commit ratio is sometimes offered as the reason a generator cannot work here. The decision does not rest on it: even with every commit conventionally typed, a generator would still emit the wrong thing for this audience.

- A hand-written `CHANGELOG.md` on Keep a Changelog 1.1.0 replaces the claim, `## [Unreleased]` first.
- The argument is audience. A generator emits commit subjects, and this repository's read like `feat(build): require a test citation to land on the declaration` — accurate for a reviewer and meaningless to somebody installing the package. The two breaking changes in this release, the ESM conversion and the scope rename, each need a sentence telling a consumer what to do, which no commit subject contains.
- AGENTS.md's line is replaced by the real rule rather than supplemented by a new contributing document.
- A CI step fails a pull request that touches non-test files under `src/` without touching `CHANGELOG.md`. Test-only changes under `src/` do not trigger it, because tests live beside their source here and a consumer cannot observe them. The `no-changelog` label is the escape hatch, and applying it is a visible act rather than a silent omission.
- The `## [Unreleased]` heading is renamed to the version being released as part of the release procedure T011 documents.

### First publish

Trusted publishing cannot be registered against a package name that has never been published. The `@re-cinq` scope already exists; the package name does not.

- A single-use, manually triggered workflow publishes `0.2.0` once with a short-lived token.
- It runs from CI rather than a laptop, so the provenance attestation is produced from the GitHub OIDC token and `0.2.0` is not permanently unattested.
- The trusted publisher is then registered against the release workflow, the token is revoked, the secret is deleted, and the single-use workflow is deleted.
- A `v0.2.1` tag then publishes with no secret present in the repository. That is the evidence this step produces.
- Everything here happens once and cannot be redone: a published version cannot be replaced, and after 72 hours cannot be withdrawn. It therefore runs last, after the tarball smoke test passes and after the README that becomes the package's front page is correct.

## Correctness the first release must not ship

### The demo chat routes deny by default

`src/transport/routes/chats.ts:33` falls back to a pass-through middleware when no HTTP authentication is configured, so a consumer who configures only WebSocket auth publishes an unauthenticated chat API beside an authenticated socket. An unauthenticated caller can drive up to `maxToolRounds` model calls per request, billed and forwarded to the model vendor. The engine's own `example/server.ts` ships this configuration.

- The fallback becomes a middleware that answers `401`, for all three routes.
- `createChatRoutes`, `createApp` and `HalEngineConfig` keep their signatures. This is a default change, not a type change.
- A consumer terminating authentication at a gateway writes the pass-through themselves, one line, in their own repository.
- `specs/hal-engine-chat-routes/spec.md` § When the guard does nothing currently describes the old default as behaviour and is corrected here.

### The ownership guard runs

`src/transport/routes/chats.ts:35` records `req.user?.id ?? 'anonymous'` as the chat's owner, and `authorizedChat` compares owners only when the caller's id is truthy. A consumer who authenticates correctly but attaches the user somewhere other than `req.user` gets every chat owned by the string `'anonymous'` and readable by everyone, with no error anywhere.

- The `'anonymous'` fallback is removed.
- `AuthenticatedRequest` — `Request` plus optional `user` — is exported from the types layer and re-exported from the public surface, and `HttpAuthMiddleware` is restated in its terms, so the contract for what a middleware must produce is written down.
- The four ad-hoc inline casts in `chats.ts` are replaced by that exported type.
- A guard between the auth middleware and each handler answers `401` when `req.user` is absent or its `id` is `undefined`, `null` or `''`. The empty string is named explicitly because `id` is `string | number` and `0` is a legal id that a truthiness check would wrongly deny.

### The routes say what they are

`createChatRoutes` takes a `SessionStore` and ignores it — the parameter is named `_sessionStore` — and keeps every chat in a process-local `Map`. A chat id created over REST never reaches a WebSocket session: the socket path matcher never parses one, the connection handler mints its own session id, and inbound validation discards the field. The documented flow of creating a chat over REST and then connecting to it has never been joined.

- The export stays. It is public surface of a package about to be published, and the only worked example in the repository of lifting auth headers off an Express request into a `ChatSession`.
- The `_sessionStore` parameter stays. Dropping it is a breaking change for no gain.
- The file states, at its head, that the store is unused by design, that the `Map` is process-local, and that a REST-created chat id is not a WebSocket session id.

### The example is the only correct file, and nothing checked it

`tsconfig.json` sets `rootDir` to `src/` and excludes `example/`, so the one file the README and the guide are written against was never compiled. Both drifted from it: three `PromptBuilderConfig` fields under names the type does not have, a `ws` authenticator taking a token rather than the upgrade request and returning `userId` rather than `id`, an `engine.listen()` that does not exist, and a documented `orchestrator.hooks` that `createHalEngine` never forwards.

- `tsconfig.example.json` compiles `example/` against `src/` with `noEmit`, run as `typecheck:example` and called from CI.
- The README quick start and the guide's minimal setup are `example/server.ts` apart from the import specifier.
- `OrchestratorHooks` is documented where it actually lives, on `createChatOrchestrator`, not on `HalEngineConfig`.

### `onConnect` is called

`HalEngineConfig.onConnect` is declared at `src/config.ts:37`, forwarded at `:75`, and declared again on `HalServerOptions` at `src/transport/createServer.ts:20` — and then omitted from the `deps` object at `:50` that the connection handler receives. Its sibling `onDisconnect` is forwarded on the adjacent line and is invoked on every close, so a consumer sees half the pair work. Four committed documents say both work.

- `createServer` forwards `onConnect` into the `deps` object the connection handler receives, which is the omission that made the hook dead ([validated by: forwards onConnect to the connection handler](../../src/transport/createServer.test.ts#L41)).
- `onConnect` is invoked once per accepted connection, with the session the socket was given ([validated by: is called once for an accepted connection, with the session the socket was given](../../src/transport/ws/connectionHandler.test.ts#L43)).
- It is invoked after the `connected` frame is sent, not before ([validated by: runs after the connected frame is sent, not before it](../../src/transport/ws/connectionHandler.test.ts#L66)).
- It is not invoked inline in the `connection` listener, where a synchronous throw corrupts an already-upgraded socket. It runs on a microtask, which drains before the loop delivers any inbound frame ([validated by: is deferred, so it never runs inside the connection listener](../../src/transport/ws/connectionHandler.test.ts#L77)).
- Both hooks widen to `void | Promise<void>` and are fire-and-forget. The engine never awaits either, and a hook that rejects does not reach the process ([validated by: survives a hook that rejects](../../src/transport/ws/connectionHandler.test.ts#L98)).
- Both route through one helper that logs `{sessionId, error}` and swallows, so a throwing `onConnect` leaves the connection intact ([validated by: survives a hook that throws synchronously](../../src/transport/ws/connectionHandler.test.ts#L86)).
- The same helper covers the close path, where a throwing `onDisconnect` would otherwise escape the `close` listener ([validated by: does not let a throwing hook escape the close listener](../../src/transport/ws/connectionHandler.test.ts#L128)).
- Either hook may be absent, and a connection without one behaves identically ([validated by: is optional, so a connection without one still sends its frame](../../src/transport/ws/connectionHandler.test.ts#L106)).
- `onDisconnect` is called with the session id, after the store entry for it is deleted ([validated by: is called with the session id after the store entry is deleted](../../src/transport/ws/connectionHandler.test.ts#L117)).
- A rejecting `onDisconnect` is swallowed too, where an unhandled rejection would end the process under Node's defaults ([validated by: does not let a rejecting hook reach the process](../../src/transport/ws/connectionHandler.test.ts#L139)).
- A server configured with neither hook starts and accepts connections unchanged ([validated by: accepts a server configured without either hook](../../src/transport/createServer.test.ts#L52)).

### Log lines carry a severity

`src/shared/logger.ts:21` is the only `console.*` call under `src/`, and it is `console.log` for all four levels. Every line is unstructured text, so `log.error` is indistinguishable from `log.info` to anything reading the stream: a deployment filtering on severity matches nothing and stays green through an outage. This is public surface — `src/index.ts` exports both `log` and the `Logger` type.

- `emit` writes one JSON object per line, parseable and carrying no embedded newline ([validated by: writes one parseable JSON object per call](../../src/shared/logger.test.ts#L41)).
- The key set is `severity`, `message`, `timestamp` and `category`, in that order ([validated by: carries severity, message, timestamp and category, in that order](../../src/shared/logger.test.ts#L48)).
- `severity` is the uppercase level name ([validated by: uses the uppercase level name as severity](../../src/shared/logger.test.ts#L71)).
- `timestamp` is ISO-8601 UTC ([validated by: timestamps in ISO-8601 UTC](../../src/shared/logger.test.ts#L88)).
- A call's fields arrive as `data` rather than spread across the top level, and `data` is absent when the call passed none ([validated by: nests caller fields under data rather than at the top level](../../src/shared/logger.test.ts#L54)).
- Nesting them is what makes the key set stable: a field named `severity` cannot overwrite the line's own ([validated by: cannot have its own keys overwritten by a caller field of the same name](../../src/shared/logger.test.ts#L64)).
- `ERROR` goes to `console.error`; the other three levels go to `console.log` ([validated by: sends ERROR to stderr and every other level to stdout](../../src/shared/logger.test.ts#L80)).
- A level below the `LOG_LEVEL` threshold is dropped before the line is built ([validated by: drops a level below the configured threshold before writing anything](../../src/shared/logger.test.ts#L98)).

A log call must not be able to take down the call site it observes. `JSON.stringify` throws on a circular reference and on a `BigInt`, and one call site passes a value the consumer controls: `connectionHandler.ts` logs `userId`, which is whatever the configured `WsAuthenticator` returned. Before this was guarded, such an identity threw between `sessionStore.create` and the registration of the `close` listener, so the upgraded socket was answered with a raw `500` status line - the client reported a malformed frame - and the session was orphaned in the store permanently, once per connection attempt.

- A field that cannot be serialised does not propagate out of the log call ([validated by: does not throw out of the call site it was observing](../../src/shared/logger.test.ts#L123)).
- The line is still written, with the four envelope keys intact and `data` replaced by a string naming the reason ([validated by: still writes a parseable line, with the envelope intact and data marked](../../src/shared/logger.test.ts#L127)).
- The reason is the serialiser's own, so an operator can tell a cycle from a `BigInt` ([validated by: names the reason a BigInt field could not be written](../../src/shared/logger.test.ts#L139)).
- A degraded line still goes to the stream its severity selects ([validated by: keeps the degraded line on the stream its severity selects](../../src/shared/logger.test.ts#L145)).

### The logger a consumer supplies is the one that gets used

`logger` is declared on `HalEngineConfig`, is documented in five places, and was read by nothing: every line went through the module singleton regardless. It is the fifth instance of the seam this spec records above, and the one with a migration instruction resting on it - the release notes told consumers to supply a logger to keep the old line format. Seven modules import `log` at module scope, so the swap is a module-level one and is process-wide rather than per engine; `docs/logging.md` states that limit.

- A logger passed to `createHalEngine` receives the package's own log lines ([validated by: delivers the package's own log lines to a supplied logger](../../src/config.test.ts#L63)).
- Supplying none leaves the built-in console logger in place ([validated by: leaves an already-supplied logger in place when the config names none](../../src/config.test.ts#L76)).
- `setLogger` sends lines to the supplied implementation instead of the console, and the console receives nothing ([validated by: sends lines to a supplied logger instead of the console](../../src/shared/logger.test.ts#L158)).
- Calling `setLogger` with nothing restores the built-in one ([validated by: restores the built-in console logger when called with nothing](../../src/shared/logger.test.ts#L177)).
- Handing it the package's own `log` object is the same as handing it nothing. `log` delegates to whatever is active, so making it active would have it call itself until the stack ran out, and because that overflow was caught by the same guard that protects the call site, nothing was written and nothing failed; the full configuration example did exactly this ([validated by: treats being handed its own log object as nothing, rather than recursing until no line is written](../../src/shared/logger.test.ts#L188)).

Delegating to a supplied logger initially bypassed both of the built-in emitter's guarantees, because both lived in the emitter rather than in the dispatch above it. The level test and the throw guard now sit in one place, applied before the active logger is called, so they hold whichever logger is installed.

- `LOG_LEVEL` gates a supplied logger exactly as it gates the built-in one ([validated by: is gated by LOG_LEVEL exactly as the built-in logger is](../../src/shared/logger.test.ts#L210)).
- A supplied logger that throws does not propagate into the call site being logged ([validated by: does not let its own throw escape into the call site being logged](../../src/shared/logger.test.ts#L220)).
- The line is written to the console so that it is not lost ([validated by: falls back to the console when it throws, so the line is not lost](../../src/shared/logger.test.ts#L233)).
- A logger that writes and then throws therefore emits twice, once itself and once to the console. The fallback guarantees a line is never lost, not that it appears once; a consumer who prefers the opposite catches inside their own implementation.
- A logger missing one of the four methods fails the same way rather than at an arbitrary later call ([validated by: survives a partially implemented logger rather than failing at an arbitrary later call](../../src/shared/logger.test.ts#L250)).
- A value whose `toString` throws still produces a line ([validated by: still writes a line rather than throwing out of the emitter](../../src/shared/logger.test.ts#L263)).
- `setLogger` is exported from `src/index.ts`, so a consumer can put the built-in logger back; without it the process-global swap had no documented way out.
- `createHalEngine` installs a logger only when the config names one, so a second engine naming none keeps the first one's logger ([validated by: leaves an already-supplied logger in place when the config names none](../../src/config.test.ts#L76)).
- No call site changes: every `log.*` call under `src/` kept its category, message, level and data. There were 28 when this was written and 29 once T015 added the hook-failure line; later work added more, so the number is a record of the change rather than a count of the tree.
- A new `docs/logging.md` covers the key set, the level mapping, the stream split, and which fields can identify a person.

### The mock factory forwards its configuration

`createProvider` is a five-arm switch. Four arms forward `config`; the `mock` arm at `src/providers/providerFactory.ts:34` calls `createMockProvider()` with no arguments, dropping the only field `MockConfig` has. The same config object therefore behaves differently through `createProvider` than through `createMockProvider` — two public exports, one of which honours the caller.

Measured before the fix, one config object produced `{"status":"","count":0}` through `createProvider` and `{"status":"configured","count":42}` through `createMockProvider`.

- The `mock` arm forwards `config` like the other four, so a configured structured response survives the factory ([validated by: forwards MockConfig, so a configured structured response survives the factory](../../src/providers/providerFactory.test.ts#L17)).
- A message the map does not name still falls back to schema-shaped defaults ([validated by: falls back to schema-shaped defaults for a message the map does not name](../../src/providers/providerFactory.test.ts#L24)).
- `createMockProvider`'s parameter stays optional - making it required would break the existing no-argument call sites to guard against a typo the new test catches - so a `mock` config carrying no map is accepted ([validated by: accepts a mock config carrying no map at all](../../src/providers/providerFactory.test.ts#L31)).
- Every arm returns a provider implementing both `AIProvider` methods ([validated by: dispatches each arm to a provider satisfying the full AIProvider interface](../../src/providers/providerFactory.test.ts#L37)).
- The `mock` arm reaches the mock rather than a neighbouring arm ([validated by: routes the mock arm to the mock, not to a neighbouring arm](../../src/providers/providerFactory.test.ts#L52)).
- The mock is the only provider the tarball smoke test can exercise without a cloud account, which is why this lands before the smoke fixture is written.
- `structuredResponses` is honoured by both entry points, but it configures `generateStructured`, and nothing inside `createHalEngine` ever calls that method — the orchestrator only calls `sendMessage`. A consumer configuring the map through `createHalEngine` should learn that from the documentation rather than from a debugger.

### One wire name for the client frame

`src/transport/ws/validation.ts` accepted both `user_message` and `send_message` and normalised both to `user_message`, so the exported `IncomingMessage` union could never contain the second name. Five documents disagreed with the types and with each other: the protocol spec listed the alias as accepted and then used it as the name in its own reconnection rule, the quick start sent it, and the add-a-message-type how-to reproduced the two-case switch so anyone following it copied the alias forward.

The alias is removed. `user_message` is the only wire name, which is what the exported types have always said.

- `send_message` is rejected like any other unknown type, so a client still sending it gets an `error` frame carrying `INVALID_MESSAGE` rather than a silent acceptance ([validated by: rejects send_message, which is no longer a wire name](../../src/transport/ws/validation.test.ts#L12)).
- `user_message` is accepted and returns exactly the frame `UserMessagePayload` describes ([validated by: accepts user_message and returns the frame the exported union describes](../../src/transport/ws/validation.test.ts#L6)).
- No deprecation window was needed. This package has never been published, so there were no registry consumers to deprecate for, and the window would only ever have been cheap before the first release.

### Two config options that were declared and dropped

`createHalEngine` forwarded `maxToolRounds` and `contextConfig` to the orchestrator it builds and stopped there, and passed no port to the server at all. Both options are declared on `HalEngineConfig`, both are documented, and neither did anything - the third and fourth instances of the same seam after `onConnect` and the `send_message` alias.

- `orchestrator.hooks` is declared and forwarded, so a hook passed through the factory fires ([validated by: forwards an orchestrator hook, so one passed through the config actually fires](../../src/config.test.ts#L17)).
- `transport.port` reaches the server, and the resolution order is the `start(port)` argument, then `transport.port`, then `PORT`, then `8086` ([validated by: forwards transport.port, so the server listens where the config said](../../src/config.test.ts#L34)).
- An explicit `start(port)` still wins over the configured one ([validated by: lets an explicit start(port) win over the configured one](../../src/config.test.ts#L45)).
- The started line logs the bound port rather than the requested one, which is what a configured `0` makes visible.
- A port that cannot be bound rejects the promise `start()` returned, rather than surfacing as an unhandled `error` event that ends the process ([validated by: rejects instead of taking the process down with an unhandled error event](../../src/config.test.ts#L94)).

Removing that listener once `listen` succeeded left the running server with none, and an `EventEmitter` with no `error` listener throws - so a socket error on a started server ended the process. A persistent listener replaces it, and its lifetime is the part worth stating: it is removed before each bind attempt, and never on `stop()`.

- An error on a running server is reported rather than ending the process ([validated by: is reported rather than ending the process](../../src/transport/createServer.test.ts#L83)).
- Restarting does not accumulate listeners ([validated by: leaves exactly one listener behind, however many times the server is restarted](../../src/transport/createServer.test.ts#L92)).
- The listener survives `stop()`, because an error arriving with no handler ends the process whether or not the server is running ([validated by: is still reported after stop, because an error with no handler ends the process](../../src/transport/createServer.test.ts#L103)).
- A bind failure is not reported as a running server's error: the stale listener is removed before each attempt, so a refused `start()` rejects and logs nothing ([validated by: is not reported for a start that was cleanly refused, because nothing was running](../../src/transport/createServer.test.ts#L112)).
- A second `start()` on a running server is refused before the handlers are touched, so the running server keeps its handler. Node's `listen` throws on a listening server, and the swap above had already removed the persistent listener by then, leaving the next socket error unhandled ([validated by: refuses a second start without stripping the running server of its handler](../../src/transport/createServer.test.ts#L125)).
- `transport.port` resolves with `??` rather than `||`, so a configured `0` means "let the OS choose a free port" instead of collapsing to the default. `PORT` keeps its `||`, because an environment variable that fails to parse should not silently bind port 0.
- Writing the tests exposed a third defect: `createServer` opened its heartbeat interval at construction, so an engine that was built and never started held the Node event loop open forever. The timer is now `unref`ed - the listening socket is what should keep a process alive.

### A contributor knows which checks are theirs

`CONTRIBUTING.md` states the blocking sequence, the commit format, the layering rule, what the spec header table's `Status` actually tracks, and the changelog gate - each by linking `AGENTS.md` rather than restating it.

- It states that a pull request from a fork runs a reduced set of checks and that this is expected. A fork gets a read-only token and no repository secrets whatever a workflow requests, so CI runs in full while the advisory spec-impact check does not run at all. Without that sentence a contributor reads a missing check as something they broke.
- Writing it found `AGENTS.md`'s pre-commit sequence two gates out of date: it predated `typecheck:example` and `docs:check`, both of which now fail a pull request. The sequence is corrected there and the file links to it, so the two cannot disagree.

### A reporter can reach someone

This package had nowhere for a vulnerability report to arrive. The package is public from the first release whether or not the repository is, so a finder cannot be assumed to have repository access.

- A `SECURITY.md` states the intake channel, the acknowledgement target, the supported versions, a coordinated-disclosure statement, and an explicit in-scope list naming at minimum the transport layer, the tool registry and the provider adapters.
- `README.md` gains a Security section repeating the intake address verbatim, because npm renders `README.md` and nothing else.
- `package.json` carries the address in `bugs`, so it survives into registry metadata.
- The issue-template config carries a security contact link, so a reporter's default path stops being a public issue report.
- The supported-versions table is written for a pre-1.0 package with no maintenance branch, and says that taking a security fix can mean taking a breaking change.
- The intake is `security@re-cinq.com` with a 48-hour acknowledgement target. Two facts belong with it rather than in the policy: the acknowledgement target is a commitment somebody honours at a weekend, and nothing here verifies the mailbox is monitored. Confirm both before the first publish - a policy naming an unread address converts a reporter who would have found you into one who thinks they told you.

## What the published docs say

### The front page

`README.md` is the package's front page on npm. Today it instructs the reader to `npm install hal-engine`, states the licence as ISC, and contradicts itself about the providers within thirteen lines: the Features list calls Vertex a stub and the table below scores it `Full`.

- The quick start matches `example/server.ts`, which is correct today and is the one file nothing type-checks — `tsconfig.json` excludes `example`. A build-time check over `example/**` makes the next drift a red build rather than a broken copy-paste.
- The provider table scores each provider per method rather than per provider. `AIProvider` has two methods, and Bedrock's `generateStructured` throws while Vertex's does not, so two rows currently read identically while one provider does half of what the other does. Each cell reads `Implemented` or the literal thrown string, which is checkable by grep.
- The "switching providers is config-only" claim is qualified: a consumer calling `generateStructured` cannot move from Vertex to Bedrock.
- An Install section above the quick start names the registry specifier as the supported path, and states what the git specifier does differently: it builds `dist` from a checkout via `prepare`, carries no provenance attestation, holds whatever commit the lockfile pinned, and installs under the dependency's key rather than its name — so the existing `"hal-engine": "github:…"` entry keeps resolving silently after the rename, with no failure mode to surface it. Measured, not reasoned: installing the packed tarball under the key `hal-engine` puts a package declaring `@re-cinq/hal-engine` at `node_modules/hal-engine`, where `import 'hal-engine'` loads it and `import '@re-cinq/hal-engine'` fails with `ERR_MODULE_NOT_FOUND`. Following the rename is what breaks, not ignoring it.
- A Configuration section carries the only table in the repository of the environment variables this package actually reads: `CORS_ORIGIN` at `src/transport/createApp.ts:23`, `PORT` at `src/transport/createServer.ts:93`, and `LOG_LEVEL` at `src/shared/logger.ts:12`. Each row names the reading site, what overrides it, and the default. `CORS_ORIGIN` carries one origin only — the value reaches `cors({origin})` unsplit, so a comma-separated list is a single literal matching no browser origin.

### Documented code is generated, not transcribed

Hand transcription produced a wrong frame order, a `PromptBuilderConfig` field name the type never had, an `engine.listen()` that never existed and three config keys nothing reads. Each was found by a person reading carefully. A marker on every fenced block moves that to a gate.

- `scripts/check-doc-blocks.mjs` runs as `docs:check` in CI and `docs:fix` locally. Every fenced `typescript` block in `README.md`, `docs/getting-started.md` and `specs/hal-engine-architecture/spec.md` carries an HTML-comment marker on the line above it.
- A marker names either an exported declaration (`src/types/ai.ts#AIProvider`) or a `#region` span in a file under `example/`, which `typecheck:example` compiles. An unmarked block fails. An opt-out is `none -- reason`, and an empty reason fails too.
- Extraction strips the leading `export` and rewrites `from '../src/index.js'` to the published specifier, which is the one systematic difference between a runnable example and the same code in a document.
- It found drift on its first run: the architecture spec's `OrchestratorHooks` block had `afterSession` in a different position from the declaration, and its `WsAuthenticator` block silently bundled a second interface that the marker could not name. The quick start had lost a comment line the example carries.
- Nine of the fifteen blocks are generated. Six carry a reasoned opt-out: annotated references, a fictional weather API, a Redis store a reader writes. T030 extends the mechanism to the remaining documents.

- The mechanism covers ten documents and 62 blocks: fifteen from the first pass and 47 more across `CLAUDE.md`, `.specify/spec.md`, the three how-tos, and the providers and tool-responses specs. Fifteen are generated from a declaration or an example region; the rest carry a reasoned opt-out naming what the block actually is - an invented type a how-to uses to demonstrate its steps, a before-and-after pair, a provider a reader writes.
- `docs/spikes/**` is excluded by design and the exclusion is written into the script. A spike records what was believed when it was written; regenerating its code would falsify the record that its status block exists to preserve.
- Two defects were predicted to fall out. One did: a complete worked tool imported `../types/ai` from a file the comment places at `src/orchestration/tools/`, which resolves to a directory that has never existed. Two more extensionless relative imports were found in the same sweep, neither of which resolves under NodeNext.
- The other had already been fixed. The documented `ToolExecutor` carries `context?: ToolContext` at both sites, and `ToolContext` carries `userId`, `sessionId`, `workspaceId` and `authHeaders`.

### The guides

- `docs/getting-started.md` documents `PromptBuilderConfig` as `{identity, context?, guidelines?: string[], customInstructions?}` at lines 82, 114 and 115. The shipped interface has three different field names and the fourth is a different type. Under `strict: true` the documented shape does not compile, and a reader who widens past that loses more: the builder reads only the real names, so the rest is silently dropped from the assembled prompt. `specs/hal-engine-architecture/spec.md` was already corrected; this file was not.
- `AWS_REGION` and `GOOGLE_CLOUD_PROJECT` are documented as environment variables and are read by nothing — both are required config fields passed straight to an SDK constructor, so a reader who sets the variable and passes a conflicting config value gets the config value with no warning. The rows are deleted rather than annotated.
- The credential variables the vendor SDKs do read keep their rows, each gaining a sentence naming the construction site and stating that this package reads none of them.
- `specs/hal-engine-providers/spec.md` configured the Vertex examples with `location: 'us-central1'` while every Bedrock example in the repository uses an EU region. `location` is a required, unvalidated string handed to the SDK, so copying the snippet made a cross-border transfer. Both snippets and the test fixture now use `europe-west4`, and the section states what `location` decides and that this package does not validate it.
- The model-id half of the check failed and is discharged by T024. Checked 2026-09-11: five of the seven documented ids were dead. `anthropic.claude-3-sonnet-20240229-v1:0` is past EOL on Bedrock, `anthropic.claude-3-haiku-20240307-v1:0` reached EOL the previous day, `anthropic.claude-sonnet-4-20250514-v1:0` is Legacy with an EOL a month out, `claude-sonnet-4-20250514` is retired on Anthropic's own API, and neither `gemini-1.5-*` id appears in a live Vertex publisher listing. Only `gpt-4o` was still active.
- Bedrock ids gained a shape change as well as a value change. Claude Sonnet 4.5 supports no in-region inference in any region, so a documented `modelId` must carry a geo inference profile prefix - `eu.` here, pairing with the EU region the examples already use.
- Model ids across the repository are checked against what the vendors currently serve. `modelId` is a bare unvalidated string on both working provider configs, so a retired id surfaces as a vendor error on the first call and reads to the consumer as their own credentials being wrong.
- `specs/hal-engine-websocket-protocol/spec.md` § 8.1 is the full-conversation example every consumer reads first, and it shows the thinking entry's commit frame before the tool upsert frame. The shipped code emits them the other way round: a thinking entry commits when the next text segment arrives, and a tool-use chunk commits nothing. A client written from the example waits for a commit that comes later than documented and renders nothing in exactly the window a tool call should fill. Corrected, and pinned: the tool upsert now precedes the thinking commit, and a new test drives the real handler through thinking, tool and answer so the documented sequence is the emitted one. The two were compared programmatically rather than by eye, and match frame for frame.
- §8.1 also gains a statement that commit frames are not emitted in index order, which is the general rule the corrected example is one instance of. A client assuming ascending commits, or that an entry commits before the next opens, mis-renders the exchange.
- §8.3 was not verified. Probing the plain text-tool-text path shows an assistant entry absorbing the text after a tool call as a further delta on the same index rather than opening a new entry, which is not the shape §8.3 draws - but §8.3 is a suppression example reached by a different path, so this is an open question rather than a finding.

### The documents nothing implements

Three documents describe code that exists in no repository, and the harm is retrieval rather than reading: this repository's context is assembled and served to agents, and these files rank high for the questions they appear to answer.

- `specs/hal-engine-architecture/spec.md` § Entry Streaming Protocol was expected to need only confirming, and did not pass. It described the three client functions and said "All three functions return new arrays -- they never mutate state", without naming the server's `appendEntry`, `appendDelta` or `commitEntry` at all - which do the opposite, mutating `session.entries` in place. A reader taking the section as this package's behaviour had it backwards.
- The same section listed three frame types. There are four: `entry_skip` appeared nowhere in the architecture spec, though `src/transport/ws/sender.ts` emits it and the message union declares it. It is the frame a suppressed assistant response produces, and a client that ignores it renders every later entry at the wrong index.
- The section is now two halves - server and wire - with the real signatures, the in-place mutation, the `assistant`/`thinking` role guard on two of the three functions, and all four frames. The asymmetry between the halves is stated rather than left as a contradiction.

- `docs/adding-tool-evaluation.md` was a how-to for a harness that does not exist. It is now `docs/spikes/adding-tool-evaluation.md` with a status block, the body unchanged. Four claims are named as false against 2026-09-11: `yarn` commands in an npm repository, a `scripts/` layout that holds gate tooling instead, three undefined types plus a `createToken()` helper this package has no equivalent of, and a `.gitignore` pattern that is not there - so the ground-truth file it names would be committed with whatever the live API returned.
- Two defects the original survey recorded are not in the text any more: a JWT payload field and a booking-data example. That wording predates a rewrite of the document's examples, and the status block says so rather than asserting defects a reader cannot find.
- The design is not built in this repository and is not scoped here. The status block says that much and no more.
- Three spikes carried no status block, not two: `spike-ai-response-validation.md`, `spike-bedrock-integration.md` and `mcp.md`, together roughly 2,100 lines. Each now opens with a block naming what shipped, what is superseded and what is still open, and the diffs are pure insertions - nothing below a block changed.
- The blocks are anchored in the ADRs rather than in prose. The Converse decision shipped and is ADR-001, accepted; response validation, observability, guardrails and MCP are ADR-002 through ADR-005, all recorded 2026-04-02 and all still `proposed`. That mapping is what separates the one spike whose decision shipped from the three whose designs did not.
- The observability section carries an explicit warning, because it is the top-ranked result for an observability question and specifies CloudWatch alarms and a vendor collector for a single-cloud deployment. This package is provider-agnostic and emits no telemetry at all.

### Documented code blocks are generated, not copied

Hand-copied type blocks drift, and this repository has measured the drift twice: four wrong field names quoted in two documents at once, and two of seven type blocks in the architecture document wrong with nothing able to tell them apart from the five that were right.

- A checker binds every fenced TypeScript block in the documents a consumer reads to either an exported source declaration or a region in a checked file under `example/`, and fails on a mismatch or a missing marker.
- A block that genuinely cannot be checked this way carries a visible, reasoned opt-out rather than being skipped silently.
- Coverage then extends to the remaining documents. Two known defects fall out of that extension: a documented `ToolExecutor` signature missing the parameter that carries `userId`, `sessionId` and `authHeaders` — exactly the argument the per-user-credential extension points exist to deliver — and a complete tool example importing from a path that has never resolved from the location the example names.

## Constraints this repository imposes

These are gates, not preferences. Each one is `error` in the committed lint configuration.

- Every `*.test.ts` file cites a spec statement. Every new test written for this work needs a statement in some spec to cite, written before or with it.
- A spec's `Status` row must match its test-citation coverage. This spec opens at `Draft` and moves to `In Progress` on its first citation and `Shipped` when every testable statement carries one.
- Every markdown link to a repository file must resolve. The renames in this spec — moving a document under `docs/spikes/`, deleting a row — break links elsewhere, and a rename sweep that rewrites a dead link faithfully is exactly the failure mode the rule exists to catch.
- Comments in `src/` are at most one line, JSDoc included. The file-head comments this spec calls for must fit, or the prose belongs here instead.
- The declared layers admit no cross-layer import, and `shared` is stricter than the prose suggests: it may import nothing at all, so a cross-cutting helper that needs `AIError` belongs at the providers-layer root instead.

## Carried elsewhere

- Whether the repository becomes public is [ADR-007](../../adrs/ADR-007-repository-visibility.md), stated generally enough that the next package reads it rather than re-deriving it. It decided the `--provenance` question the release workflow could not be finished without. The trade-off is narrower than it first appears: the built package is public either way, so what visibility decides is the history, the test suite, the examples, and the issue and pull-request record — and exposure covers every commit, not the tip, so it requires a full-history secret scan first.
- Renaming the package breaks any consumer importing the bare specifier `hal-engine`, whether as a value or as a type: a module specifier resolves at compile time either way. Those repairs happen in the consuming project and are not scoped here.
- A session id carried on the WebSocket upgrade request — the change that would let a REST-created chat id reach a socket — is not in this release.
