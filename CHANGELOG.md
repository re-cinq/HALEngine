# Changelog

All notable changes to `@re-cinq/hal-engine` are documented here.

The format is [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries are written for somebody installing the
package, not for somebody reading this repository's commit log.

## [Unreleased]

First release under the `@re-cinq` scope. Everything below ships together as `0.2.0`; nothing has been
published before it, so there is no upgrade path from `0.1.0` on the registry — only from the git specifier.

### Changed

- The published package carries no source maps. `files` is `["dist"]`, so every `.js.map` and `.d.ts.map`
  named a `../src/*.ts` the tarball did not contain and carried no inlined sources — 98 files that resolved
  to nothing in a debugger. Dropping them halves the file count. Step through the source from a checkout
  of the repository instead.

- The README documents the three environment variables this package actually reads — `CORS_ORIGIN`, `PORT`
  and `LOG_LEVEL` — each with its reading site, what overrides it, and its default. `AWS_REGION` and
  `GOOGLE_CLOUD_PROJECT` are gone from the provider docs: both are config fields, and setting the variable
  while passing a different `region` or `projectId` silently gives you the config value. Vendor credential
  variables are still listed, now stating that this package reads none of them — the vendor SDK does.

- The README now states which install path is supported. The registry specifier is the product; a git
  specifier builds from a checkout, carries no provenance, and pins a commit rather than a version. If you
  install from git under the key `hal-engine`, note that the rename is silent — `import 'hal-engine'` keeps
  working and `import '@re-cinq/hal-engine'` is what fails, because npm installs under the dependency key
  rather than the package name.

- **Log output is JSON, one object per line.** Lines were unstructured text (`[time] [LEVEL] [category] msg`),
  so `log.error` was indistinguishable from `log.info` to anything reading the stream. Each line now carries
  `severity`, `message`, `timestamp` and `category`, with the call site's fields under `data`. `ERROR` goes to
  stderr; every other level goes to stdout. If you parse this output, it has changed shape — see
  [docs/logging.md](docs/logging.md). Supply your own `logger` to keep the old format.

- **Breaking: the package is ESM-only.** `require('@re-cinq/hal-engine')` no longer works. Use
  `import` from an ESM module, or stay on the git specifier until you can. The package declares
  `"type": "module"` and resolves through an `exports` map.
- **Breaking: renamed from `hal-engine` to `@re-cinq/hal-engine`.** Update the specifier in every
  `import` and in `package.json`. A dependency installed from a git specifier resolves under its
  entry **key**, not the package's `name`, so an existing `"hal-engine": "github:…"` entry keeps
  working silently — it will not tell you the package has been renamed.
- An absent optional provider SDK now fails when you construct that provider, not when you import the
  package, and raises an `AIError` with code `OPTIONAL_PEER_MISSING` naming the package and the command
  that installs it, instead of a raw `MODULE_NOT_FOUND` from inside `dist/`.
- Node 22 or newer is required, declared in `engines`.

### Added

- `LICENSE` (Apache-2.0), declared in `package.json`.
- `exports`, `repository`, `engines` and `publishConfig` entries in the manifest.
- `AuthenticatedRequest` is exported from the package root: `Request` plus an optional `user`, for typing
  the `auth.http` middleware you supply. `HttpAuthMiddleware` is stated in its terms rather than as a bare
  Express `RequestHandler`.
- Every published version carries an npm provenance attestation, so you can verify with
  `npm audit signatures` that the tarball was built by this repository's release workflow from the
  commit the version was tagged at, rather than uploaded by whoever held a token.

### Removed

- **Breaking: the `send_message` frame type is gone.** The WebSocket server accepted it as an alias for
  `user_message` and normalised it away. Send `user_message` instead; an alias frame now comes back as an
  `error` with code `INVALID_MESSAGE`. The exported `IncomingMessage` union never contained the alias, so
  TypeScript clients were already writing `user_message` — this affects hand-written JSON frames, including
  the one the old quick start showed.

### Fixed

- `orchestrator.hooks` is reachable through `createHalEngine`. `OrchestratorHooks` was documented but the
  factory forwarded only `maxToolRounds` and `contextConfig`, so every hook was silently dropped. Assembling
  the parts by hand is no longer the only way to use them.
- `transport.port` is honoured. It was declared on the config and never forwarded, so the server always fell
  through to `PORT` or `8086`. Resolution order is now the `start(port)` argument, then `transport.port`,
  then `PORT`, then `8086` — and `transport.port: 0` means "let the OS choose", not `8086`.
- An engine that is constructed but never started no longer keeps the process alive. The WebSocket heartbeat
  timer is `unref`ed, so the listening socket is what holds Node open, as it should be.

- Every documented model id is one the vendor still serves. Six of the seven in the docs and fixtures were
  dead or dying as of 2026-09-11 — two Claude 3 models past or at end-of-life on Bedrock, Claude Sonnet 4
  legacy on Bedrock and retired on Anthropic's own API, and both Gemini 1.5 ids gone from Vertex. `modelId`
  is an unvalidated string, so a retired id reaches you as an error that looks like your credentials are
  wrong. Bedrock examples now carry the `eu.` geo inference profile prefix, which Claude Sonnet 4.5 requires
  because it supports no in-region inference.

- The README provider table scores each provider per method. `AIProvider` has two methods and Bedrock
  implements only one — its `generateStructured` throws while Vertex's works — so two rows previously read
  `Full` while one provider did half of what the other did. Each cell now names `Implemented` or the message
  it throws, and the "switching providers is config-only" claim is qualified: it holds for `sendMessage` and
  not for `generateStructured`, with no compile-time signal either way.

- The README quick start and `docs/getting-started.md` now match the API. Both showed `PromptBuilderConfig`
  fields that do not exist (`guidelines`, `context`, `customInstructions` for `responseGuidelines`,
  `domainContext`, `toolPreamble`), a `ws` authenticator taking a token rather than the upgrade request and
  returning `userId` rather than `id`, and an `engine.listen()` that was never an API. `example/server.ts` is
  type-checked in CI now, and both documents are written against it.
- `docs/getting-started.md` no longer documents `orchestrator.hooks` on `HalEngineConfig`. `createHalEngine`
  forwards only `maxToolRounds` and `contextConfig`, so the hooks were unreachable that way; the guide now
  shows `createChatOrchestrator`, which is where they work.

- `onConnect` is now called. It was declared on the config, forwarded through `createHalEngine`, and then
  dropped before the connection handler ever saw it, so it never fired — while its sibling `onDisconnect`
  worked, which is what made the gap hard to notice. It runs once per accepted connection, after the
  `connected` frame.
- Neither lifecycle hook can take a connection down. Both now return `void | Promise<void>`, are never
  awaited, and route through one helper that logs and swallows a throw or a rejection. A rejecting
  `onDisconnect` previously reached the process as an unhandled rejection, which ends it under Node's
  defaults.

- Importing the package root no longer loads the Google Vertex AI SDK. It previously pulled in 38
  `@google-cloud/vertexai` modules whether or not you used Vertex, so a consumer of the mock or Bedrock
  provider could not install without it.
- Consumers can type-check against the published declarations. `@types/express`, `@types/node` and
  `@types/ws` are runtime dependencies now; the emitted `.d.ts` files import `express`, `http`, `stream`
  and `ws`, so with those packages dev-only a consumer resolved the runtime and then failed to compile.
- `createProvider({type: 'mock', structuredResponses})` now honours `structuredResponses`. It previously
  dropped the configuration, so the same config object behaved differently through `createProvider` than
  through `createMockProvider`. Note that the map configures `generateStructured`, which nothing inside
  `createHalEngine` calls.
- Compiled test files are no longer published in `dist/`.

### Security

- **There is somewhere to report a vulnerability.** `SECURITY.md` states the intake address, a 48-hour
  acknowledgement target, supported versions, coordinated disclosure, and what is in and out of scope. The
  address is in `package.json`'s `bugs`, so `npm view @re-cinq/hal-engine bugs` finds it without repository
  access.
- **Breaking: the HTTP chat routes deny by default.** With no `auth.http` middleware configured,
  `POST /chats`, `GET /chats/:id` and `POST /chats/:id/messages` now answer `401 Unauthorized`. They
  previously served every caller as one shared `anonymous` user, so anyone holding a chat id could read
  and post to it. Configure `auth.http` to keep them reachable.
- **Breaking: the chat routes require an identified user.** Middleware that runs but attaches no `user`,
  or a `user` whose `id` is missing, `null` or `''`, is now refused `401` as well. Ownership is enforced
  rather than skipped: chats are no longer recorded against a shared `anonymous` owner. The numeric id
  `0` is accepted — it is falsy, but `id` is `string | number` and `0` is a legal id.
- Resolved a high-severity advisory in `ws`, a direct runtime dependency. The full dependency audit went
  from 18 advisories (1 critical, 6 high) to 3 (2 moderate, 1 low), none at high or above.

[Unreleased]: https://github.com/re-cinq/HALEngine/commits/main
