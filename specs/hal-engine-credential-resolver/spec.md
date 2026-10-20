# The Tool Credential Resolver

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#68 |
| Status | Implemented          |

A consumer can renew the credential a tool round carries, through `resolveAuthHeaders`, and end the turn with a named error and a terminal frame when renewal is impossible.

## Background

The engine captures the caller's credential once, at the WebSocket upgrade, and used it for every tool call of the connection. A token that expires mid-conversation turned every later tool call into a downstream 401, which reached the user as a failed answer with no explanation. The engine cannot see that 401, since a tool's failure is normalised into readable text by design, so the seam is proactive: only the consumer knows whether a credential needs renewing. `resolveAuthHeaders` is a member of `OrchestratorHooks`, so `HalEngineConfig.orchestrator.hooks` reaches it with no further wiring.

## The contract

- `resolveAuthHeaders` is called once per tool round, immediately before that round's tool contexts are built, and each round's tools receive what it resolved for that round ([validated by: hands round 0's call Bearer round-0 and round 1's call Bearer round-1 when the hook answers each round anew](../../src/orchestration/resolveAuthHeaders.test.ts#L63)).
- It is called once for a round however many calls the round makes, and never in a turn that calls no tool ([validated by: is called once for a round of two tool calls and never for a turn with no tool call](../../src/orchestration/resolveAuthHeaders.test.ts#L74)).
- Without the hook, a tool receives the headers captured at the upgrade ([validated by: hands a tool the upgrade's headers when no resolveAuthHeaders is configured](../../src/orchestration/resolveAuthHeaders.test.ts#L85)).
- A resolved value is that round's alone and is never written back, so `session.authHeaders` still holds what the upgrade captured ([validated by: leaves session.authHeaders equal to the upgrade's after a run whose hook resolved Bearer renewed](../../src/orchestration/resolveAuthHeaders.test.ts#L91)).
- Each call receives its own copy of the round's headers, never the session's object, so an executor that rewrites one changes neither the session nor a sibling call in its round ([validated by: keeps a header one call rewrote out of session.authHeaders and out of the next call in the same round](../../src/orchestration/resolveAuthHeaders.test.ts#L99), [validated by: hands each call in a round its own context, signal and copy of authHeaders, none of them the session's own object](../../src/toolDeadline.test.ts#L140)).
- A turn abandoned while the hook runs, its socket closed, runs none of that round's tools and ends without an error ([validated by: runs no tool, and ends without an error, when the turn is abandoned while resolveAuthHeaders runs](../../src/orchestration/resolveAuthHeaders.test.ts#L117)).
- A hook that throws `CredentialExpiredError` ends the turn, over a real connection, with `{type: 'error', code: 'CREDENTIAL_EXPIRED', message}` carrying the error's own message, then `stream_end`, so the client's busy state clears ([validated by: sends error CREDENTIAL_EXPIRED with the hook's own message, then stream_end, over a real connection](../../src/transport/credentialExpired.test.ts#L60)).
- `onError` fires exactly once, with the instance the hook threw, before the error frame is sent ([validated by: fires onError exactly once, with the instance the hook threw, before the error frame is sent](../../src/transport/credentialExpired.test.ts#L73)).
- Any other `Error` the hook throws keeps the generic `SERVER_ERROR` path ([validated by: keeps the SERVER_ERROR path for any other Error the hook throws](../../src/transport/credentialExpired.test.ts#L100)).
- The engine authors no product copy: the message a consumer gives its error appears in no file the engine ships ([validated by: authors no product copy: the message a consumer gave appears in no file the engine ships under src/](../../src/transport/credentialExpired.test.ts#L113)).
- A resolved credential is written to no log line at any level and to no frame ([validated by: writes the resolved credential to no log line at any level and to no frame, though the tool received it](../../src/transport/credentialExpired.test.ts#L119)).

## Rationale

The value is never written back to `session.authHeaders`: nothing else reads it there, a fresh secret written back would become durable once a session is persisted, and it would be shared, mutable state across turns running at once. The resolver's shape is the one a TTL-on-read credential cache already has, resolving on demand; de-duplicating in-flight resolutions and invalidating on failure stay with the consumer, and the engine only asks, once per round.

Copying the headers per call closes an aliasing defect that predates the hook: every call in a round was handed the session's own `authHeaders` object, so any executor could rewrite the credential its siblings and every later round would carry.

**NIS-2.** Article 21 asks for resilience. A credential that cannot be renewed ends the turn with a named code and a terminal frame, instead of a hung socket or a loop of silent 401s the user cannot act on.

**GDPR.** The resolver is a processing step. The credential presented at round N may differ from the one presented at connect; it is held only for that round, in the contexts of its calls, and is never written to the session or to any store.

## Limitations

Only the WebSocket transport maps `CredentialExpiredError`. On `POST {basePath}/chats/:id/messages` it takes the HTTP error handler's generic `500`, since that demo route has no code for it.

Which credential is resolved, and when it needs renewing, is the deployment's decision; the engine never re-runs `auth.ws` mid-connection and never detects a downstream 401.
