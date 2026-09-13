# Security policy

`@re-cinq/hal-engine` is a server framework. It terminates WebSocket connections, executes registered tools with caller-supplied input, and forwards conversation state to third-party model APIs. Its attack surface is a server process handling untrusted input on behalf of somebody else's users, so the defects that matter here are the ones that cross a session boundary, escape the tool sandbox a host thought it had, or move credentials somewhere they were not meant to go.

## Reporting a vulnerability

Do not open a public GitHub issue for a vulnerability. A public report tells an attacker before it tells a maintainer.

Report privately to **security@re-cinq.com**. Include the package version, the provider in use if the defect is provider-specific, and the smallest reproduction you have — a WebSocket frame, a tool definition, or a configuration is worth more than a prose description.

The address is also in this package's `bugs` metadata, so it reaches you from `npm view @re-cinq/hal-engine bugs` without needing to open this repository at all. That is deliberate: a reporter who has only installed the package can find where to send a report without first finding the repository.

The mailbox is monitored by the package maintainers — a role rather than a named individual, so a report does not wait on one person's calendar, and whoever is on it acknowledges.

It accepts plaintext. We publish no key, so do not encrypt: an encrypted report we cannot open is a report that arrives nowhere. Send the smallest reproduction rather than a working exploit, and say plainly if you believe the defect is being exploited.

## What to expect

We aim to acknowledge a report within **48 hours**.

A report that indicates active exploitation is escalated immediately by whichever maintainer acknowledges it, to the re:cinq security contact at the same address, who decides whether a regulatory clock has started. Under NIS-2 an early warning is due within 24 hours of becoming aware of a significant incident, so that decision is made on acknowledgement rather than after triage.

We coordinate disclosure: please give us a reasonable window to ship a fix before publishing details, and we will credit you in the release notes unless you ask us not to.

A fix ships as a new version on npm. There is no advisory feed of our own — the GitHub Security Advisory for the repository is the record.

## Supported versions

This package is pre-1.0 and has no maintenance branches. Only the latest published version receives fixes, and a fix is a forward release rather than a backport.

| Version | Supported |
| ------- | --------- |
| latest `0.x` | Yes |
| any earlier `0.x` | No — upgrade to the latest |

Under semantic versioning a pre-1.0 minor may carry a breaking change, so upgrading to take a security fix can require code changes. Those are described in `CHANGELOG.md` and, for anything breaking, in the release's migration notes.

## In scope

A defect in any of these is in scope, whether or not it needs an unusual configuration to reach:

- **`src/transport/`** — the WebSocket upgrade path, frame validation, the connection and message handlers, and the demo HTTP chat routes. Anything that lets one session read or write another's state, that accepts a frame the protocol forbids, or that bypasses a configured `WsAuthenticator` or `auth.http` middleware.
- **`src/orchestration/tools/`** — the tool registry and executor. Anything that runs a tool the model did not ask for, passes input a tool's schema should have rejected, or leaks a `ToolContext` field across sessions.
- **`src/providers/`** — the Bedrock, Vertex, OpenAI, Anthropic and Mock adapters. Anything that puts credentials, `authHeaders`, or another user's conversation into a provider request, a log line, or an error message.
- **`src/infrastructure/`** — the session, prompt and usage stores, and the thinking-tag parser, where a parsing defect can surface model output as trusted content.
- The published package itself: a tarball carrying something that is not in `dist/`, or a dependency advisory we have not acted on.

## Out of scope

- Vulnerabilities in a consuming application's own `WsAuthenticator`, `auth.http` middleware, `SessionStore` or tool implementations. These are interfaces this package defines and the host implements; we will help you find the right maintainer.
- The demo chat routes used as if they were a product. They are a demo surface backed by an in-process `Map`, documented as such at the head of `src/transport/routes/chats.ts`.
- Model behaviour: a prompt that persuades a model to say something unwanted is not a defect in this package unless it crosses one of the boundaries above.
- Vulnerabilities in a model vendor's SDK or service. Report those to the vendor; tell us too if this package's use of them makes it worse.
- Anything requiring an attacker to already hold the host's cloud credentials or filesystem access.
