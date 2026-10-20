# The Tool Header Allowlist

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#69 |
| Status | Implemented          |

A deployer chooses which of the caller's `cookie`, `authorization` and forwarded `host` headers reach a tool as `ToolContext.authHeaders`, through `auth.forwardHeaders`, and a header left out is never held at all.

## Background

The engine captures three caller headers, at the WebSocket upgrade and on each REST chat message, and handed all three to every registered tool through `ToolContext.authHeaders`, with no allowlist and no opt-out. A tool that calls a third party therefore received the user's raw session cookie and bearer token whether or not it needed them. That suits one first-party tool whose author owns the credential, and not a published package whose consumer registers tools the model chooses between at runtime, least of all a tool that sends them on to an API outside the deployer's control.

## The contract

- `filterAuthHeaders(headers, allow)` keeps only the allowed headers the caller sent, each under its own key, so `['authorization']` applied to all three leaves exactly `authorization` ([validated by: keeps authorization alone, under exactly one key, when only authorization is allowed from cookie, authorization and host](../../src/transport/authHeaders.test.ts#L10)).
- When that leaves nothing, for an empty allowlist or one naming only headers the caller never sent, it returns `undefined`, never `{}` with undefined-valued keys ([validated by: returns undefined, never an empty object, for an empty allowlist and for one selecting only a cookie the caller never sent](../../src/transport/authHeaders.test.ts#L19)).
- `ForwardableHeader` is `'cookie' | 'authorization' | 'host'`: an allowlist only narrows what the engine captures, so naming any other header fails the type check ([validated by: refuses x-tenant-id at compile time, since an allowlist only narrows the three captured headers](../../src/transport/authHeaders.test.ts#L26)).
- Over a real WebSocket connection presenting all three headers, `forwardHeaders: ['authorization']` hands a tool `authorization` alone, and the cookie and host values appear nowhere in the context it records ([validated by: hands a tool authorization alone over a real socket when forwardHeaders lists only authorization, the cookie and host nowhere in its context](../../src/transport/forwardHeaders.test.ts#L43)).
- `forwardHeaders: []` hands a tool `authHeaders` undefined ([validated by: hands a tool authHeaders undefined over a real socket when forwardHeaders is empty, the default from 0.10.0](../../src/transport/forwardHeaders.test.ts#L54)).
- `POST {basePath}/chats/:id/messages` applies the same filter to the headers of its own request ([validated by: applies the same filter on POST /chats/:id/messages: authorization alone when forwardHeaders lists only authorization](../../src/transport/forwardHeaders.test.ts#L73)).
- `auth.forwardHeaders` on `HalEngineConfig` reaches both capture sites, so a socket's session and a REST turn's session hold the same selection ([validated by: carries auth.forwardHeaders listing only authorization to both capture sites: a socket's session and a REST turn's hold authorization alone](../../src/config.test.ts#L447)).
- The filter runs at capture, upstream of the session store, so a store receives a session that never held an unlisted header and its own round trip is unchanged ([validated by: creates session with options](../../src/infrastructure/stores/inMemorySessionStore.test.ts#L19)).
- Unset, `forwardHeaders` still forwards all three until 0.10.0, and the first engine a process builds warns once, under `auth`, naming `auth.forwardHeaders` and `0.10.0` ([validated by: forwards all three while unset and warns once per process naming auth.forwardHeaders and 0.10.0, keeping a set list, an empty one too, silently](../../src/transport/authHeaders.test.ts#L35), [validated by: still hands a tool all three over a real socket while forwardHeaders is unset, until 0.10.0](../../src/transport/forwardHeaders.test.ts#L63)).
- No header value is written to any log line at any level across a whole connection, even while all three are held ([validated by: writes neither the authorization nor the cookie value to any log line at any level across a whole connection](../../src/transport/forwardHeaders.test.ts#L95)).

## Rationale

**NIS-2.** The old default was a supply-chain exposure in the sense of Article 21: a tool from any source, a third-party package, a vendor SDK wrapped as a tool, or one of many the model picks between, received the user's session cookie and bearer token, and could send them anywhere it called. An allowlist makes forwarding a decision the deployer takes once, for every tool.

**GDPR.** Capturing these headers is a processing step. The engine holds at most `cookie`, `authorization` and the forwarded `host` (`x-forwarded-host`, else `host`), only those `auth.forwardHeaders` lists, on `ChatSession.authHeaders` for the life of the connection: the newest open socket lends them and they are cleared once no socket is left. `MongoSessionStore` never writes them. With `forwardHeaders: []` it holds none.

Filtering happens at capture, not when `ToolContext` is built, because a header filtered downstream would already have been held on a session that a durable, resumable store can read; filtered upstream, it never was.

The type narrows and never widens: capturing a header the engine does not capture today is a different and wider feature. Per-tool granularity is left to userland, where a consumer that wants one tool blind wraps that tool's executor and overrides `authHeaders`; the engine-wide default is the one thing that cannot be built outside the engine.

## Limitations

The default is not yet the one this spec argues for. `0.8.0` was published forwarding all three to every tool, so an unset `forwardHeaders` keeps doing so for one MINOR, with a warning, and forwards none from `0.10.0`. A deployer who sets the list, `[]` included, gets the new behaviour now.
