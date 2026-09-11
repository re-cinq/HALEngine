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
wss://{host}{basePath}/ws/{chatId}
```

Where `{basePath}` is the configurable path prefix (default `/hal`). For example, with default settings:

```text
wss://example.com/hal/ws/abc-123
```

The server validates only that the path begins with `{basePath}/ws`; it does not parse or require the trailing `{chatId}`. Clients SHOULD still send one, because it is what makes a connection identifiable in logs and proxies, but it does not select or resume server state. The session is identified by the `sessionId` the server mints in the `connected` message, and a new one is minted per connection.

### 2.2 Authentication

Authentication is performed during the WebSocket handshake. The client MUST pass the access token as a WebSocket subprotocol in the `Sec-WebSocket-Protocol` header:

```text
GET /hal/ws/abc-123 HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Protocol: <access-token>
```

The server MUST validate the token via the configured `WsAuthenticator` before completing the upgrade. If authentication fails, the server MUST reject the connection with HTTP 401.

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

The `sessionId` is a UUID v4 assigned by the server. It uniquely identifies this session and is valid for the lifetime of the connection. The `examplePrompts` array contains example queries derived from the registered tool definitions, displayed in the client as clickable suggestions.

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

Sends a user chat message. `user_message` is the canonical type; the server also accepts `send_message` and normalises it to `user_message`.

```json
{
  "type": "user_message",
  "content": "What is the weather in Berlin?"
}
```

| Field     | Type   | Required | Description                            |
| --------- | ------ | -------- | -------------------------------------- |
| `type`    | string | Yes      | `"user_message"` or `"send_message"`   |
| `content` | string | Yes      | Message text                           |

Any other field is ignored. In particular the server does not read a `chatId` from this message: the connection already determines the session.

Constraints:

- `content` MUST NOT be empty or whitespace-only after trimming.
- `content` MUST NOT exceed 10,000 characters.
- Violation of these constraints results in an `error` response with code `INVALID_MESSAGE`.

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

Notifies the client that a session entry was created on the server and will never be sent. This happens under output suppression (see [tool-responses.md](../hal-engine-tool-responses/spec.md)): the server keeps the entry so the model retains context, and the client does not need it for display ([validated by](../../src/transport/ws/messageHandler.test.ts#L170)).

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

- An entry **opened while suppression is already active** is announced with `entry_skip` and nothing else: no `entry_upsert`, no `entry_delta`, no `entry_commit` follows it ([validated by](../../src/transport/ws/messageHandler.test.ts#L162)).
- An entry **already sent before suppression began** cannot be skipped, because the client is displaying it. The server retracts it instead, by re-sending `entry_upsert` at the same index with the entry's `content` set to `""`. The client renders an empty assistant entry as nothing, so the text disappears ([validated by](../../src/transport/ws/messageHandler.test.ts#L139)).

#### Limits of retraction

- Only assistant entries are ever retracted; a thinking entry is never blanked, even when it was sent before suppression began ([validated by](../../src/transport/ws/messageHandler.test.ts#L154)).
- Each sent entry is blanked once, so a second suppression in the same stream repeats nothing ([validated by](../../src/transport/ws/messageHandler.test.ts#L188)).
- An entry the client only ever saw as `entry_skip` is never retracted, because nothing is displayed to retract ([validated by](../../src/transport/ws/messageHandler.test.ts#L180)).

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

- A message the server cannot parse into a known type is answered with `INVALID_MESSAGE`, and no message stream is started for it ([validated by](../../src/transport/ws/messageHandler.test.ts#L55)).
- A rate limit reported by the AI provider is surfaced as `RATE_LIMITED`, which tells the client the same request is worth retrying ([validated by](../../src/transport/ws/messageHandler.test.ts#L198)).
- Any other failure raised while processing a message is reported as `SERVER_ERROR` ([validated by](../../src/transport/ws/messageHandler.test.ts#L207)).

### 5.7 pong

Response to a client `ping`. The server MUST echo the client's timestamp without modification ([validated by](../../src/transport/ws/messageHandler.test.ts#L65)).

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

Signals that the server has finished processing a user message. Sent exactly once after each completed message stream, after all `entry_commit` messages have been sent.

```json
{
  "type": "stream_end"
}
```

| Field  | Type   | Description      |
| ------ | ------ | ---------------- |
| `type` | string | `"stream_end"`   |

Semantics:

- The server MUST send `stream_end` after every successfully completed message stream, including streams where output was suppressed (see [tool-responses.md](../hal-engine-tool-responses/spec.md)).
- The server MUST NOT send `stream_end` if the stream terminates due to an error. In that case, the `error` message (Section 5.6) serves as the terminal signal.
- The client SHOULD use this message to clear any "processing" or "loading" indicators.
- The client MUST NOT assume the stream is complete until either `stream_end` or `error` is received.

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
3. The server sends `entry_commit`. The client MUST set `isStreaming` to `false`, matching the committed entry the server keeps in the session. No further deltas will arrive for this entry ([validated by](../../src/transport/ws/messageHandler.test.ts#L89)).

### 7.2 Non-Streaming Entries (user, tool)

```text
entry_upsert
   |
   |  Complete on arrival.
   |  No delta or commit follows.
```

The entry is fully formed in the `entry_upsert` message, so a tool call yields one `entry_upsert` and nothing further. The client MUST NOT expect `entry_delta` or `entry_commit` for these entries ([validated by](../../src/transport/ws/messageHandler.test.ts#L120)).

## 8. Conversation Sequence

A typical conversation produces entries in this order:

```text
Index 0: UserEntry         (user sends message)
Index 1: ThinkingEntry     (AI reasoning, streamed)
Index 2: ToolEntry         (AI invokes tool)
Index 3: AssistantEntry    (AI response, streamed)
```

In multi-tool scenarios, multiple ToolEntry objects may appear between the ThinkingEntry and AssistantEntry. The tool execution loop (Section 9) may produce additional entries.

- A reply with no tool calls and no thinking produces, in order, the user entry, the assistant entry opened empty, one `entry_delta` per text chunk, its `entry_commit`, and `stream_end` ([validated by](../../src/transport/ws/messageHandler.test.ts#L75)).
- A thinking block is committed before the assistant entry that follows it is opened, so the two never interleave ([validated by](../../src/transport/ws/messageHandler.test.ts#L101)).

### 8.1 Example: Full Conversation Exchange

```json
<-- {"type": "connected", "sessionId": "550e8400-...", "message": "Connected to HAL Engine", "examplePrompts": ["..."]}

--> {"type": "user_message", "content": "What is the weather in Berlin?"}

<-- {"type": "entry_upsert", "index": 0, "entry": {"role": "user", "content": "What is the weather in Berlin?", "timestamp": "2026-01-15T14:30:00Z"}}
<-- {"type": "entry_upsert", "index": 1, "entry": {"role": "thinking", "content": "", "isStreaming": true}}
<-- {"type": "entry_delta",  "index": 1, "delta": "I should look up the weather for Berlin."}
<-- {"type": "entry_commit", "index": 1}
<-- {"type": "entry_upsert", "index": 2, "entry": {"role": "tool", "toolName": "get_weather", "toolInput": {"location": "Berlin"}}}
<-- {"type": "entry_upsert", "index": 3, "entry": {"role": "assistant", "content": "", "timestamp": "2026-01-15T14:30:02Z", "isStreaming": true}}
<-- {"type": "entry_delta",  "index": 3, "delta": "Berlin currently has "}
<-- {"type": "entry_delta",  "index": 3, "delta": "a temperature of 18 degrees Celsius with clear skies."}
<-- {"type": "entry_commit", "index": 3}
<-- {"type": "stream_end"}
```

Notation: `-->` is client-to-server, `<--` is server-to-client.

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

## 9. Tool Execution Loop

When the AI model requests a tool invocation, the server executes the tool and re-queries the model with the result. The loop is bounded by `maxToolRounds` (default 5), counted from zero and inclusive, so the default permits six model calls: the first, plus five more after tool results.

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

Messages a tool addresses to the client are forwarded verbatim, in the position the stream produced them, rather than being rewritten into entries of the server's own ([validated by](../../src/transport/ws/messageHandler.test.ts#L128)).

## 10. Heartbeat

Two levels of heartbeat operate concurrently.

### 10.1 WebSocket-Level Ping (Server-Initiated)

The server sends a WebSocket ping frame at the configured `heartbeatIntervalMs` interval (default 30 seconds). The client's WebSocket implementation responds automatically with a pong frame per RFC 6455 Section 5.5.3. If the server does not receive a pong within the interval, it MAY terminate the connection.

### 10.2 Application-Level Ping (Client-Initiated)

The client SHOULD send a `ping` message (Section 4.2) every 5 seconds. The server responds with a `pong` message (Section 5.7). The client MAY use the round-trip time to display connection health indicators.

## 11. Connection Termination

### 11.1 Client Disconnect

The client SHOULD close the WebSocket with code 1000 (Normal Closure). The server will delete the session from the session store.

### 11.2 Server Shutdown

**Not implemented.** No signal handler is installed anywhere in the engine. `createServer` returns a `stop()` that closes every client socket with code 1001 and clears the heartbeat, but nothing wires it to `SIGTERM`, so today a terminating process drops connections abruptly. A host embedding the engine can call `stop()` from its own handler; making the engine do it is an open decision.

### 11.3 Reconnection

If the connection drops unexpectedly, the client SHOULD reconnect using exponential backoff:

- Base delay: 1,000 ms
- Formula: `min(1000 * 2^retryCount + jitter, 31000)` where jitter is 0-1000 ms random
- Maximum retries: 5
- On reconnection success, any queued `send_message` messages MUST be flushed immediately.
- On reconnection, the client MUST clear its local entries array. The server will re-send the conversation state for the new session.

After 5 failed attempts, the client MUST stop reconnecting and report a disconnected state.

## 12. Security Considerations

- Access tokens are transmitted via the `Sec-WebSocket-Protocol` header during the handshake, avoiding exposure in URL query strings or server logs.
- Message content is validated at the server boundary. Content exceeding 10,000 characters is rejected.
- The server validates all incoming messages against known types. Unrecognized types receive an `INVALID_MESSAGE` error.

## 13. Source Files

| Concern                  | File                                              |
| ------------------------ | ------------------------------------------------- |
| Shared entry types       | `src/types/session.ts`                            |
| Backend message types    | `src/types/messages.ts`                           |
| Backend sender helpers   | `src/transport/ws/sender.ts`                      |
| Message validation       | `src/transport/ws/validation.ts`                  |
| Message handling         | `src/transport/ws/messageHandler.ts`              |
| Connection handler       | `src/transport/ws/connectionHandler.ts`           |
