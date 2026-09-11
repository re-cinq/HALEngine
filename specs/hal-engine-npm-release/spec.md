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

`tsconfig.build.json` also turns `declarationMap` and `sourceMap` off, which the root config leaves on for local work. `files` is `["dist"]`, so a published map named a `../src/*.ts` that the tarball did not carry and held no `sourcesContent` — 98 dead maps, half the file list, resolving to nothing in any consumer's debugger. Turning them off rather than adding `src` to `files` keeps the published artifact to what the package runs: measured at the change, 199 files and a 55.6 kB tarball became 101 files and 33.8 kB. A consumer wanting to step through the source has the repository. The publish workflow's pack-list check MUST fail on a `*.map` entry for the same reason it fails on a `*.test.*` one.

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

- A committed consumer fixture under `smoke/` — its own `package.json`, an ESM entry point, a TypeScript file that imports the types, and a `tsconfig.json` — is installed from the packed tarball and run by `scripts/smoke.sh`.
- The install happens in a temp directory **outside** the repository tree. Installed inside it, Node and `tsc` walk up to this repo's own `node_modules` and every missing dependency resolves anyway, so the check passes on a package that would fail for a real consumer.
- Everything is installed in one `npm install`. A later `--no-save` install prunes packages absent from `package.json`, which silently removes the subject and turns the type check into a "cannot find module" false negative — measured while writing T004.
- The fixture asserts that neither optional peer is present, then that the mock provider streams to a `stop` chunk, then that constructing Vertex or Bedrock throws an `AIError` with code `OPTIONAL_PEER_MISSING` naming the missing package.
- It type-checks with `skipLibCheck: false`, so the published `.d.ts` files must compile on their own rather than being waved through. That setting is what surfaced `@types/express`, `@types/node` and `@types/ws` sitting in devDependencies.
- `smoke/` is excluded from `tsconfig.json` and `tsconfig.build.json` the way `example` is, because it compiles against the published package rather than against `src/`. It is outside the jest roots and outside `files`, so it is neither tested in place nor published.
- It runs as its own CI job, and T011 calls it in the publish workflow before `npm publish`.
- The check is load-bearing rather than decorative: reverting the T004 dependency move reproduces 8 `tsc` errors, and restoring the top-level Vertex import from before T002 reproduces `ERR_MODULE_NOT_FOUND` — both caught by this script alone.

### Release workflow

The repository has zero git tags. `0.1.0` was never tagged and never published, so there is no existing convention to fit around.

- A `v*` tag triggers one publish job.
- The job authenticates with npm Trusted Publishing over OIDC. No `NPM_TOKEN` secret exists in the repository after bootstrap.
- A guard fails the job when the tag and the committed `package.json` version disagree. It is a committed script rather than an inline step, so a developer can run it before pushing a tag they cannot un-push.
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

- `createServer` forwards `onConnect` into the `deps` object the connection handler receives, which is the omission that made the hook dead ([validated by](../../src/transport/createServer.test.ts#L39)).
- `onConnect` is invoked once per accepted connection, with the session the socket was given ([validated by](../../src/transport/ws/connectionHandler.test.ts#L43)).
- It is invoked after the `connected` frame is sent, not before ([validated by](../../src/transport/ws/connectionHandler.test.ts#L54)).
- It is not invoked inline in the `connection` listener, where a synchronous throw corrupts an already-upgraded socket. It runs on a microtask, which drains before the loop delivers any inbound frame ([validated by](../../src/transport/ws/connectionHandler.test.ts#L65)).
- Both hooks widen to `void | Promise<void>` and are fire-and-forget. The engine never awaits either, and a hook that rejects does not reach the process ([validated by](../../src/transport/ws/connectionHandler.test.ts#L86)).
- Both route through one helper that logs `{sessionId, error}` and swallows, so a throwing `onConnect` leaves the connection intact ([validated by](../../src/transport/ws/connectionHandler.test.ts#L74)).
- The same helper covers the close path, where a throwing `onDisconnect` would otherwise escape the `close` listener ([validated by](../../src/transport/ws/connectionHandler.test.ts#L116)).
- Either hook may be absent, and a connection without one behaves identically ([validated by](../../src/transport/ws/connectionHandler.test.ts#L94)).
- `onDisconnect` is called with the session id, after the store entry for it is deleted ([validated by](../../src/transport/ws/connectionHandler.test.ts#L105)).
- A rejecting `onDisconnect` is swallowed too, where an unhandled rejection would end the process under Node's defaults ([validated by](../../src/transport/ws/connectionHandler.test.ts#L127)).
- A server configured with neither hook starts and accepts connections unchanged ([validated by](../../src/transport/createServer.test.ts#L50)).

### Log lines carry a severity

`src/shared/logger.ts:21` is the only `console.*` call under `src/`, and it is `console.log` for all four levels. Every line is unstructured text, so `log.error` is indistinguishable from `log.info` to anything reading the stream: a deployment filtering on severity matches nothing and stays green through an outage. This is public surface — `src/index.ts` exports both `log` and the `Logger` type.

- `emit` writes one JSON object per line, parseable and carrying no embedded newline ([validated by](../../src/shared/logger.test.ts#L41)).
- The key set is `severity`, `message`, `timestamp` and `category`, in that order ([validated by](../../src/shared/logger.test.ts#L48)).
- `severity` is the uppercase level name ([validated by](../../src/shared/logger.test.ts#L71)).
- `timestamp` is ISO-8601 UTC ([validated by](../../src/shared/logger.test.ts#L88)).
- A call's fields arrive as `data` rather than spread across the top level, and `data` is absent when the call passed none ([validated by](../../src/shared/logger.test.ts#L54)).
- Nesting them is what makes the key set stable: a field named `severity` cannot overwrite the line's own ([validated by](../../src/shared/logger.test.ts#L64)).
- `ERROR` goes to `console.error`; the other three levels go to `console.log` ([validated by](../../src/shared/logger.test.ts#L80)).
- A level below the `LOG_LEVEL` threshold is dropped before the line is built ([validated by](../../src/shared/logger.test.ts#L98)).
- No call site changes. All 29 `log.*` calls under `src/` keep their category, message, level and data - 28 at the time this was written, plus the hook-failure line T015 added.
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

`src/transport/ws/validation.ts` accepted both `user_message` and `send_message` and normalised both to `user_message`, so the exported `IncomingMessage` union could never contain the second name. Five documents disagreed with the types and with each other: the protocol spec listed the alias as accepted and then used it as the name in its own reconnection rule, the quick start sent it, and the add-a-message-type how-to reproduced the two-case switch so anyone following it copied the alias forward.

The alias is removed. `user_message` is the only wire name, which is what the exported types have always said.

- `send_message` is rejected like any other unknown type, so a client still sending it gets an `error` frame carrying `INVALID_MESSAGE` rather than a silent acceptance ([validated by](../../src/transport/ws/validation.test.ts#L12)).
- `user_message` is accepted and returns exactly the frame `UserMessagePayload` describes ([validated by](../../src/transport/ws/validation.test.ts#L6)).
- No deprecation window was needed. This package has never been published, so there were no registry consumers to deprecate for, and the window would only ever have been cheap before the first release.

### Two config options that were declared and dropped

`createHalEngine` forwarded `maxToolRounds` and `contextConfig` to the orchestrator it builds and stopped there, and passed no port to the server at all. Both options are declared on `HalEngineConfig`, both are documented, and neither did anything - the third and fourth instances of the same seam after `onConnect` and the `send_message` alias.

- `orchestrator.hooks` is declared and forwarded, so a hook passed through the factory fires ([validated by](../../src/config.test.ts#L14)).
- `transport.port` reaches the server, and the resolution order is the `start(port)` argument, then `transport.port`, then `PORT`, then `8086` ([validated by](../../src/config.test.ts#L31)).
- An explicit `start(port)` still wins over the configured one ([validated by](../../src/config.test.ts#L42)).
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
- A Configuration section carries the only table in the repository of the environment variables this package actually reads: `CORS_ORIGIN` at `src/transport/createApp.ts:23`, `PORT` at `src/transport/createServer.ts:87`, and `LOG_LEVEL` at `src/shared/logger.ts:12`. Each row names the reading site, what overrides it, and the default. `CORS_ORIGIN` carries one origin only — the value reaches `cors({origin})` unsplit, so a comma-separated list is a single literal matching no browser origin.

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
