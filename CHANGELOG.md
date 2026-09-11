# Changelog

All notable changes to `@re-cinq/hal-engine` are documented here.

The format is [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries are written for somebody installing the
package, not for somebody reading this repository's commit log.

## [Unreleased]

First release under the `@re-cinq` scope. Everything below ships together as `0.2.0`; nothing has been
published before it, so there is no upgrade path from `0.1.0` on the registry — only from the git specifier.

### Changed

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

### Security

- **Breaking: the HTTP chat routes deny by default.** With no `auth.http` middleware configured,
  `POST /chats`, `GET /chats/:id` and `POST /chats/:id/messages` now answer `401 Unauthorized`. They
  previously served every caller as one shared `anonymous` user, so anyone holding a chat id could read
  and post to it. Configure `auth.http` to keep them reachable.
- **Breaking: the chat routes require an identified user.** Middleware that runs but attaches no `user`,
  or a `user` whose `id` is missing, `null` or `''`, is now refused `401` as well. Ownership is enforced
  rather than skipped: chats are no longer recorded against a shared `anonymous` owner. The numeric id
  `0` is accepted — it is falsy, but `id` is `string | number` and `0` is a legal id.

### Fixed

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

- Resolved a high-severity advisory in `ws`, a direct runtime dependency. The full dependency audit went
  from 18 advisories (1 critical, 6 high) to 3 (2 moderate, 1 low), none at high or above.

[Unreleased]: https://github.com/re-cinq/HALEngine/commits/main
