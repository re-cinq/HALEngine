# Subprotocol Marker

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#64 |
| Status | Implemented          |

A browser WebSocket cannot set an `Authorization` header, so a client carries its access token in `Sec-WebSocket-Protocol`. The server used to answer with the first offered value, which was the token itself: `ws` wrote it into the 101 response headers, where an ingress log with header capture or a proxy trace picks it up, and kept it as the live `protocol` property of every connected socket. A client now offers the reserved marker `hal.v1` beside its token, and the server answers the marker, so the credential reaches the server in the request and is never a candidate for the response.

## Selection

- `HAL_WS_SUBPROTOCOL` is `'hal.v1'`, exported from `src/transport/ws/subprotocol.ts` and from the package root, and it is the literal the protocol spec and the getting-started client print ([validated by: is the literal the protocol spec and the getting-started client print](../../src/transport/ws/subprotocol.test.ts#L11)).
- The server answers `hal.v1` whenever it is offered, whether before the token or after it ([validated by: answers the marker when it is offered first, never the token beside it](../../src/transport/ws/subprotocol.test.ts#L33), [validated by: answers the marker when it is offered after the token](../../src/transport/ws/subprotocol.test.ts#L37)).
- An offer of nothing is answered with nothing ([validated by: answers nothing for an empty offer](../../src/transport/ws/subprotocol.test.ts#L45)).
- A real upgrade offering `hal.v1, super-secret-token` receives a 101 whose `Sec-WebSocket-Protocol` is exactly `hal.v1`, the token appears in no response header, and the connected socket's `protocol` is `hal.v1`, so no live socket property holds the credential ([validated by: answers a hal.v1 and token offer with hal.v1 alone, and forwards the token as a bearer](../../src/transport/handshake.test.ts#L95)).

## Reading the credential

- The credential is the first offered value that is not the marker, read from the **request** header, in either order ([validated by: reads the token from a marker-first offer](../../src/transport/ws/subprotocol.test.ts#L51), [validated by: reads the token from a token-first offer](../../src/transport/ws/subprotocol.test.ts#L55)).
- It is forwarded to the session as `Bearer <token>` in `authHeaders.authorization`, as before ([validated by: answers a hal.v1 and token offer with hal.v1 alone, and forwards the token as a bearer](../../src/transport/handshake.test.ts#L95)).
- A client offering the marker and two other values gets the first of them, matching the behaviour before the marker ([validated by: reads the first non-marker value when two are offered beside the marker](../../src/transport/ws/subprotocol.test.ts#L59)).
- An offer of only the marker carries no credential, and neither does an upgrade with no subprotocol header ([validated by: reads nothing when only the marker is offered](../../src/transport/ws/subprotocol.test.ts#L67), [validated by: reads nothing when no subprotocol header was sent](../../src/transport/ws/subprotocol.test.ts#L71)).
- A client offering only the marker still connects, and its credential is read from the `Authorization` header when it sends one ([validated by: connects a client offering only the marker, reading its credential from the Authorization header](../../src/transport/handshake.test.ts#L104)).

## Deprecation window

- `0.2.x` is published and tells clients to offer a bare token, so for one MINOR the server still accepts that shape: a bare-token offer is echoed as before, its credential is read as before, and a real bare-token client still connects ([validated by: echoes a bare-token offer, the deprecated shape, for one minor](../../src/transport/ws/subprotocol.test.ts#L41), [validated by: reads a bare token, the deprecated shape](../../src/transport/ws/subprotocol.test.ts#L63), [validated by: still connects a bare-token client for one minor, echoing its offer as before](../../src/transport/handshake.test.ts#L113)).
- Each bare-token handshake logs one warning that names the marker and never the offered value ([validated by: writes no offered value to any log line from connect to close, in either shape](../../src/transport/handshake.test.ts#L122)).
- Refusing to echo anything is not an option in this window or after it: `ws` and Chromium both fail a handshake whose non-empty subprotocol offer is answered with nothing, which is why the fix is a marker and not a smaller response ([validated by: echoes a bare-token offer, the deprecated shape, for one minor](../../src/transport/ws/subprotocol.test.ts#L41)).
- The MINOR after this one stops echoing a bare token: such a client then receives a 101 with no `Sec-WebSocket-Protocol` header, which `ws` and Chromium both fail, so every client must offer `hal.v1` beside its token before upgrading to it ([validated by: echoes a bare-token offer, the deprecated shape, for one minor](../../src/transport/ws/subprotocol.test.ts#L41)).

## Where a credential exists

- **GDPR.** No value offered in `Sec-WebSocket-Protocol` is written to any log line at any level, across connect, a message, and close, for either offer shape ([validated by: writes no offered value to any log line from connect to close, in either shape](../../src/transport/handshake.test.ts#L122)).
- **NIS-2 Article 21, access control.** Every place a credential exists during a connection is listed below, so an operator configuring log redaction has a complete list ([validated by: answers a hal.v1 and token offer with hal.v1 alone, and forwards the token as a bearer](../../src/transport/handshake.test.ts#L95)).

| Where                                                       | What                                                                            | Lifetime                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| Upgrade request headers                                     | `Sec-WebSocket-Protocol`, `Authorization`, `Cookie`, as the client sent them    | the request; any header capture |
| The connected socket's `authHeaders`                        | `authorization` (`Bearer <token>`), `cookie`, `host`                            | the connection                  |
| The session in the `SessionStore` (`authHeaders`)           | the same three values                                                           | until the socket closes         |
| The tool context (`ToolContext.authHeaders`)                | the same three values, passed to every tool executor so it can proxy the caller | each tool call                  |
| The HTTP chat routes' per-request session                   | `authorization` and `cookie` from the HTTP request                              | the request                     |
| During the deprecation window only, for a bare-token client | the 101 response's `Sec-WebSocket-Protocol` and the socket's `protocol`         | the connection                  |

## Out of scope

Which credential wins when the `Authorization` header and the subprotocol disagree (re-cinq/HALEngine#70); which captured headers reach a tool; verifying the handshake in a real browser, since there is no browser in CI; reading a session id from the upgrade request; and removing the deprecated bare-token shape, which is the next MINOR's change.
