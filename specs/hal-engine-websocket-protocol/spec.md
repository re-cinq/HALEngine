# WebSocket Protocol Specification

| Field  | Value       |
| ------ | ----------- |
| Issue  | n/a         |
| Status | In Progress |

```text
Protocol:       hal-engine WebSocket Protocol
Version:        1.0
Status:         Active
Created:        2026-02-12
```

Version 1.0 of the hal-engine WebSocket protocol. It covers, among other things, connection establishment, the message envelope used in both directions, the `SessionEntry` objects a conversation is built from, the entry lifecycle that orders them, the tool execution loop, the heartbeat and termination rules that bound a connection, and the protocol's security considerations. The `Status: Active` line in the block above is the protocol version's own status, distinct from the `Status` row of the header table, which tracks this spec's test-citation coverage under the convention in AGENTS.md § Spec Header Table.

## 1. Introduction

This document specifies the WebSocket protocol used for real-time communication between a client and the hal-engine backend. The protocol enables streaming AI responses, tool invocations, and session management over a persistent WebSocket connection.

It specifies both ends, but this repository implements only one. Requirements addressed to the server are implemented here and testable here. Requirements addressed to the client -- the application-level ping cadence in Section 10.2, the reconnection policy in Section 11.3, the index adjustment in Section 5.5 -- are the contract a consumer is expected to meet, and nothing in this repository enforces them.

### 1.1 Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

### 1.2 Transport

All messages are transmitted as UTF-8 encoded JSON over WebSocket (RFC 6455). Each WebSocket text frame contains exactly one JSON object. Binary frames are not used.

## 2. Connection Establishment

### 2.1 Endpoint

The WebSocket endpoint follows this URI pattern:

```text
wss://{host}{basePath}/ws?sessionId={sessionId}
```

Where `{basePath}` is the configurable path prefix (default `/hal`). A first connection has no id to offer and omits the query; a reconnect that wants its conversation back sends the `sessionId` from its previous `connected` frame. For example, with default settings:

```text
wss://example.com/hal/ws
wss://example.com/hal/ws?sessionId=550e8400-e29b-41d4-a716-446655440000
```

The server validates only that the path begins with `{basePath}/ws`. The `sessionId` query parameter is read only when the server enables resume (`transport.resume`), and only if it is 1–128 characters of `[A-Za-z0-9_-]`. It is not a credential: the server rejoins that conversation only if it belongs to the connection's authenticated user, and answers any other id — someone else's, one it never issued, or one its store no longer holds — with a fresh session exactly as if no id had been sent. With `transport.resume.latest`, a connect that sends no id rejoins the user's most recently active conversation instead, unless it sends `?new=1`, which starts a new one. The server never adopts a requested id for a new session. See [the session resume spec](../hal-engine-session-resume/spec.md).

### 2.2 Authentication

Authentication is performed during the WebSocket handshake. A browser WebSocket cannot set an `Authorization` header, so the client MUST offer two subprotocols in the `Sec-WebSocket-Protocol` header: the reserved marker `hal.v1` (exported as `HAL_WS_SUBPROTOCOL`) and the access token, in either order:

```text
GET /hal/ws/abc-123 HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Protocol: hal.v1, <access-token>
```

The server answers `Sec-WebSocket-Protocol: hal.v1` and never echoes the token. It reads the credential from the request header as the first offered value that is not the marker, and forwards it to the session as `Bearer <access-token>`. A client that can set headers MAY offer only the marker and send `Authorization` instead.

A subprotocol is validated client-side as an HTTP token (RFC 7230 `tchar`), so a value carried this way can contain only letters, digits and ``!#$%&'*+-.^_`|~``: a JWT fits, but a padded base64 token (`=`, `/`) cannot use this carrier at all.

A client that offers a bare token without the marker, the shape `0.2.x` documented, is refused: `0.3.x` and `0.4.x` still echoed such an offer for one MINOR, and later releases read no credential from it. An authenticator that reads the credential with `credentialFromSubprotocol` therefore rejects the upgrade with HTTP 401; one that admits the request anyway gets a 101 with no `Sec-WebSocket-Protocol` header, which `ws` and Chromium both fail. Either way every client must offer `hal.v1` beside its token (see [the subprotocol marker spec](../hal-engine-subprotocol-marker/spec.md)).

The server MUST validate the token via the configured `WsAuthenticator` before completing the upgrade. If authentication fails, the server MUST reject the connection with HTTP 401.

No upgrade request can end the server process: the `upgrade` event has nothing above it to catch a throw, so every refusal is an HTTP status instead.

- An upgrade whose `Host` header is missing or empty (RFC 6455 §4.1 requires one), or whose request-target is not a URL, such as `//`, is answered with HTTP 400 ([validated by: answers an empty Host, a missing Host and a // target with 400 instead of throwing out of the upgrade listener](../../src/transport/malformedUpgrade.test.ts#L69)).
- The path check reads the target alone and never throws: a path beginning with `{basePath}/ws` passes, as §2.1 says; any other path, an empty target or `//` fails ([validated by: accepts any path beginning with /hal/ws and refuses another path, an empty target and //, without throwing](../../src/transport/ws/wsPath.test.ts#L4)).
- A `WsAuthenticator` that throws synchronously, rather than returning a rejected promise, is answered with HTTP 500, as a rejection is ([validated by: answers 500 when the authenticator throws synchronously instead of rejecting](../../src/transport/malformedUpgrade.test.ts#L83)).
- A `WsAuthenticator` that throws or rejects is logged at `error` as `authenticator failed` with its error's type alone, never its message, which can carry the credential it was checking ([validated by: logs a throwing or rejecting authenticator by its error type alone, never its message](../../src/transport/malformedUpgrade.test.ts#L93)).
- A `WsAuthenticator` that returns a user directly, not in a promise, is treated like one that resolves to it, rather than failing inside the listener ([validated by: upgrades a request whose authenticator returns a user without a promise](../../src/transport/malformedUpgrade.test.ts#L119)).
- A well-formed upgrade is unaffected ([validated by: still upgrades a well-formed request](../../src/transport/malformedUpgrade.test.ts#L127)).

### 2.3 Session Initialization

Upon successful connection, the server MUST send a `connected` message before any other messages:

```json
{
  "type": "connected",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Connected to HAL Engine",
  "examplePrompts": [
    "What is the weather in Berlin?",
    "Look up the latest stock price for AAPL",
    "Convert 100 miles to kilometers"
  ]
}
```

The `sessionId` is a UUID v4 assigned by the server. It uniquely identifies this session; with resume enabled it outlives the connection and a reconnect can name it. The `examplePrompts` array contains example queries derived from the registered tool definitions, displayed in the client as clickable suggestions.

With resume enabled, the frame also carries `resumed`. On `resumed: true` it carries `entryCount`, and the server then replays the stored conversation before any other frame: one `entry_upsert` per entry at its own index, or an `entry_skip` for an entry a tool suppressed, so the client sees the conversation it saw live. When the connection named an id and was not resumed, the frame also carries `resumeFailure`: `expired` when the caller's own session aged out, `unknown` for every other case. With resume disabled none of these fields is present.

## 3. Message Format

All messages are JSON objects containing a REQUIRED `type` field that identifies the message kind. Additional fields depend on the message type.

```json
{
  "type": "<message_type>",
  ...
}
```

A client receiving a message with an unrecognized `type` SHOULD ignore it, so that additive protocol changes do not break older clients. The server does NOT ignore unknown types: it replies with an `error` carrying code `INVALID_MESSAGE` (Section 5.6).

## 4. Client-to-Server Messages

### 4.1 user_message

Sends a user chat message. `user_message` is the only accepted type: the server previously also took `send_message`, which was removed before the first published release.

```json
{
  "type": "user_message",
  "content": "What is the weather in Berlin?"
}
```

| Field     | Type   | Required | Description                            |
| --------- | ------ | -------- | -------------------------------------- |
| `type`    | string | Yes      | `"user_message"`                       |
| `content` | string | Yes      | Message text                           |

Any other field is ignored, and the validator forwards only the fields the frame defines. In particular the server does not read a `chatId` from this message: the connection already determines the session ([validated by: drops any field the frame does not define, rather than forwarding it](../../src/transport/ws/validation.test.ts#L18)).

Constraints:

- `content` MUST NOT be empty or whitespace-only after trimming.
- `content` MUST NOT exceed 10,000 characters.
- Violation of these constraints results in an `error` response with code `INVALID_MESSAGE`.

One at a time:

- A session processes one `user_message` at a time, in the order the frames arrived: a frame arriving while an earlier one is still running waits, and its answer starts only after the earlier run's `stream_end` ([validated by: answers a second user_message only after the first has sent its stream_end, in the order they arrived](../../src/transport/ws/messageHandler.test.ts#L646)).
- The waiting message's model request therefore holds the earlier answer finished, never one still streaming ([validated by: hands the second run a history whose first answer is finished, never one still streaming](../../src/transport/ws/messageHandler.test.ts#L677)).
- A `ping` is answered at once, even while a run is pending ([validated by: answers a ping at once while a run is pending](../../src/transport/ws/messageHandler.test.ts#L695)).
- A frame that fails validation and is not a `user_message`, such as a malformed `ping`, gets its `INVALID_MESSAGE` at once, even while a run is pending, but a `user_message` that fails validation is answered in turn, its `INVALID_MESSAGE` and `stream_end` after the run in progress, since an `error` frame names no message and would otherwise read as the running answer's ([validated by: answers an invalid ping at once but an invalid user_message in turn, after the run in progress](../../src/transport/ws/messageHandler.test.ts#L708)).
- The reconnect flush (§ 11.3), which sends queued messages in one burst, is therefore safe: they are answered one after another, in the order the user typed them ([validated by: queues three messages sent in one tick before the handler returns, and answers them in that order](../../src/transport/ws/messageHandler.test.ts#L724)).
- A queued message whose socket has closed by the time its turn comes is dropped, neither recorded nor answered, since nobody is left to read the answer and a session whose last socket closed has no credentials left ([validated by: drops a queued message whose socket closed before its turn, without asking the model or recording it](../../src/transport/ws/messageHandler.test.ts#L741)).

### 4.2 ping

Application-level heartbeat. The server MUST respond with a `pong` message echoing the timestamp.

```json
{
  "type": "ping",
  "timestamp": 1705312200000
}
```

| Field       | Type   | Required | Description                       |
| ----------- | ------ | -------- | --------------------------------- |
| `type`      | string | Yes      | `"ping"`                          |
| `timestamp` | number | Yes      | Client timestamp in milliseconds  |

## 5. Server-to-Client Messages

### 5.1 connected

Sent exactly once after a successful handshake. See Section 2.3.

| Field            | Type     | Description                                            |
| ---------------- | -------- | ------------------------------------------------------ |
| `type`           | string   | `"connected"`                                          |
| `sessionId`      | string   | UUID v4 identifying the session                        |
| `message`        | string   | Human-readable greeting                                |
| `examplePrompts` | string[] | Example queries derived from registered tool definitions |
| `resumed`        | boolean  | Present only with resume enabled: whether the requested conversation was rejoined |
| `entryCount`     | number   | Present only when `resumed` is `true`: how many stored entries the replay covers, skipped ones included |
| `resumeFailure`  | string   | Present only when the connection named an id and `resumed` is `false`: `expired` when the caller's own session aged out, `unknown` otherwise. `unknown` deliberately covers both an id the server never issued and one that is not the caller's, so the answer reveals nothing about ids that exist |

### 5.2 entry_upsert

Creates a new entry or replaces an existing entry at the given index. This is the primary mechanism for adding content to the conversation.

```json
{
  "type": "entry_upsert",
  "index": 0,
  "entry": {
    "role": "user",
    "content": "What is the weather in Berlin?",
    "timestamp": "2026-01-15T14:30:00Z"
  }
}
```

| Field   | Type         | Description                            |
| ------- | ------------ | -------------------------------------- |
| `type`  | string       | `"entry_upsert"`                       |
| `index` | number       | Zero-based position in the entry array |
| `entry` | SessionEntry | The entry object (see Section 6)       |

Semantics:

- If `index` equals the current array length, the entry is appended.
- If `index` is within the existing array bounds, the entry at that position is replaced.
- The client MUST NOT assume entries arrive in sequential index order during tool loops.
- A repeat `entry_upsert` at an index the client already holds, carrying an assistant entry with empty `content`, is a **retraction**: the server is withdrawing text it already sent. See Section 5.5.

### 5.3 entry_delta

Appends incremental text to an existing entry's content. Only valid for entries with role `assistant` or `thinking`.

```json
{
  "type": "entry_delta",
  "index": 1,
  "delta": "Berlin is "
}
```

| Field   | Type   | Description                                        |
| ------- | ------ | -------------------------------------------------- |
| `type`  | string | `"entry_delta"`                                    |
| `index` | number | Index of the entry to update                       |
| `delta` | string | Text to concatenate to the entry's `content` field |

Semantics:

- The client MUST concatenate `delta` to `entry.content` at the given index.
- The referenced entry MUST have `isStreaming: true`.
- Deltas for entries with role `user` or `tool` are invalid and SHOULD be ignored.

### 5.4 entry_commit

Marks an entry as finalized. No further `entry_delta` messages will be sent for this index (within the current streaming sequence).

```json
{
  "type": "entry_commit",
  "index": 1
}
```

| Field   | Type   | Description                   |
| ------- | ------ | ----------------------------- |
| `type`  | string | `"entry_commit"`              |
| `index` | number | Index of the entry to commit  |

Semantics:

- The client MUST set `isStreaming` to `false` on the entry at the given index.
- After a commit, the entry's content is considered complete and stable.

### 5.5 entry_skip

Notifies the client that a session entry was created on the server and will never be sent. This happens under output suppression (see [tool-responses.md](../hal-engine-tool-responses/spec.md)): the server keeps the entry so the model retains context, and the client does not need it for display ([validated by: still records a suppressed reply in the session, so history keeps it](../../src/transport/ws/messageHandler.test.ts#L211)).

```json
{
  "type": "entry_skip",
  "index": 3
}
```

| Field   | Type   | Description                                    |
| ------- | ------ | ---------------------------------------------- |
| `type`  | string | `"entry_skip"`                                 |
| `index` | number | Server-side index of the skipped entry         |

Suppression can begin before or after the server has started sending a reply, and the two cases produce different messages. This distinction is the whole of the protocol here:

- An entry **opened while suppression is already active** is announced with `entry_skip` and nothing else: no `entry_upsert`, no `entry_delta`, no `entry_commit` follows it ([validated by: skips rather than upserts a segment opened after suppression](../../src/transport/ws/messageHandler.test.ts#L203)).
- An entry **already sent before suppression began** cannot be skipped, because the client is displaying it. The server retracts it instead, by re-sending `entry_upsert` at the same index with the entry's `content` set to `""`. The client renders an empty assistant entry as nothing, so the text disappears ([validated by: blanks an assistant entry that was already sent](../../src/transport/ws/messageHandler.test.ts#L180)).
- An entry **still streaming when suppression begins** is first committed as streamed so far, with `entry_commit`, and is from then on an entry already sent: an answer is retracted as above, a thought stays as the client saw it, and whatever the model writes next opens a new entry announced with `entry_skip` ([validated by: commits and retracts an answer still open when suppression begins, and skips what follows as a new entry](../../src/transport/ws/messageHandler.test.ts#L267), [validated by: commits a thought still open when suppression begins as the client saw it, and skips what follows](../../src/transport/ws/messageHandler.test.ts#L288)).

#### Limits of retraction

- Only assistant entries are ever retracted; a thinking entry is never blanked, even when it was sent before suppression began ([validated by: never blanks a thinking entry, only assistant ones](../../src/transport/ws/messageHandler.test.ts#L195)).
- Each sent entry is blanked once, so a second suppression in the same stream repeats nothing ([validated by: blanks each sent entry once, so a second suppression repeats nothing](../../src/transport/ws/messageHandler.test.ts#L229)).
- An entry the client only ever saw as `entry_skip` is never retracted, because nothing is displayed to retract ([validated by: does not resurrect an entry the client only ever saw skipped](../../src/transport/ws/messageHandler.test.ts#L221)).

Semantics:

- The client MUST track skipped indices to adjust subsequent `entry_upsert`, `entry_delta`, and `entry_commit` indices. Server indices diverge from the client array when entries are skipped.
- The adjustment formula: for any incoming index, subtract the count of skipped indices that are less than or equal to it. This maps the server index to the correct client array position.
- A retracted entry is NOT a skipped entry and MUST NOT be counted in that adjustment: it still occupies its position in the client array.
- Skipped indices are always monotonically increasing within a session.
- The client MUST reset its tracked skipped indices on disconnect/reconnect.

### 5.6 error

Reports an error condition. The connection remains open unless the error is fatal.

```json
{
  "type": "error",
  "code": "INVALID_MESSAGE",
  "message": "Message content cannot be empty"
}
```

| Field     | Type   | Description              |
| --------- | ------ | ------------------------ |
| `type`    | string | `"error"`                |
| `code`    | string | Machine-readable code    |
| `message` | string | Human-readable detail    |

Defined error codes:

| Code              | Description                                                       |
| ----------------- | ----------------------------------------------------------------- |
| `INVALID_MESSAGE` | Message failed validation (missing fields, empty content, length) |
| `INVALID_FORMAT`  | Message body is not valid JSON                                    |
| `RATE_LIMITED`    | AI provider returned a rate limit error                           |
| `SERVER_ERROR`    | Unexpected server error during message processing                 |

Semantics:

- A message the server cannot parse into a known type is answered with `INVALID_MESSAGE`, and no message stream is started for it ([validated by: rejects an unparseable message and never starts a stream](../../src/transport/ws/messageHandler.test.ts#L71)).
- A rate limit reported by the AI provider is surfaced as `RATE_LIMITED`, which tells the client the same request is worth retrying ([validated by: tells the client to retry when the provider is rate limited](../../src/transport/ws/messageHandler.test.ts#L311)).
- Any other failure raised while processing a message is reported as `SERVER_ERROR` ([validated by: reports any other failure as a server error](../../src/transport/ws/messageHandler.test.ts#L320)).

### 5.7 pong

Response to a client `ping`. The server MUST echo the client's timestamp without modification ([validated by: answers a ping with the timestamp it was given](../../src/transport/ws/messageHandler.test.ts#L81)).

```json
{
  "type": "pong",
  "timestamp": 1705312200000
}
```

| Field       | Type   | Description                             |
| ----------- | ------ | --------------------------------------- |
| `type`      | string | `"pong"`                                |
| `timestamp` | number | Echoed from the client's `ping` message |

### 5.8 stream_end

Signals that the server has finished processing a user message. Sent exactly once for every `user_message` the server receives, after all `entry_commit` messages have been sent, whether the run succeeded or failed.

```json
{
  "type": "stream_end"
}
```

| Field  | Type   | Description      |
| ------ | ------ | ---------------- |
| `type` | string | `"stream_end"`   |

Semantics:

- The server MUST send `stream_end` after every `user_message` it receives, including streams where output was suppressed (see [tool-responses.md](../hal-engine-tool-responses/spec.md)), streams that failed after an `error` frame, and a `user_message` that failed validation ([single-terminal-frame](../hal-engine-single-terminal-frame/spec.md)). The one exception is a turn whose socket closes first: it is abandoned, and nothing more is sent ([abandon-on-close](../hal-engine-abandon-on-close/spec.md)).
- `stream_end` follows every stream even after an error: a failed run sends its `error` frame first and `stream_end` last.
- An `error` frame does not by itself end a stream. It is advisory: it may concern the run in flight or an unrelated frame, such as a malformed `ping`.
- The client SHOULD use this message to clear any "processing" or "loading" indicators.
- The client MUST treat a run as complete only at `stream_end` or when the socket closes. Unparseable JSON is the one frame answered with `INVALID_FORMAT` and no `stream_end`, because the server cannot tell what it was meant to be; for it the client falls back on the socket closing.

## 6. SessionEntry Objects

A SessionEntry represents a single piece of content in the conversation. Every entry has a `role` field that determines its shape. The `role` acts as a discriminant for the union type.

### 6.1 UserEntry

A message authored by the user.

```json
{
  "role": "user",
  "content": "What is the weather in Berlin?",
  "timestamp": "2026-01-15T14:30:00Z"
}
```

| Field       | Type   | Description                  |
| ----------- | ------ | ---------------------------- |
| `role`      | string | `"user"`                     |
| `content`   | string | The message text             |
| `timestamp` | string | ISO 8601 datetime            |

### 6.2 AssistantEntry

A response generated by the AI model. Content is delivered incrementally via `entry_delta` messages while `isStreaming` is `true`.

```json
{
  "role": "assistant",
  "content": "Berlin currently has a temperature of 18 degrees Celsius.",
  "timestamp": "2026-01-15T14:30:01Z",
  "isStreaming": false
}
```

| Field         | Type    | Description                                 |
| ------------- | ------- | ------------------------------------------- |
| `role`        | string  | `"assistant"`                               |
| `content`     | string  | Markdown text, built incrementally by deltas |
| `timestamp`   | string  | ISO 8601 datetime                           |
| `isStreaming`  | boolean | `true` while deltas are arriving            |
| `truncated`    | `true`  | Optional. Present only when the run ended before this entry finished, or when a resume replays it still streaming; see § 7.1 and § 11.3 |

### 6.3 ThinkingEntry

Internal AI reasoning, separated from user-facing content by the server's thinking tag parser. The client SHOULD render this as a collapsible section.

```json
{
  "role": "thinking",
  "content": "I should look up the weather for Berlin using the get_weather tool.",
  "isStreaming": false
}
```

| Field        | Type    | Description                               |
| ------------ | ------- | ----------------------------------------- |
| `role`       | string  | `"thinking"`                              |
| `content`    | string  | Reasoning text, built incrementally       |
| `isStreaming` | boolean | `true` while deltas are arriving          |
| `truncated`   | `true`  | Optional. Present only when the run ended before this entry finished, or when a resume replays it still streaming; see § 7.1 and § 11.3 |

Note: ThinkingEntry does not include a `timestamp` field.

### 6.4 ToolEntry

A tool invocation requested by the AI model. The server executes the tool and feeds the result back to the model. The client SHOULD render tool entries with the tool name, parameters, and an activity indicator.

```json
{
  "role": "tool",
  "toolName": "get_weather",
  "toolInput": {
    "location": "Berlin",
    "units": "celsius"
  },
  "timestamp": "2026-01-15T14:30:01Z"
}
```

| Field       | Type   | Description                               |
| ----------- | ------ | ----------------------------------------- |
| `role`      | string | `"tool"`                                  |
| `toolName`  | string | Registered tool name                      |
| `toolInput` | object | Key-value pairs passed to the tool        |
| `timestamp` | string | ISO 8601 datetime                         |

Note: ToolEntry does not participate in the delta/commit cycle. It is delivered as a single `entry_upsert`.

## 7. Entry Lifecycle

Entries follow one of two lifecycles depending on whether they support streaming.

### 7.1 Streaming Entries (assistant, thinking)

```text
entry_upsert  -->  entry_delta (0..N)  -->  entry_commit
   |                    |                       |
   |  isStreaming=true  |  content grows        |  isStreaming=false
   |  content=""        |  via concatenation    |  content is final
```

1. The server sends `entry_upsert` with `isStreaming: true` and an empty `content`.
2. The server sends zero or more `entry_delta` messages. The client MUST concatenate each `delta` to the entry's `content`.
3. The server sends `entry_commit`. The client MUST set `isStreaming` to `false`, matching the committed entry the server keeps in the session. No further deltas will arrive for this entry ([validated by: leaves the committed assistant entry in the session, no longer streaming](../../src/transport/ws/messageHandler.test.ts#L105)).
4. Every entry the server opens is committed by the time the turn ends, on every terminal path: a `stop`, a round that ends without one, and a provider that throws mid-stream. The partial content is committed exactly as streamed, and on a throw the `entry_commit` frames arrive before the `error` frame ([validated by: commits a partial answer as streamed, before the error, when the provider throws](../../src/transport/ws/messageHandler.test.ts#L414), [validated by: commits the answer, flagged truncated, when a round ends on a tool call with no stop chunk](../../src/transport/ws/messageHandler.test.ts#L449)).
5. An entry committed because the run ended before it finished (a provider failure, or a round with no `stop`) carries `truncated: true`, in the session and on the wire: the server re-sends it as an `entry_upsert` with the flag just before its `entry_commit`, so a live client and a replay of the stored entry both see it, and a client can render a cut-off answer as cut off without the transient `error` frame. An entry committed on a `stop` never carries the field, and a suppressed entry is flagged in the session but never re-sent. Any text the thinking-tag parser still held is flushed into the entry first, as a `stop` does ([validated by: flags a partial answer truncated in the session and re-sends it with the flag before its commit](../../src/transport/ws/messageHandler.test.ts#L488), [validated by: leaves an entry committed on a stop chunk without the flag and sends it once](../../src/transport/ws/messageHandler.test.ts#L516), [validated by: flags a suppressed entry that a throw cut short in the session but never re-sends it](../../src/transport/ws/messageHandler.test.ts#L528), [validated by: keeps the text the thinking-tag parser still held when a throw cuts the answer short](../../src/transport/ws/messageHandler.test.ts#L540)).

### 7.2 Non-Streaming Entries (user, tool)

```text
entry_upsert
   |
   |  Complete on arrival.
   |  No delta or commit follows.
```

The entry is fully formed in the `entry_upsert` message, so a tool call yields one `entry_upsert` and nothing further. The client MUST NOT expect `entry_delta` or `entry_commit` for these entries ([validated by: sends a tool entry for a tool call](../../src/transport/ws/messageHandler.test.ts#L161)).

## 8. Conversation Sequence

A typical conversation produces entries in this order:

```text
Index 0: UserEntry         (user sends message)
Index 1: ThinkingEntry     (AI reasoning, streamed)
Index 2: ToolEntry         (AI invokes tool)
Index 3: AssistantEntry    (AI response, streamed)
```

In multi-tool scenarios, multiple ToolEntry objects may appear between the ThinkingEntry and AssistantEntry. The tool execution loop (Section 9) may produce additional entries.

- A reply with no tool calls and no thinking produces, in order, the user entry, the assistant entry opened empty, one `entry_delta` per text chunk, its `entry_commit`, and `stream_end` ([validated by: sends the user entry, then the assistant entry, its delta, its commit and stream_end](../../src/transport/ws/messageHandler.test.ts#L91)).
- A thinking block is committed before the assistant entry that follows it is opened, so the two never interleave ([validated by: commits the thinking entry before the assistant entry opens](../../src/transport/ws/messageHandler.test.ts#L117)).

### 8.1 Example: Full Conversation Exchange

```json
<-- {"type": "connected", "sessionId": "550e8400-...", "message": "Connected to HAL Engine", "examplePrompts": ["..."]}

--> {"type": "user_message", "content": "What is the weather in Berlin?"}

<-- {"type": "entry_upsert", "index": 0, "entry": {"role": "user", "content": "What is the weather in Berlin?", "timestamp": "2026-01-15T14:30:00Z"}}
<-- {"type": "entry_upsert", "index": 1, "entry": {"role": "thinking", "content": "", "isStreaming": true}}
<-- {"type": "entry_delta",  "index": 1, "delta": "I should look up the weather for Berlin."}
<-- {"type": "entry_upsert", "index": 2, "entry": {"role": "tool", "toolName": "get_weather", "toolInput": {"location": "Berlin"}}}
<-- {"type": "entry_commit", "index": 1}
<-- {"type": "entry_upsert", "index": 3, "entry": {"role": "assistant", "content": "", "timestamp": "2026-01-15T14:30:02Z", "isStreaming": true}}
<-- {"type": "entry_delta",  "index": 3, "delta": "Berlin currently has "}
<-- {"type": "entry_delta",  "index": 3, "delta": "a temperature of 18 degrees Celsius with clear skies."}
<-- {"type": "entry_commit", "index": 3}
<-- {"type": "stream_end"}
```

Notation: `-->` is client-to-server, `<--` is server-to-client.

**Commit frames are not emitted in index order.** Above, `entry_commit` for index 1 arrives after `entry_upsert` for index 2. A thinking entry is committed when the next text segment arrives, not when a tool entry appears, so a tool call between thinking and the answer lands in the gap. A client that assumes commits arrive in ascending index order, or that an entry is committed before the next one opens, will mis-render this exchange ([validated by: commits the thinking entry when text resumes, not when a tool entry appears](../../src/transport/ws/messageHandler.test.ts#L134)).

### 8.2 Example: Tool with Suppression and Index Skip

When a tool suppresses the AI response, the server sends `entry_skip` for entries that exist in the session but are not forwarded to the client. The client must adjust subsequent indices accordingly.

```json
--> {"type": "user_message", "content": "Convert 100 miles to km"}

<-- {"type": "entry_upsert", "index": 0, "entry": {"role": "user", ...}}
<-- {"type": "entry_upsert", "index": 1, "entry": {"role": "tool", "toolName": "convert_units", ...}}
<-- {"type": "entry_upsert", "index": 2, "entry": {"role": "assistant", "content": "**100** miles = **160.93** kilometers", ...}}
<-- {"type": "entry_skip",   "index": 3}
<-- {"type": "stream_end"}
```

Here, server index 3 is the suppressed AI echo. The client tracks index 3 as skipped. When the user asks a follow-up:

```json
--> {"type": "user_message", "content": "Explain the result"}

<-- {"type": "entry_upsert", "index": 4, "entry": {"role": "user", ...}}
<-- {"type": "entry_upsert", "index": 5, "entry": {"role": "assistant", "content": "", "isStreaming": true, ...}}
<-- {"type": "entry_delta",  "index": 5, "delta": "The conversion means..."}
<-- {"type": "entry_commit", "index": 5}
<-- {"type": "stream_end"}
```

The client adjusts: server index 4 becomes client index 3, server index 5 becomes client index 4. The entries land at the correct array positions.

### 8.3 Example: Suppression After the Model Has Already Spoken

A model often narrates before it calls a tool. That narration is streamed to the client as it arrives, so by the time the tool asks for suppression the client is already displaying it. It cannot be skipped; it is retracted.

```json
--> {"type": "user_message", "content": "Convert 100 miles to km"}

<-- {"type": "entry_upsert", "index": 0, "entry": {"role": "user", ...}}
<-- {"type": "entry_upsert", "index": 1, "entry": {"role": "assistant", "content": "", "isStreaming": true, ...}}
<-- {"type": "entry_delta",  "index": 1, "delta": "Let me convert that for you."}
<-- {"type": "entry_commit", "index": 1}
<-- {"type": "entry_upsert", "index": 2, "entry": {"role": "tool", "toolName": "convert_units", ...}}
<-- {"type": "entry_upsert", "index": 3, "entry": {"role": "assistant", "content": "**100** miles = **160.93** kilometers", ...}}
<-- {"type": "entry_upsert", "index": 1, "entry": {"role": "assistant", "content": "", ...}}
<-- {"type": "entry_skip",   "index": 4}
<-- {"type": "stream_end"}
```

The second `entry_upsert` at index 1 is the retraction: same index, empty content. Index 1 is NOT tracked as skipped -- it still occupies its slot in the client array. Index 4, the model's suppressed follow-up, is.

### 8.4 Example: Error During Streaming

A provider fails after the answer has started. The partial answer is re-sent flagged `truncated` and committed as streamed, then the client receives the `error` frame, then `stream_end` as the last frame of the run, and clears its processing state on `stream_end`, not on `error`.

```json
--> {"type": "user_message", "content": "Where is my booking?"}

<-- {"type": "entry_upsert", "index": 0, "entry": {"role": "user", ...}}
<-- {"type": "entry_upsert", "index": 1, "entry": {"role": "assistant", "content": "", "isStreaming": true, ...}}
<-- {"type": "entry_delta",  "index": 1, "delta": "Your booking is "}
<-- {"type": "entry_upsert", "index": 1, "entry": {"role": "assistant", "content": "Your booking is ", "isStreaming": true, "truncated": true, ...}}
<-- {"type": "entry_commit", "index": 1}
<-- {"type": "error",        "code": "SERVER_ERROR", "message": "Failed to process message"}
<-- {"type": "stream_end"}
```

## 9. Tool Execution Loop

When the AI model requests a tool invocation, the server executes the tool and re-queries the model with the result. The loop is bounded by `maxToolRounds` (default 5): at most `maxToolRounds` tool rounds are executed, and the provider is called at most `maxToolRounds + 1` times, so the default permits six model calls: the first, plus five more that each read a round's tool results. A tool round the model requests once the budget is spent is not executed; the turn ends on that call's output. No new frame type is introduced for this outcome: a consumer's `onToolBudgetExhausted` sentence arrives as an ordinary assistant entry (`entry_upsert`, `entry_delta`, `entry_commit`), and the turn still ends with `stream_end`, never `error` ([validated by: renders the hook's sentence as its own committed entry, then stream_end, with no error](../../src/transport/ws/messageHandler.test.ts#L571)).

```text
Round 1:  Model streams text + requests tool_use
          Server yields ToolEntry via entry_upsert
          Server executes tool
          Server re-queries model with tool result

Round 2:  Model streams text (possibly requests another tool)
          ...

Round N:  Model streams final text with stopReason "end_turn"
          Server commits all open entries
          Server sends stream_end
```

The client observes this as a sequence of `entry_upsert`, `entry_delta`, and `entry_commit` messages, terminated by a `stream_end`. The tool loop is transparent to the client -- it does not need to track rounds.

Messages a tool addresses to the client are forwarded verbatim, in the position the stream produced them, rather than being rewritten into entries of the server's own ([validated by: forwards a tool result to the client untouched](../../src/transport/ws/messageHandler.test.ts#L169)).

## 10. Heartbeat

Two levels of heartbeat operate concurrently.

### 10.1 WebSocket-Level Ping (Server-Initiated)

The server sends a WebSocket ping frame at the configured `heartbeatIntervalMs` interval (default 30 seconds). The client's WebSocket implementation responds automatically with a pong frame per RFC 6455 Section 5.5.3. If the server does not receive a pong within the interval, it MAY terminate the connection, which abandons the socket's turn like any close ([abandon-on-close](../hal-engine-abandon-on-close/spec.md)).

### 10.2 Application-Level Ping (Client-Initiated)

The client SHOULD send a `ping` message (Section 4.2) every 5 seconds. The server responds with a `pong` message (Section 5.7). The client MAY use the round-trip time to display connection health indicators.

## 11. Connection Termination

### 11.1 Client Disconnect

The client SHOULD close the WebSocket with code 1000 (Normal Closure). The server keeps the session: it erases nothing on close, and the credentials the socket carried are cleared from it. Closing the socket abandons the turn it started: the run stops, no `stream_end` follows, and the session keeps the answer as it stood, committed and flagged `truncated` ([abandon-on-close](../hal-engine-abandon-on-close/spec.md)).

### 11.2 Server Shutdown

**Not implemented.** No signal handler is installed anywhere in the engine. `createServer` returns a `stop()` that closes every client socket with code 1001 and clears the heartbeat, but nothing wires it to `SIGTERM`, so today a terminating process drops connections abruptly. A host embedding the engine can call `stop()` from its own handler; making the engine do it is an open decision. Each socket `stop()` closes abandons its turn, so a deploy that stops the server abandons every turn in flight unless connections are drained first.

### 11.3 Reconnection

If the connection drops unexpectedly, the client SHOULD reconnect using exponential backoff:

- Base delay: 1,000 ms
- Formula: `min(1000 * 2^retryCount + jitter, 31000)` where jitter is 0-1000 ms random
- Maximum retries: 5
- On reconnection success, any queued `user_message` messages MUST be flushed immediately.
- On reconnection, the client MUST clear its local entries array and SHOULD send `?sessionId=` with the id from its last `connected` frame. When the server has resume enabled and the conversation is the user's own, it answers `resumed: true` and replays the conversation; otherwise the client is starting a new session.
- An entry still streaming when its conversation is resumed is replayed with `isStreaming: false` and `truncated: true`: the rest of its turn streams to the connection that started it, so this one would wait for a commit that never comes ([validated by: replays an entry whose turn is still running as finished and truncated, leaving the stored entry as it is](../../src/transport/sessionResume.test.ts#L364)).
- With the server's `latest` option, a client that has lost the id, after a page refresh for instance, MAY connect without one and still rejoin its user's most recent conversation, and sends `?new=1` to start a new conversation instead ([validated by: with latest on, rejoins the most recently active session of a user whose connect names none](../../src/transport/sessionResume.test.ts#L428), [validated by: with latest on, starts a new session for a user with none, and on ?new=1 even when one exists](../../src/transport/sessionResume.test.ts#L445)).

After 5 failed attempts, the client MUST stop reconnecting and report a disconnected state.

## 12. Security Considerations

- Access tokens are transmitted in the `Sec-WebSocket-Protocol` request header, which keeps them out of the request line and so out of a URL-based access log. They are not hidden from logging in general: an ingress or proxy that captures request headers records them, as it records an `Authorization` header, so header capture must redact `Sec-WebSocket-Protocol` too.
- The server answers with the `hal.v1` marker, so the token is never written into the 101 response headers or held as the connected socket's `protocol` property. An offer without the marker is answered with no subprotocol, so no offered value is ever echoed.
- No offered subprotocol value is written to the engine's own log at any level. Every place a credential exists during a connection - request headers, the socket's and the session's `authHeaders`, and the tool context - is listed in [the subprotocol marker spec](../hal-engine-subprotocol-marker/spec.md#where-a-credential-exists).
- Message content is validated at the server boundary. Content exceeding 10,000 characters is rejected.
- The server validates all incoming messages against known types. Unrecognized types receive an `INVALID_MESSAGE` error.
- The authenticated identity (`AuthenticatedUser.id`) is the only thing separating one user's conversations from another's in every session-store query; the engine refuses a value it cannot use as a scalar identity rather than passing it to the store. A value is scalar when it is a `string` or a finite `number`; `null`, `undefined`, an array, an object, `NaN`, and `Infinity` are all refused ([validated by: accepts a string or finite-number userId](../../src/infrastructure/stores/scalarUserId.test.ts#L4), [validated by: throws a TypeError for a non-scalar userId: object, null, undefined, array, NaN, or Infinity](../../src/infrastructure/stores/scalarUserId.test.ts#L12)).
- A `WsAuthenticator` that resolves such a non-scalar id is treated as a failed authentication: the server answers `401 Unauthorized` and emits an error log recording the refused id's type, never its value, so no token or operator the id may carry leaks into the log ([validated by: answers 401 when the authenticator resolves a non-scalar id, and still accepts a string or finite-number id](../../src/transport/malformedUpgrade.test.ts#L133), [validated by: logs the type of a refused non-scalar id and never its contents](../../src/transport/ws/connectionHandler.test.ts#L378)).
- The scalar-id invariant is also enforced at the session-store boundary: `create` and `latestFor` on both `InMemorySessionStore` and `MongoSessionStore` reject a non-scalar id before issuing any query, so a consumer calling either method directly from their own code receives the same refusal ([validated by: refuses a non-scalar userId in create](../../src/infrastructure/stores/inMemorySessionStore.test.ts#L68), [validated by: refuses a non-scalar userId in latestFor](../../src/infrastructure/stores/inMemorySessionStore.test.ts#L75), [validated by: refuses a non-scalar userId in create and latestFor without issuing any queries](../../src/infrastructure/stores/mongo/mongoScalarId.test.ts#L26)).

## 13. Source Files

| Concern                  | File                                              |
| ------------------------ | ------------------------------------------------- |
| Shared entry types       | `src/types/session.ts`                            |
| Backend message types    | `src/types/messages.ts`                           |
| Backend sender helpers   | `src/transport/ws/sender.ts`                      |
| Message validation       | `src/transport/ws/validation.ts`                  |
| Message handling         | `src/transport/ws/messageHandler.ts`              |
| Connection handler       | `src/transport/ws/connectionHandler.ts`           |
