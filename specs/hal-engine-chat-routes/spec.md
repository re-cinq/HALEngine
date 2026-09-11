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
- The chat is looked up second. An id with no chat is `404 Chat not found` ([validated by](../../src/transport/routes/chats.test.ts#L69)).
- Ownership is checked third. A caller who is not the recorded owner gets `403 Forbidden` and no part of the chat ([validated by](../../src/transport/routes/chats.test.ts#L60)).
- A caller who is not the owner still sees `404` for an id that does not exist, so ownership never becomes an oracle for which ids are real ([validated by](../../src/transport/routes/chats.test.ts#L77)).
- Owner ids are compared strictly, so numeric `1` and string `"1"` are different users rather than the same one ([validated by](../../src/transport/routes/chats.test.ts#L95)).

### When no middleware is configured

`authMiddleware` is optional, and when it is absent there is nothing that could identify a caller, so the routes deny instead of serving every caller as one shared user.

- Creating a chat is refused `401 Unauthorized` ([validated by](../../src/transport/routes/chats.test.ts#L168)).
- Reading a chat is refused the same way ([validated by](../../src/transport/routes/chats.test.ts#L176)).
- A message is refused and the orchestrator is never invoked, so an unauthenticated request costs no model call ([validated by](../../src/transport/routes/chats.test.ts#L184)).
- The `401` precedes the chat lookup, so an unauthenticated caller cannot probe which ids exist ([validated by](../../src/transport/routes/chats.test.ts#L196)).

### Who counts as authenticated

Configuring middleware is not the same as being identified by it. `requireUser` decides that, on all three routes, before the chat lookup.

- Middleware that runs but attaches no `user` is refused `401`, and the chat it asked for is not revealed ([validated by](../../src/transport/routes/chats.test.ts#L86)).
- A `user` carrying no `id` is refused ([validated by](../../src/transport/routes/chats.test.ts#L227)).
- A `null` id is refused ([validated by](../../src/transport/routes/chats.test.ts#L235)).
- An empty-string id is refused ([validated by](../../src/transport/routes/chats.test.ts#L219)).
- The numeric id `0` is accepted: `id` is `string | number`, so `0` is a legal id even though it is falsy, and the check is by type and emptiness rather than by truthiness ([validated by](../../src/transport/routes/chats.test.ts#L210)).
- A refused caller leaves nothing behind - no chat is recorded for it ([validated by](../../src/transport/routes/chats.test.ts#L243)).

### What a refusal records

An access-control decision nobody can audit is not much of a control, and these routes previously wrote no line at all. The refusal is logged; the request is not. `reason` is one of two fixed strings chosen at the call site, so nothing a caller supplied - a chat id, a query string, a header - reaches the log through it.

- A request refused because no middleware is configured emits exactly one `warn` on category `http` ([validated by](../../src/transport/routes/chats.test.ts#L280)).
- A request refused because the middleware attached no usable user emits exactly one ([validated by](../../src/transport/routes/chats.test.ts#L293)).
- Nothing request-derived appears in the emitted data ([validated by](../../src/transport/routes/chats.test.ts#L301)).
- An authorised request emits no warning at all, so the line means a refusal rather than traffic ([validated by](../../src/transport/routes/chats.test.ts#L309)).

A deployment MUST configure `auth.http` middleware that attaches a `user` with a usable `id`. `AuthenticatedRequest` is exported for writing one, and `HttpAuthMiddleware` is stated in its terms rather than as a bare `RequestHandler`, so the contract is in the type.

## GET /chats/:id

Returns the chat's id, messages and creation time to its owner ([validated by](../../src/transport/routes/chats.test.ts#L51)).

## POST /chats/:id/messages

- The owner's message is accepted and answered `201` ([validated by](../../src/transport/routes/chats.test.ts#L106)).
- Another user's message is refused, and the orchestrator is never invoked, so a rejected request costs no model call ([validated by](../../src/transport/routes/chats.test.ts#L115)).
- A message to an id with no chat is `404`, by the same lookup-first order ([validated by](../../src/transport/routes/chats.test.ts#L129)).
- Ownership is checked before the body is validated, so a wrong owner sending an empty body gets `403` rather than `400` ([validated by](../../src/transport/routes/chats.test.ts#L137)).
- A refused message is not recorded, so the owner's next read shows no trace of it ([validated by](../../src/transport/routes/chats.test.ts#L146)).

### Rationale

Refusing before validating is what keeps `400` from leaking. A body-shape error tells the caller the chat exists and that they got as far as validation; answering `403` first tells them only that they may not touch it.

The inert case is deliberate rather than an oversight. `authMiddleware` is optional, and an engine assembled without one has no notion of who is asking, so there is no owner to compare against — which is also why the guard is not a substitute for authentication.

Returning the chat rather than a boolean is the same idea applied to the code: a guard that answers "may I?" leaves the caller free to carry on after a no, and that mistake is invisible in review. A guard that answers with the chat, or with nothing, makes carrying on a type error, so a route that forgets to stop fails to compile rather than serving an unauthorised chat.
