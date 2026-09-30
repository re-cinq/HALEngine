# Subprotocol Marker

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#64, #103 |
| Status | Implemented          |

A browser WebSocket cannot set an `Authorization` header, so a client carries its access token in `Sec-WebSocket-Protocol`. The server used to answer with the first offered value, which was the token itself: `ws` wrote it into the 101 response headers, where an ingress log with header capture or a proxy trace picks it up, and kept it as the live `protocol` property of every connected socket. A client now offers the reserved marker `hal.v1` beside its token, and the server answers the marker, so the credential reaches the server in the request and is never a candidate for the response.

## Selection

- `HAL_WS_SUBPROTOCOL` is `'hal.v1'`, exported from `src/transport/ws/subprotocol.ts` and from the package root, and it is the literal the protocol spec and the getting-started client print ([validated by: is the literal the protocol spec and the getting-started client print](../../src/transport/ws/subprotocol.test.ts#L10)).
- The server answers `hal.v1` whenever it is offered, whether before the token or after it ([validated by: answers the marker when it is offered first, never the token beside it](../../src/transport/ws/subprotocol.test.ts#L23), [validated by: answers the marker when it is offered after the token](../../src/transport/ws/subprotocol.test.ts#L27)).
- An offer of nothing is answered with nothing ([validated by: answers nothing for an empty offer](../../src/transport/ws/subprotocol.test.ts#L35)).
- A real upgrade offering `hal.v1, super-secret-token` receives a 101 whose `Sec-WebSocket-Protocol` is exactly `hal.v1`, the token appears in no response header, and the connected socket's `protocol` is `hal.v1`, so no live socket property holds the credential ([validated by: answers a hal.v1 and token offer with hal.v1 alone, and forwards the token as a bearer](../../src/transport/handshake.test.ts#L117)).

## Reading the credential

- The credential is the first offered value that is not the marker, read from the **request** header, in either order ([validated by: reads the token from a marker-first offer](../../src/transport/ws/subprotocol.test.ts#L41), [validated by: reads the token from a token-first offer](../../src/transport/ws/subprotocol.test.ts#L45)).
- It is forwarded to the session as `Bearer <token>` in `authHeaders.authorization`, as before ([validated by: answers a hal.v1 and token offer with hal.v1 alone, and forwards the token as a bearer](../../src/transport/handshake.test.ts#L117)).
- A client offering the marker and two other values gets the first of them, matching the behaviour before the marker ([validated by: reads the first non-marker value when two are offered beside the marker](../../src/transport/ws/subprotocol.test.ts#L49)).
- A bare token offered without the marker carries no credential, so it cannot authenticate a connection its client is about to fail ([validated by: reads nothing from a bare token offered without the marker](../../src/transport/ws/subprotocol.test.ts#L53)).
- An offer of only the marker carries no credential, and neither does an upgrade with no subprotocol header ([validated by: reads nothing when only the marker is offered](../../src/transport/ws/subprotocol.test.ts#L57), [validated by: reads nothing when no subprotocol header was sent](../../src/transport/ws/subprotocol.test.ts#L61)).
- A client offering only the marker still connects, and its credential is read from the `Authorization` header when it sends one ([validated by: connects a client offering only the marker, reading its credential from the Authorization header](../../src/transport/handshake.test.ts#L126)).
- `credentialFromSubprotocol` is exported from the package root beside the marker, so a consumer's `WsAuthenticator` reads the credential the way the engine does rather than taking the first offered value, which is now the marker; the getting-started, README and `example/` authenticators use it ([validated by: exports the hal.v1 marker with the reader a WsAuthenticator uses](../../src/index.test.ts#L5)).

## Bare-token offers

- `0.2.x` documented a bare-token offer, which `0.3.x` and `0.4.x` still echoed for one MINOR; since then an offer without the marker is answered with no subprotocol and logs no deprecation warning ([validated by: answers nothing for a bare token offered without the marker](../../src/transport/ws/subprotocol.test.ts#L31)).
- A real bare-token client receives a 101 with no `Sec-WebSocket-Protocol` header and fails the handshake itself, as `ws` and Chromium both do for a non-empty offer answered with nothing, and the token appears in no response header, so every client must offer `hal.v1` beside its token ([validated by: answers a bare-token offer with no subprotocol, so the client fails it and no response header holds the token](../../src/transport/handshake.test.ts#L135)).

## Where a credential exists

- **GDPR.** No value offered in `Sec-WebSocket-Protocol` is written to any log line at any level, across connect, a message, and close, for either offer shape ([validated by: writes no offered value to any log line from connect to close, in either shape](../../src/transport/handshake.test.ts#L143)).
- **NIS-2 Article 21, access control.** Every place a credential exists during a connection is listed below, so an operator configuring log redaction has a complete list ([validated by: answers a hal.v1 and token offer with hal.v1 alone, and forwards the token as a bearer](../../src/transport/handshake.test.ts#L117)).

| Where                                                       | What                                                                            | Lifetime                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| Upgrade request headers                                     | `Sec-WebSocket-Protocol`, `Authorization`, `Cookie`, as the client sent them    | the request; any header capture |
| The connected socket's `authHeaders`                        | `authorization` (`Bearer <token>`), `cookie`, `host`                            | the connection                  |
| The session in the `SessionStore` (`authHeaders`)           | the same three values                                                           | until the socket closes         |
| The tool context (`ToolContext.authHeaders`)                | the same three values, passed to every tool executor so it can proxy the caller | each tool call                  |
| The HTTP chat routes' per-request session                   | `authorization` and `cookie` from the HTTP request                              | the request                     |

## Out of scope

Which credential wins when the `Authorization` header and the subprotocol disagree (re-cinq/HALEngine#70); which captured headers reach a tool; verifying the handshake in a real browser, since there is no browser in CI; and reading a session id from the upgrade request.
