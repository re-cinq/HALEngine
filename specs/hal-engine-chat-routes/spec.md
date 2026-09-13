# HAL Engine chat routes

| Field  | Value       |
| ------ | ----------- |
| Issue  | n/a         |
| Status | In Progress |

The HTTP chat routes are the non-streaming counterpart to the WebSocket protocol: `POST /chats` opens a chat, `GET /chats/:id` reads it back, and `POST /chats/:id/messages` adds a turn. Every chat records the id of the user who created it, and one router owns one store, so the only thing standing between two callers is the ownership guard in `authorizedChat`. This spec is about that guard — what it refuses, in what order, and which callers it treats as identified in the first place.

## The guard

`authorizedChat` runs before either `:id` route does its own work, and returns the chat or nothing rather than a boolean.

### Resolution order

- The caller is identified first: `requireUser` answers `401` before any lookup, so an unauthenticated request never learns whether a chat exists.
- The chat is looked up second. An id with no chat is `404 Chat not found` ([validated by: answers 404 for a chat that does not exist](../../src/transport/routes/chats.test.ts#L77)).
- Ownership is checked third. A caller who is not the recorded owner gets `403 Forbidden` and no part of the chat ([validated by: refuses a different user with 403 and no chat content](../../src/transport/routes/chats.test.ts#L68)).
- A caller who is not the owner still sees `404` for an id that does not exist, so ownership never becomes an oracle for which ids are real ([validated by: answers 404 before 403, so a wrong owner cannot probe which ids exist](../../src/transport/routes/chats.test.ts#L85)).
- Owner ids are compared strictly, so numeric `1` and string `"1"` are different users rather than the same one ([validated by: compares owner ids strictly, so numeric 1 and string "1" are different users](../../src/transport/routes/chats.test.ts#L103)).

### When no middleware is configured

`authMiddleware` is optional, and when it is absent there is nothing that could identify a caller, so the routes deny instead of serving every caller as one shared user.

- Creating a chat is refused `401 Unauthorized` ([validated by: refuses to create a chat](../../src/transport/routes/chats.test.ts#L214)).
- Reading a chat is refused the same way ([validated by: refuses to read a chat](../../src/transport/routes/chats.test.ts#L222)).
- A message is refused and the orchestrator is never invoked, so an unauthenticated request costs no model call ([validated by: refuses to post a message, and never reaches the orchestrator](../../src/transport/routes/chats.test.ts#L230)).
- The `401` precedes the chat lookup, so an unauthenticated caller cannot probe which ids exist ([validated by: answers 401 before 404, so an unauthenticated caller cannot probe which chat ids exist](../../src/transport/routes/chats.test.ts#L242)).

### Who counts as authenticated

Configuring middleware is not the same as being identified by it. `requireUser` decides that, on all three routes, before the chat lookup.

- Middleware that runs but attaches no `user` is refused `401`, and the chat it asked for is not revealed ([validated by: refuses a request whose middleware attached no user, without revealing the chat](../../src/transport/routes/chats.test.ts#L94)).
- A `user` carrying no `id` is refused ([validated by: refuses a user carrying no id](../../src/transport/routes/chats.test.ts#L273)).
- A `null` id is refused ([validated by: refuses a null id](../../src/transport/routes/chats.test.ts#L281)).
- An empty-string id is refused ([validated by: refuses an empty-string id](../../src/transport/routes/chats.test.ts#L265)).
- The numeric id `0` is accepted: `id` is `string | number`, so `0` is a legal id even though it is falsy, and the check is by type and emptiness rather than by truthiness ([validated by: accepts the numeric id 0, which is falsy but legal](../../src/transport/routes/chats.test.ts#L256)).
- A refused caller leaves nothing behind - no chat is recorded for it ([validated by: never records a chat for a caller it refused](../../src/transport/routes/chats.test.ts#L289)).

### What a refusal records

An access-control decision nobody can audit is not much of a control, and these routes previously wrote no line at all. The refusal is logged; the request is not. `reason` is one of two fixed strings chosen at the call site, so nothing a caller supplied - a chat id, a query string, a header - reaches the log through it.

- A request refused because no middleware is configured emits exactly one `warn` on category `http` ([validated by: emits exactly one warn on category http when no middleware is configured](../../src/transport/routes/chats.test.ts#L327)).
- A request refused because the middleware attached no usable user emits exactly one ([validated by: emits exactly one warn when the middleware attaches no usable user](../../src/transport/routes/chats.test.ts#L340)).
- Nothing request-derived appears in the emitted data ([validated by: records nothing derived from the request, so a refusal cannot leak what was asked for](../../src/transport/routes/chats.test.ts#L348)).
- An authorised request emits no warning at all, so the line means a refusal rather than traffic ([validated by: says nothing at all when the request is authorised](../../src/transport/routes/chats.test.ts#L356)).

A deployment MUST configure `auth.http` middleware that attaches a `user` with a usable `id`. `AuthenticatedRequest` is exported for writing one, and `HttpAuthMiddleware` is stated in its terms rather than as a bare `RequestHandler`, so the contract is in the type.

## POST /chats

- A created chat is answered `201` with a body carrying exactly `id` and `createdAt`, which is the pair a client destructures ([validated by: answers 201 with exactly an id and a createdAt](../../src/transport/routes/chats.test.ts#L115)).
- The creating user's `workspaceId` is stored on the chat and reaches the orchestrator on the next message, two requests later ([validated by: carries the creating user workspace through to the orchestrator](../../src/transport/routes/chats.test.ts#L127)).

## How the routes are mounted

`createApp` decides whether these routes exist at all, and the guard above decides who reaches them. The two are separable, so they are pinned separately: a deny-by-default that also broke the rest of the app would pass every test in § The guard.

- With no `authMiddleware`, `POST /hal/chats` is refused ([validated by: refuses to create a chat](../../src/transport/createApp.test.ts#L31)).
- Health still answers `200` alongside that refusal ([validated by: still answers health, so a denied chat route is not a broken app](../../src/transport/createApp.test.ts#L38)).
- A path off the base path still answers `404` ([validated by: still answers 404 off the base path](../../src/transport/createApp.test.ts#L44)).
- A supplied middleware is invoked ([validated by: invokes the middleware it was given](../../src/transport/createApp.test.ts#L52)).
- Once it attaches a user, the route is served ([validated by: serves the route once that middleware attaches a user](../../src/transport/createApp.test.ts#L63)).
- The chat routes mount only when a `sessionStore` is supplied; without one the path is `404` ([validated by: mounts no chat routes without a session store](../../src/transport/createApp.test.ts#L91)).

`sessionStore` gates whether the routes mount and nothing more - the routes keep their own `Map`, so the store stays empty however many chats are created through them, and two apps built on one store share nothing.

- The store is still empty after a chat is created ([validated by: leaves the session store empty after a chat is created through it](../../src/transport/createApp.test.ts#L98)).
- Two apps built on one store do not see each other's chats ([validated by: does not share chats between two apps built on one session store](../../src/transport/createApp.test.ts#L111)).

`HttpAuthMiddleware` is stated in terms of what it must produce rather than as a bare `RequestHandler`, so both directions of assignability are pinned: a consumer's existing handler has to fit the option, and ours has to mount on an Express router. Both are compile-time assertions carried by a type annotation - `npm run typecheck` is the gate, not the runtime expectation beside it. The return type is `unknown` rather than `void | Promise<void>` for the first direction's sake: Express declares its handlers `unknown`, and the narrower spelling refused every handler a consumer already had.

- An Express `RequestHandler` is accepted as an `HttpAuthMiddleware` ([validated by: accepts a plain express RequestHandler, which is what a consumer already has](../../src/transport/createApp.test.ts#L75)).
- An `HttpAuthMiddleware` is usable as an Express `RequestHandler` ([validated by: is itself usable as an express RequestHandler, which is how the router mounts it](../../src/transport/createApp.test.ts#L82)).

A chat id from `POST /chats` is not a WebSocket session id. The socket mints its own on each connection and stores that, so neither identifier can be guessed from the other ([validated by: mints a fresh session id per connection rather than reusing one](../../src/transport/ws/connectionHandler.test.ts#L55)).

## GET /chats/:id

Returns the chat's id, messages and creation time to its owner ([validated by: serves the chat to the user who created it](../../src/transport/routes/chats.test.ts#L59)).

## POST /chats/:id/messages

- The owner's message is accepted and answered `201` ([validated by: accepts a message from the user who created the chat](../../src/transport/routes/chats.test.ts#L141)).
- Another user's message is refused, and the orchestrator is never invoked, so a rejected request costs no model call ([validated by: refuses a different user and never reaches the orchestrator](../../src/transport/routes/chats.test.ts#L150)).
- A message to an id with no chat is `404`, by the same lookup-first order ([validated by: answers 404 when the chat a message names does not exist](../../src/transport/routes/chats.test.ts#L164)).
- Ownership is checked before the body is validated, so a wrong owner sending an empty body gets `403` rather than `400` ([validated by: refuses a different user before validating the body, so 403 beats 400](../../src/transport/routes/chats.test.ts#L172)).
- A request no body parser claimed answers `400`, not `500`. Express leaves `req.body` undefined when no parser matched the content type, and destructuring it threw past the guard written for exactly that input ([validated by: answers 400 when no body parser claimed the request, rather than 500](../../src/transport/routes/chats.test.ts#L182)).
- A refused message is not recorded, so the owner's next read shows no trace of it ([validated by: does not record the rejected message in the chat](../../src/transport/routes/chats.test.ts#L191)).

### Personal data

These routes are a demonstration, and what they hold should be read that way. A chat's messages sit in a `Map` in the process, so message content — whatever a caller typed — is retained for the lifetime of the process, with no expiry, no redaction, no export and no deletion route beyond a restart. Nothing is written to disk and nothing is logged: a refusal records a fixed reason and the request itself is never echoed. A deployment that needs retention limits, subject-access or erasure must not build on these routes; it supplies its own, and uses `SessionStore` and `auth.http` to do it.

### Rationale

Refusing before validating is what keeps `400` from leaking. A body-shape error tells the caller the chat exists and that they got as far as validation; answering `403` first tells them only that they may not touch it.

The inert case is deliberate rather than an oversight. `authMiddleware` is optional, and an engine assembled without one has no notion of who is asking, so there is no owner to compare against — which is also why the guard is not a substitute for authentication.

Returning the chat rather than a boolean is the same idea applied to the code: a guard that answers "may I?" leaves the caller free to carry on after a no, and that mistake is invisible in review. A guard that answers with the chat, or with nothing, makes carrying on a type error, so a route that forgets to stop fails to compile rather than serving an unauthorised chat.
