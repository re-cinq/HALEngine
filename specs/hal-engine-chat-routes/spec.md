# HAL Engine chat routes

| Field  | Value       |
| ------ | ----------- |
| Issue  | n/a         |
| Status | In Progress |

The HTTP chat routes are the non-streaming counterpart to the WebSocket protocol: `POST /chats` opens a chat, `GET /chats/:id` reads it back, and `POST /chats/:id/messages` adds a turn. Every chat records the id of the user who created it, and one router owns one store, so the only thing standing between two callers is the ownership guard in `authorizedChat`. This spec is about that guard — what it refuses, in what order, and the one configuration in which it does nothing at all.

## The guard

`authorizedChat` runs before either `:id` route does its own work, and returns the chat or nothing rather than a boolean.

### Resolution order

- The chat is looked up first. An id with no chat is `404 Chat not found` ([validated by](../../src/transport/routes/chats.test.ts#L67)).
- Ownership is checked second. A caller who is not the recorded owner gets `403 Forbidden` and no part of the chat ([validated by](../../src/transport/routes/chats.test.ts#L58)).
- A caller who is not the owner still sees `404` for an id that does not exist, so ownership never becomes an oracle for which ids are real ([validated by](../../src/transport/routes/chats.test.ts#L75)).
- Owner ids are compared strictly, so numeric `1` and string `"1"` are different users rather than the same one ([validated by](../../src/transport/routes/chats.test.ts#L93)).

### When the guard does nothing

The guard only refuses a caller it can identify, so a request carrying no `user` — no auth middleware configured, or middleware that attaches nothing — passes through to the chat unchecked ([validated by](../../src/transport/routes/chats.test.ts#L84)).

A deployment that serves more than one user MUST configure `authMiddleware`, because without it any caller holding a chat id can read and post to that chat.

## GET /chats/:id

Returns the chat's id, messages and creation time to its owner ([validated by](../../src/transport/routes/chats.test.ts#L49)).

## POST /chats/:id/messages

- The owner's message is accepted and answered `201` ([validated by](../../src/transport/routes/chats.test.ts#L104)).
- Another user's message is refused, and the orchestrator is never invoked, so a rejected request costs no model call ([validated by](../../src/transport/routes/chats.test.ts#L113)).
- A message to an id with no chat is `404`, by the same lookup-first order ([validated by](../../src/transport/routes/chats.test.ts#L127)).
- Ownership is checked before the body is validated, so a wrong owner sending an empty body gets `403` rather than `400` ([validated by](../../src/transport/routes/chats.test.ts#L135)).
- A refused message is not recorded, so the owner's next read shows no trace of it ([validated by](../../src/transport/routes/chats.test.ts#L144)).

### Rationale

Refusing before validating is what keeps `400` from leaking. A body-shape error tells the caller the chat exists and that they got as far as validation; answering `403` first tells them only that they may not touch it.

The inert case is deliberate rather than an oversight. `authMiddleware` is optional, and an engine assembled without one has no notion of who is asking, so there is no owner to compare against — which is also why the guard is not a substitute for authentication.

Returning the chat rather than a boolean is the same idea applied to the code: a guard that answers "may I?" leaves the caller free to carry on after a no, and that mistake is invisible in review. A guard that answers with the chat, or with nothing, makes carrying on a type error, so a route that forgets to stop fails to compile rather than serving an unauthorised chat.
