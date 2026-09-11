# HAL Engine on npm

| Field  | Value           |
| ------ | --------------- |
| Issue  | n/a             |
| Status | In Progress     |

This package has never been published. It is `hal-engine@0.1.0`, CommonJS, unlicensed, and reachable only through a git specifier that clones the repository and builds from source. This spec describes what has to become true for `npm install @re-cinq/hal-engine` to resolve from the public registry: the module format it ships, the manifest that describes it, the pipeline that releases it from a `v*` tag without a stored token, and the handful of defects a first public release must not carry — an authentication fallback that opens a chat API, a hook that is declared and never called, a factory arm that drops its configuration, and an optional peer that is not optional. It also covers the documentation, because npm renders `README.md` and nothing else.

The scope is this repository. One decision it depends on — whether the source repository is publicly resolvable, which is what npm provenance requires — is recorded as an ADR here and is a hard blocker on the release workflow.

## The package that ships

### Module format

The package is ESM-only. `package.json` carries `"type": "module"`, and `tsconfig.json` already targets `NodeNext`/`NodeNext` with every relative import in `src/` ending in `.js`, so no import rewriting is needed.

- The five `require()` calls in `src/providers/providerFactory.ts` do not survive, because `require` does not exist under ESM.
- The lazy-load they implement must survive in some form: `createProvider` MUST NOT load a provider SDK for an arm the caller did not select.
- `jest.config.js` uses `module.exports`, which is illegal under `"type": "module"`, and becomes an ESM config with a default export. The suite runs as real ESM under `--experimental-vm-modules` rather than being compiled to CommonJS: an ESM-only package whose tests exercise CJS output would hide the failure class this conversion exists to prevent, and `import.meta` in the provider layer cannot compile to CommonJS at all. Every spawn of jest needs the flag, not only the `test` script.
- The `dev` and `test` scripts both run TypeScript through a CommonJS loader today and need an ESM-compatible answer.

This is a breaking change under AGENTS.md § Breaking Changes and inherits that section's obligations: a migration guide in the pull request and a MINOR bump. The version that carries it is `0.2.0`.

### Optional peers

`@aws-sdk/client-bedrock-runtime` and `@google-cloud/vertexai` are declared optional peers, and exactly one of them behaves like one. `src/index.ts:21` re-exports `createVertexProvider` as a value from a module whose first line statically imports `@google-cloud/vertexai`, so importing the package root loads the Vertex SDK whether or not the caller ever names Vertex.

- Importing the package root MUST NOT require either optional peer to be installed. Measured on the built `dist/`: a bare root import loaded 38 `@google-cloud/vertexai` modules before this change and 0 after, with Bedrock at 0 throughout. The automated form of this check is the tarball smoke test.
- An absent peer MUST fail at provider construction, not at import — the contract `src/providers/bedrock/bedrockProvider.ts` already kept and `createVertexProvider` now matches.
- Both providers route their absent-peer failure through one helper, so the message names the package and its install command rather than surfacing a raw `MODULE_NOT_FOUND` from inside `dist/` ([validated by](../../src/providers/requireOptionalPeer.test.ts#L12)).
- That failure is an `AIError` carrying the code `OPTIONAL_PEER_MISSING`, not a bare module-resolution error ([validated by](../../src/providers/requireOptionalPeer.test.ts#L19)).
- It is not retryable, because installing a package is not a retry ([validated by](../../src/providers/requireOptionalPeer.test.ts#L23)).
- An installed peer is returned unchanged ([validated by](../../src/providers/requireOptionalPeer.test.ts#L8)).
- The helper decides "absent" structurally rather than with `instanceof Error`, because a module loader running in another realm throws an `Error` this one disowns — measured under jest, where `instanceof Error` is `false` for exactly that failure.
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

### Tarball smoke test

Nothing in this repository has ever installed the package from a tarball. A git specifier builds from source and therefore exercises neither the `exports` map, nor `files`, nor the dependency list, nor the emitted `.d.ts` files.

- A committed consumer fixture — its own `package.json`, an ESM entry point, and a TypeScript file that imports the types — installs the packed tarball outside the repository tree and runs.
- It runs with no optional peer installed, which is the specific failure the optional-peer work above prevents.
- It type-checks against the published `.d.ts` files, which import `express`, `http` and `ws` while their `@types/*` packages are all devDependencies.
- It runs as its own CI job and again in the publish workflow before `npm publish`.

### Release workflow

The repository has zero git tags. `0.1.0` was never tagged and never published, so there is no existing convention to fit around.

- A `v*` tag triggers one publish job.
- The job authenticates with npm Trusted Publishing over OIDC. No `NPM_TOKEN` secret exists in the repository after bootstrap.
- A guard fails the job when the tag and the committed `package.json` version disagree. It is a committed script rather than an inline step, so a developer can run it before pushing a tag they cannot un-push.
- Whether the publish carries `--provenance` is decided by the repository-visibility ADR. npm generates provenance only from a public source repository, and refuses it for any repository an unauthenticated client cannot read.
- AGENTS.md gains a § Releasing section covering the four human steps: bump in the pull request, merge, tag `vX.Y.Z` on `main`, push the tag.

### Release notes

AGENTS.md line 330 claims "CHANGELOG implied by conventional commits". Nothing implements it, and the history could not carry it: of 20 commits on `main` at the time that claim was measured, 5 carried a conventional type.

- A hand-written `CHANGELOG.md` on Keep a Changelog 1.1.0 replaces the claim, `## [Unreleased]` first.
- Its audience is a consumer reading npm and GitHub Releases, not this repository's commit log. The ESM conversion and the scope rename each need to reach that reader in a sentence.
- AGENTS.md line 330 is replaced by the real rule rather than supplemented by a new contributing document.
- A CI step fails when a diff touching `src/` does not touch `CHANGELOG.md`, with a label as the deliberate escape hatch for changes that are not user-visible.

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

### `onConnect` is called

`HalEngineConfig.onConnect` is declared at `src/config.ts:37`, forwarded at `:75`, and declared again on `HalServerOptions` at `src/transport/createServer.ts:20` — and then omitted from the `deps` object at `:50` that the connection handler receives. Its sibling `onDisconnect` is forwarded on the adjacent line and is invoked on every close, so a consumer sees half the pair work. Four committed documents say both work.

- `onConnect` is invoked on every accepted connection, after the `connected` frame is sent and before the first inbound message is processed.
- It is not invoked inline in the `connection` listener: a synchronous throw there corrupts an already-upgraded socket. It runs through a deferred continuation instead.
- Both hooks widen to `void | Promise<void>` and are documented as fire-and-forget. The engine never awaits either.
- Both route through one helper that logs and swallows a throw or a rejection. `onDisconnect` today is invoked bare inside a `close` listener, where an unhandled rejection ends the process under Node's defaults.

### Log lines carry a severity

`src/shared/logger.ts:21` is the only `console.*` call under `src/`, and it is `console.log` for all four levels. Every line is unstructured text, so `log.error` is indistinguishable from `log.info` to anything reading the stream: a deployment filtering on severity matches nothing and stays green through an outage. This is public surface — `src/index.ts` exports both `log` and the `Logger` type.

- `emit` writes one JSON object per line.
- The key set is `severity` as the uppercase level name, `message`, an ISO-8601 `timestamp`, plus this package's own `category` and `data`.
- `ERROR` goes to `console.error`; the other three levels go to `console.log`.
- No call site changes. All 28 `log.*` calls under `src/` keep their category, message, level and data.
- A new `docs/logging.md` covers the key set, the level mapping, the stream split, and which fields can identify a person.

### The mock factory forwards its configuration

`createProvider` is a five-arm switch. Four arms forward `config`; the `mock` arm at `src/providers/providerFactory.ts:34` calls `createMockProvider()` with no arguments, dropping the only field `MockConfig` has. The same config object therefore behaves differently through `createProvider` than through `createMockProvider` — two public exports, one of which honours the caller.

Measured before the fix, one config object produced `{"status":"","count":0}` through `createProvider` and `{"status":"configured","count":42}` through `createMockProvider`.

- The `mock` arm forwards `config` like the other four, so a configured structured response survives the factory ([validated by](../../src/providers/providerFactory.test.ts#L17)).
- A message the map does not name still falls back to schema-shaped defaults ([validated by](../../src/providers/providerFactory.test.ts#L24)).
- `createMockProvider`'s parameter stays optional - making it required would break the existing no-argument call sites to guard against a typo the new test catches - so a `mock` config carrying no map is accepted ([validated by](../../src/providers/providerFactory.test.ts#L31)).
- Every arm returns a provider implementing both `AIProvider` methods ([validated by](../../src/providers/providerFactory.test.ts#L37)).
- The `mock` arm reaches the mock rather than a neighbouring arm ([validated by](../../src/providers/providerFactory.test.ts#L52)).
- The mock is the only provider the tarball smoke test can exercise without a cloud account, which is why this lands before the smoke fixture is written.
- `structuredResponses` is honoured by both entry points, but it configures `generateStructured`, and nothing inside `createHalEngine` ever calls that method — the orchestrator only calls `sendMessage`. A consumer configuring the map through `createHalEngine` should learn that from the documentation rather than from a debugger.

### One wire name for the client frame

`src/transport/ws/validation.ts:31` accepts both `user_message` and `send_message` and normalises both to `user_message`, so the exported `IncomingMessage` union can never contain the second name. `specs/hal-engine-websocket-protocol/spec.md` currently documents the alias as supported, which resolves the inconsistency in the opposite direction from the earlier decision.

This is the one item in this spec where the resolution is genuinely open, and it is recorded here as a decision to take rather than a change to make. Whichever way it goes, the code, the exported types and the protocol spec MUST agree, and the alias MUST NOT be removed from the wire without a deprecation window if any client is sending it.

### A reporter can reach someone

Neither this package nor its sibling has anywhere for a vulnerability report to arrive. The package is public from the first release whether or not the repository is, so a finder cannot be assumed to have repository access.

- A `SECURITY.md` states the intake channel, the acknowledgement target, the supported versions, a coordinated-disclosure statement, and an explicit in-scope list naming at minimum the transport layer, the tool registry and the provider adapters.
- `README.md` gains a Security section repeating the intake address verbatim, because npm renders `README.md` and nothing else.
- `package.json` carries the address in `bugs`, so it survives into registry metadata.
- The issue-template config carries a security contact link, so a reporter's default path stops being a public issue report.
- The supported-versions table is written for a pre-1.0 package with no maintenance branch.

## What the published docs say

### The front page

`README.md` is the package's front page on npm. Today it instructs the reader to `npm install hal-engine`, states the licence as ISC, and contradicts itself about the providers within thirteen lines: the Features list calls Vertex a stub and the table below scores it `Full`.

- The quick start matches `example/server.ts`, which is correct today and is the one file nothing type-checks — `tsconfig.json` excludes `example`. A build-time check over `example/**` makes the next drift a red build rather than a broken copy-paste.
- The provider table scores each provider per method rather than per provider. `AIProvider` has two methods, and Bedrock's `generateStructured` throws while Vertex's does not, so two rows currently read identically while one provider does half of what the other does. Each cell reads `Implemented` or the literal thrown string, which is checkable by grep.
- The "switching providers is config-only" claim is qualified: a consumer calling `generateStructured` cannot move from Vertex to Bedrock.
- An Install section above the quick start names the registry specifier as the supported path, and states what the git specifier does differently: it builds `dist` from a checkout via `prepare`, carries no provenance attestation, holds whatever commit the lockfile pinned, and installs under the dependency's key rather than its name — so the existing `"hal-engine": "github:…"` entry keeps resolving silently after the rename, with no failure mode to surface it.
- A Configuration section carries the only table in the repository of the environment variables this package actually reads: `CORS_ORIGIN` at `src/transport/createApp.ts:23`, `PORT` at `src/transport/createServer.ts:87`, and `LOG_LEVEL` at `src/shared/logger.ts:12`. Each row names the reading site, what overrides it, and the default. `CORS_ORIGIN` carries one origin only — the value reaches `cors({origin})` unsplit, so a comma-separated list is a single literal matching no browser origin.

### The guides

- `docs/getting-started.md` documents `PromptBuilderConfig` as `{identity, context?, guidelines?: string[], customInstructions?}` at lines 82, 114 and 115. The shipped interface has three different field names and the fourth is a different type. Under `strict: true` the documented shape does not compile, and a reader who widens past that loses more: the builder reads only the real names, so the rest is silently dropped from the assembled prompt. `specs/hal-engine-architecture/spec.md` was already corrected; this file was not.
- `AWS_REGION` and `GOOGLE_CLOUD_PROJECT` are documented as environment variables and are read by nothing — both are required config fields passed straight to an SDK constructor, so a reader who sets the variable and passes a conflicting config value gets the config value with no warning. The rows are deleted rather than annotated.
- The credential variables the vendor SDKs do read keep their rows, each gaining a sentence naming the construction site and stating that this package reads none of them.
- `specs/hal-engine-providers/spec.md` configures the Vertex examples with `location: 'us-central1'` at lines 86 and 110 while every Bedrock example in the repository uses an EU region. `location` is a required, unvalidated string handed to the SDK, so copying the snippet makes a cross-border transfer. Both become an EU region, the same change reaches the test fixture at `src/providers/vertex/vertexProvider.test.ts:26`, and the section gains a sentence on what `location` decides and that this package does not validate it.
- Model ids across the repository are checked against what the vendors currently serve. `modelId` is a bare unvalidated string on both working provider configs, so a retired id surfaces as a vendor error on the first call and reads to the consumer as their own credentials being wrong.
- `specs/hal-engine-websocket-protocol/spec.md` § 8.1 is the full-conversation example every consumer reads first, and it shows the thinking entry's commit frame before the tool upsert frame. The shipped code emits them the other way round: a thinking entry commits when the next text segment arrives, and a tool-use chunk commits nothing. A client written from the example waits for a commit that comes later than documented and renders nothing in exactly the window a tool call should fill.

### The documents nothing implements

Three documents describe code that exists in no repository, and the harm is retrieval rather than reading: this repository's context is assembled and served to agents, and these files rank high for the questions they appear to answer.

- `docs/adding-tool-evaluation.md` is a how-to for a harness that does not exist. It instructs the reader to create scripts, add yarn commands and register a config object; the repository has no yarn lockfile and no matching npm scripts, and one path it names would write unredacted booking data outside any gitignore. It moves under `docs/spikes/` with a status block, and names where the design is actually being built.
- `docs/spikes/spike-ai-response-validation.md` and `docs/spikes/spike-bedrock-integration.md` were moved during the spec restructure but carry no status block. Together they are roughly 1,850 lines describing a deployment nobody built, and they are the top-ranked result for an observability question — handing a reader CloudWatch alarms for a deployment that targets a different cloud. Each gains a status block naming what shipped, what is superseded, and what is still open. Nothing below the block changes.

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

- Whether the repository becomes public is an ADR here, stated generally enough that the next package reads it rather than re-deriving it. The release workflow cannot be finished until it lands, because it decides whether the publish carries `--provenance`. The trade-off is narrower than it first appears: the built package is public either way, so what visibility decides is the history, the test suite, the examples, and the issue and pull-request record — and exposure covers every commit, not the tip, so it requires a full-history secret scan first.
- Renaming the package breaks any consumer importing the bare specifier `hal-engine`, whether as a value or as a type: a module specifier resolves at compile time either way. Those repairs happen in the consuming project and are not scoped here.
- A session id carried on the WebSocket upgrade request — the change that would let a REST-created chat id reach a socket — is not in this release.
