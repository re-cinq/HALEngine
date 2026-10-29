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

The two carriers must agree when an upgrade uses both:

- The credential is the `Authorization` header, or the first offered subprotocol value that is not the marker, read as `Bearer <value>`; with neither, there is no credential ([validated by: returns Bearer t-1 when both carriers hold t-1, and refuses Bearer t-1 beside a subprotocol t-2](../../src/transport/ws/credential.test.ts#L9), [validated by: returns no value for neither carrier, and the one value when only the header or only the subprotocol holds it](../../src/transport/ws/credential.test.ts#L16)).
- An upgrade presenting both must present the same credential, compared byte for byte, so another scheme such as `Basic` and a lowercase `bearer` are each a different credential ([validated by: refuses Basic t-1 beside a subprotocol t-1, another scheme being another credential](../../src/transport/ws/credential.test.ts#L28), [validated by: refuses a lowercase bearer t-1 beside a subprotocol t-1, the comparison being exact](../../src/transport/ws/credential.test.ts#L34)).
- A subprotocol offered without the marker carries no credential, so beside it the header stands alone ([validated by: reads the subprotocol credential only beside hal.v1, so a markerless t-2 leaves the header Bearer t-1 standing alone](../../src/transport/ws/credential.test.ts#L40)).
- Two different credentials are refused with `400 Bad Request` before the `WsAuthenticator` runs, not `401`, since the authenticator was never consulted, and the refusal is logged once at `warn` naming neither value ([validated by: refuses Bearer attacker-token beside a victim-token subprotocol with 400 before wsAuth runs, and neither value reaches the response or a log line](../../src/transport/handshake.test.ts#L182)).
- The same credential in both carriers connects and is forwarded once ([validated by: connects a client presenting the same token in the header and the subprotocol, and forwards it once as a bearer](../../src/transport/handshake.test.ts#L218)).
- An upgrade presenting neither still reaches the `WsAuthenticator`, since a consumer may authenticate by cookie ([validated by: still hands an upgrade with no credential to wsAuth, since a consumer may authenticate by cookie](../../src/transport/handshake.test.ts#L203)).
- `presentedCredential`, which applies this rule, is internal and not exported from the package root ([validated by: keeps presentedCredential and the module it lives in out of the package root](../../src/index.test.ts#L17)).

A subprotocol is validated client-side as an HTTP token (RFC 7230 `tchar`), so a value carried this way can contain only letters, digits and ``!#$%&'*+-.^_`|~``: a JWT fits, but a padded base64 token (`=`, `/`) cannot use this carrier at all.

A client that offers a bare token without the marker, the shape `0.2.x` documented, is refused: `0.3.x` and `0.4.x` still echoed such an offer for one MINOR, and later releases read no credential from it. An authenticator that reads the credential with `credentialFromSubprotocol` therefore rejects the upgrade with HTTP 401; one that admits the request anyway gets a 101 with no `Sec-WebSocket-Protocol` header, which `ws` and Chromium both fail. Either way every client must offer `hal.v1` beside its token (see [the subprotocol marker spec](../hal-engine-subprotocol-marker/spec.md)).

The server MUST validate the token via the configured `WsAuthenticator` before completing the upgrade. If authentication fails, the server MUST reject the connection with HTTP 401.

The `id` of the user a `WsAuthenticator` resolves is the only thing separating one user's conversations from another's in every store query, so the engine refuses a value it cannot use as an identity rather than passing it to a database:

- An `id` that is not a string or a finite number is answered `401`, the same as `null`, and no session is created. A decoded token can hand back an object, and a Mongo filter reads `{$ne: null}` as every user ([validated by: answers 401 to a wsAuth resolving {id: {$ne: null}}, and creates no session](../../src/transport/scalarUserId.test.ts#L41)).
- `undefined`, `null`, an array, `NaN` and `Infinity` are refused the same way, with no session created, while a string and a finite number connect ([validated by: answers 401 for undefined, null, an array, NaN and Infinity, while a string and a finite number connect](../../src/transport/scalarUserId.test.ts#L45)).
- The refusal is logged at `error` under `ws` as an authenticator fault, naming the id's kind and none of its contents, which can carry whatever the token held ([validated by: logs the refusal at error with the id's kind and none of its contents](../../src/transport/scalarUserId.test.ts#L62)).
- **GDPR / NIS-2.** The vector is closed end to end: a socket authenticated as `{$ne: null}` against a store holding other users' conversations is refused before any store method runs ([validated by: never reaches listFor for a socket authenticated as {$ne: null} against a store holding two other users' conversations](../../src/transport/scalarUserId.test.ts#L78)).

No upgrade request can end the server process: the `upgrade` event has nothing above it to catch a throw, so every refusal is an HTTP status instead.

- An upgrade whose `Host` header is missing or empty (RFC 6455 §4.1 requires one), or whose request-target is not a URL, such as `//`, is answered with HTTP 400 ([validated by: answers an empty Host, a missing Host and a // target with 400 instead of throwing out of the upgrade listener](../../src/transport/malformedUpgrade.test.ts#L68)).
- The path check reads the target alone and never throws: a path beginning with `{basePath}/ws` passes, as §2.1 says; any other path, an empty target or `//` fails ([validated by: accepts any path beginning with /hal/ws and refuses another path, an empty target and //, without throwing](../../src/transport/ws/wsPath.test.ts#L4)).
- A `WsAuthenticator` that throws synchronously, rather than returning a rejected promise, is answered with HTTP 500, as a rejection is ([validated by: answers 500 when the authenticator throws synchronously instead of rejecting](../../src/transport/malformedUpgrade.test.ts#L82)).
- A `WsAuthenticator` that throws or rejects is logged at `error` as `authenticator failed` with its error's type alone, never its message, which can carry the credential it was checking ([validated by: logs a throwing or rejecting authenticator by its error type alone, never its message](../../src/transport/malformedUpgrade.test.ts#L92)).
- A `WsAuthenticator` that returns a user directly, not in a promise, is treated like one that resolves to it, rather than failing inside the listener ([validated by: upgrades a request whose authenticator returns a user without a promise](../../src/transport/malformedUpgrade.test.ts#L118)).
- A well-formed upgrade is unaffected ([validated by: still upgrades a well-formed request](../../src/transport/malformedUpgrade.test.ts#L126)).

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

The `message` shown is the default, `Connected to HAL Engine`; a deployer sets its own with `transport.connectMessage` ([connect message](../hal-engine-connect-message/spec.md)), and a client SHOULD display it before the first user message, since a deployer may carry the AI disclosure in it. The `sessionId` is a UUID v4 assigned by the server. It uniquely identifies this session; with resume enabled it outlives the connection and a reconnect can name it. The `examplePrompts` array contains example queries derived from the registered tool definitions, displayed in the client as clickable suggestions.

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

| Field     | Type   | Required | Description      |
| --------- | ------ | -------- | ---------------- |
| `type`    | string | Yes      | `"user_message"` |
| `content` | string | Yes      | Message text     |

Any other field is ignored, and the validator forwards only the fields the frame defines. In particular the server does not read a `chatId` from this message: the connection already determines the session ([validated by: drops any field the frame does not define, rather than forwarding it](../../src/transport/ws/validation.test.ts#L18)).

Constraints:

- `content` MUST NOT be empty or whitespace-only after trimming ([validated by: refuses content of three spaces as empty](../../src/transport/ws/validation.test.ts#L82)).
- `content` MUST NOT exceed 10,000 characters: 10,000 is accepted and 10,001 refused, the error naming the limit ([validated by: accepts content of exactly 10,000 characters and refuses 10,001, naming the limit](../../src/transport/ws/validation.test.ts#L72)).
- Violation of these constraints results in an `error` response with code `INVALID_MESSAGE`.

One at a time:

- A session processes one `user_message` at a time, in the order the frames arrived: a frame arriving while an earlier one is still running waits, and its answer starts only after the earlier run's `stream_end` ([validated by: answers a second user_message only after the first has sent its stream_end, in the order they arrived](../../src/transport/ws/messageHandler.test.ts#L701)).
- The waiting message's model request therefore holds the earlier answer finished, never one still streaming ([validated by: hands the second run a history whose first answer is finished, never one still streaming](../../src/transport/ws/messageHandler.test.ts#L732)).
- A `ping` is answered at once, even while a run is pending ([validated by: answers a ping at once while a run is pending](../../src/transport/ws/messageHandler.test.ts#L750)).
- A frame that fails validation and is not a `user_message`, such as a malformed `ping`, gets its `INVALID_MESSAGE` at once, even while a run is pending, but a `user_message` that fails validation is answered in turn, its `INVALID_MESSAGE` and `stream_end` after the run in progress, since an `error` frame names no message and would otherwise read as the running answer's ([validated by: answers an invalid ping at once but an invalid user_message in turn, after the run in progress](../../src/transport/ws/messageHandler.test.ts#L763)).
- The reconnect flush (§ 11.3), which sends queued messages in one burst, is therefore safe: they are answered one after another, in the order the user typed them ([validated by: queues three messages sent in one tick before the handler returns, and answers them in that order](../../src/transport/ws/messageHandler.test.ts#L779)).
- A queued message whose socket has closed by the time its turn comes is dropped, neither recorded nor answered, since nobody is left to read the answer and a session whose last socket closed has no credentials left ([validated by: drops a queued message whose socket closed before its turn, without asking the model or recording it](../../src/transport/ws/messageHandler.test.ts#L796)).

### 4.2 ping

Application-level heartbeat. The server MUST respond with a `pong` message echoing the timestamp.

```json
{
  "type": "ping",
  "timestamp": 1705312200000
}
```

| Field       | Type   | Required | Description                      |
| ----------- | ------ | -------- | -------------------------------- |
| `type`      | string | Yes      | `"ping"`                         |
| `timestamp` | number | Yes      | Client timestamp in milliseconds |

A `ping` whose `timestamp` is missing or is not a number is refused, its error naming the field, and a numeric `timestamp` is passed on unchanged for the `pong` to echo ([validated by: refuses a ping with no timestamp or a text one, and passes a numeric timestamp through unchanged](../../src/transport/ws/validation.test.ts#L92)).

### 4.3 list_conversations

Asks for the connecting user's own conversations. Served only when the server enables
`transport.history`; otherwise it is answered with an `error` of code `UNSUPPORTED`.

```json
{
  "type": "list_conversations",
  "limit": 20,
  "before": {"updatedAt": "2026-10-06T09:30:22.517Z", "sessionId": "0f9c8e41-..."}
}
```

| Field    | Type   | Required | Description                                                                |
| -------- | ------ | -------- | -------------------------------------------------------------------------- |
| `type`   | string | Yes      | `"list_conversations"`                                                     |
| `limit`  | number | No       | Whole number 1-200; how many rows to answer with, 50 when absent           |
| `before` | object | No       | The last row received, `{updatedAt, sessionId}`; answers the ones after it |

The frame carries no user id and there is no field for one: the server lists the conversations of
the user its `WsAuthenticator` returned for that connection ([validated by: answers the connecting user's own conversations even when the frame names another user](../../src/transport/conversationList.test.ts#L126)). A `before` is accepted
only carrying both fields, since a cursor on a time alone skips a conversation when two share one
([validated by: refuses a cursor missing either half, or carrying a time nothing can parse, naming the field](../../src/transport/ws/validation.test.ts#L48)).

## 5. Server-to-Client Messages

### 5.1 connected

Sent exactly once after a successful handshake. See Section 2.3.

| Field            | Type     | Description                                                                                                                                                                                                                                                                                         |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`           | string   | `"connected"`                                                                                                                                                                                                                                                                                       |
| `sessionId`      | string   | UUID v4 identifying the session                                                                                                                                                                                                                                                                     |
| `message`        | string   | Consumer-controlled text, `transport.connectMessage`, defaulting to `Connected to HAL Engine`; a client SHOULD display it before the first user message                                                                                                                                             |
| `examplePrompts` | string[] | Example queries derived from registered tool definitions                                                                                                                                                                                                                                            |
| `resumed`        | boolean  | Present only with resume enabled: whether the requested conversation was rejoined                                                                                                                                                                                                                   |
| `entryCount`     | number   | Present only when `resumed` is `true`: how many stored entries the replay covers, skipped ones included                                                                                                                                                                                             |
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

| Field   | Type   | Description                  |
| ------- | ------ | ---------------------------- |
| `type`  | string | `"entry_commit"`             |
| `index` | number | Index of the entry to commit |

Semantics:

- The client MUST set `isStreaming` to `false` on the entry at the given index.
- After a commit, the entry's content is considered complete and stable.

### 5.5 entry_skip

Notifies the client that a session entry was created on the server and will never be sent. This happens under output suppression (see [tool-responses.md](../hal-engine-tool-responses/spec.md)): the server keeps the entry so the model retains context, and the client does not need it for display ([validated by: still records a suppressed reply in the session, so history keeps it](../../src/transport/ws/messageHandler.test.ts#L227)).

```json
{
  "type": "entry_skip",
  "index": 3
}
```

| Field   | Type   | Description                            |
| ------- | ------ | -------------------------------------- |
| `type`  | string | `"entry_skip"`                         |
| `index` | number | Server-side index of the skipped entry |

Suppression can begin before or after the server has started sending a reply, and the two cases produce different messages. This distinction is the whole of the protocol here:

- An entry **opened while suppression is already active** is announced with `entry_skip` and nothing else: no `entry_upsert`, no `entry_delta`, no `entry_commit` follows it ([validated by: skips rather than upserts a segment opened after suppression](../../src/transport/ws/messageHandler.test.ts#L219)).
- An entry **already sent before suppression began** cannot be skipped, because the client is displaying it. The server retracts it instead, by re-sending `entry_upsert` at the same index with the entry's `content` set to `""`. This holds for a thought as much as an answer, since both are the model's words, and the client renders an empty assistant or thinking entry as nothing, so the text disappears ([validated by: blanks an assistant entry that was already sent](../../src/transport/ws/messageHandler.test.ts#L181), [validated by: blanks a thinking entry already sent beside the answer, and no frame after suppression carries its text](../../src/transport/ws/messageHandler.test.ts#L196)).
- An entry **still streaming when suppression begins** is first committed as streamed so far, with `entry_commit`, and is from then on an entry already sent: an answer or a thought is retracted as above, and whatever the model writes next opens a new entry announced with `entry_skip` ([validated by: commits and retracts an answer still open when suppression begins, and skips what follows as a new entry](../../src/transport/ws/messageHandler.test.ts#L283), [validated by: commits and retracts a thought still open when suppression begins, and skips what follows as a new entry](../../src/transport/ws/messageHandler.test.ts#L304)).

#### Limits of retraction

- Only model-authored entries, thinking and assistant, are retracted or skipped; a thinking entry opened under suppression is skipped like an answer ([validated by: skips a thinking entry opened after suppression rather than blanking it](../../src/transport/ws/messageHandler.test.ts#L325)).
- A tool entry is exempt from both: opened under suppression, it still arrives as `entry_upsert` with its `toolName` and `toolInput`, so the client has something to show between a tool's answer and `stream_end` ([validated by: still sends a tool entry opened under suppression as an entry_upsert carrying its toolName and toolInput](../../src/transport/ws/messageHandler.test.ts#L333)).
- A blanking `entry_upsert` is not an `entry_skip`: the index keeps its slot in the client's array, empty, and does not enter the skipped-index arithmetic of § 8.2, and no `entry_skip` is ever sent for an index the client already received ([validated by: blanks a thinking entry already sent beside the answer, and no frame after suppression carries its text](../../src/transport/ws/messageHandler.test.ts#L196)).
- Each sent entry is blanked once, so a second suppression in the same stream repeats nothing ([validated by: blanks each sent entry once, so a second suppression repeats nothing](../../src/transport/ws/messageHandler.test.ts#L245)).
- An entry the client only ever saw as `entry_skip` is never retracted, because nothing is displayed to retract ([validated by: does not resurrect an entry the client only ever saw skipped](../../src/transport/ws/messageHandler.test.ts#L237)).

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

| Field          | Type   | Description                                                                                                    |
| -------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `type`         | string | `"error"`                                                                                                      |
| `code`         | string | Machine-readable code                                                                                          |
| `message`      | string | Human-readable detail                                                                                          |
| `retryAfterMs` | number | Only with `TOO_MANY_REQUESTS`: milliseconds to wait before sending again (specs/hal-engine-rate-limit/spec.md) |

`ErrorCodes` defines ten error codes ([validated by: defines ten ErrorCodes: TOO_MANY_REQUESTS, CREDENTIAL_EXPIRED and the three provider conditions added beside the five the protocol first had](../../src/transport/errorMapping.test.ts#L54)).

Defined error codes:

| Code                  | Kind               | Description                                                                                | HTTP |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------ | ---- |
| `INVALID_MESSAGE`     | client             | Message failed validation (missing fields, empty content, length)                          | —    |
| `INVALID_FORMAT`      | client             | Message body is not valid JSON                                                             | —    |
| `TOO_MANY_REQUESTS`   | client             | The user sent more than `transport.rateLimit` allows; `retryAfterMs` says how long to wait | 429  |
| `RATE_LIMITED`        | provider condition | The AI provider is rate limiting                                                           | 429  |
| `SERVICE_UNAVAILABLE` | provider condition | The AI provider is unavailable                                                             | 503  |
| `TIMEOUT`             | provider condition | The AI provider timed out                                                                  | 504  |
| `UPSTREAM_ERROR`      | provider condition | Any other AI provider failure                                                              | 502  |
| `SERVER_ERROR`        | engine defect      | An unexpected error that is no AI provider error                                           | 500  |
| `UNSUPPORTED`         | feature            | The server does not serve this frame: the feature is off, or its store cannot              | —    |
| `CREDENTIAL_EXPIRED`  | credential         | A tool credential `resolveAuthHeaders` could not renew; `stream_end` follows               | —    |

A `CREDENTIAL_EXPIRED` error carries, verbatim, the message of the `CredentialExpiredError` the consumer's `resolveAuthHeaders` threw, and a `stream_end` follows it, as [the credential resolver spec](../hal-engine-credential-resolver/spec.md) describes ([validated by: sends error CREDENTIAL_EXPIRED with the hook's own message, then stream_end, over a real connection](../../src/transport/credentialExpired.test.ts#L61)).

A client MUST treat a `code` it does not recognise as `SERVER_ERROR`.

**NIS-2 (Art. 21), operational resilience.** A consumer's failover or resilience logic can tell a vendor outage from an engine defect on the `code` alone over the WebSocket, or on the status over HTTP, without parsing a message: `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `TIMEOUT` and `UPSTREAM_ERROR` are provider conditions, and `SERVER_ERROR` never is.

Semantics:

- Every `AIError` maps through one table, `src/transport/errorMapping.ts`, which both transports read, so the WebSocket `code` and the HTTP status always agree; no other transport file maps a provider code ([validated by: answers RATE_LIMITED, SERVICE_UNAVAILABLE and TIMEOUT with their own code, status and fixed sentence](../../src/transport/errorMapping.test.ts#L24), [validated by: answers nine other AIError codes and one named constructor from the one fallback row, UPSTREAM_ERROR and 502](../../src/transport/errorMapping.test.ts#L36), [validated by: is the only non-test file under src/transport that maps a provider error code](../../src/transport/errorMapping.test.ts#L69)).
- `SERVICE_UNAVAILABLE` and `TIMEOUT` frames carry fixed sentences, `AI service temporarily unavailable` and `AI service timed out` ([validated by: sends SERVICE_UNAVAILABLE and TIMEOUT error frames with their fixed sentences](../../src/transport/ws/messageHandler.test.ts#L932)).
- A `TOO_MANY_REQUESTS` frame carries `retryAfterMs`, is the only frame that does, and ends its turn with `stream_end` like any other, since a refused `user_message` is still a turn under the single-terminal-frame contract ([validated by: refuses the sixth user_message of user u1 in a row with one error TOO_MANY_REQUESTS carrying retryAfterMs 3000 and a stream_end, running no sixth turn](../../src/transport/ws/rateLimitWs.test.ts#L57)).
- `RATE_LIMITED` is unchanged, and `SERVER_ERROR` is sent only for a throw that is no `AIError` ([validated by: still sends RATE_LIMITED byte-identically, and SERVER_ERROR only for a throw that is no AIError](../../src/transport/ws/messageHandler.test.ts#L944)).
- No frame carries an `AIError`'s own message, which can echo request content; it reaches only the log ([validated by: keeps the AIError message secret-detail-77 out of every frame it sends](../../src/transport/ws/messageHandler.test.ts#L956)).
- A provider failure ends its turn with the same terminal frames as an engine defect: the `error` frame, then `stream_end` ([validated by: ends a SERVICE_UNAVAILABLE turn with the same terminal frames as an engine defect](../../src/transport/ws/messageHandler.test.ts#L970)).
- The protocol takes additive changes only: every client frame that shipped before the conversation list is still read by the validator as the frame it was, field for field, and the same literals are typed as `IncomingMessage`, so a required field added to one of them fails `npm run typecheck` ([validated by: are each still read by the validator as the frame they were, field for field](../../src/transport/ws/protocolAdditive.test.ts#L28)).
- Every server frame that shipped before it still goes out through the sender as the frame it was, `connected` with none of the optional fields resume added to it included ([validated by: are each still sent on the wire as the frame they were, field for field](../../src/transport/ws/protocolAdditive.test.ts#L34)).
- A `list_conversations` the server does not serve is answered with `UNSUPPORTED`, whether because `transport.history` is off or because its store implements no `listFor`, and never with an empty list, which a client could not tell from a user who has no conversations ([validated by: refuses the frame when conversation history is not turned on](../../src/transport/conversationList.test.ts#L302), [validated by: refuses the frame when the store cannot list, rather than reporting no conversations](../../src/transport/conversationList.test.ts#L353)).
- A store that fails while listing is answered `SERVER_ERROR` carrying none of the store's own words, and the server logs the session id, the user id and the error's type rather than its message, since a driver's message can hold a connection string and its password; the user id in that line is personal data, as it is in every log line the engine writes ([validated by: answers a failing store with a server error, keeps the socket open, and logs no word the store said](../../src/transport/conversationList.test.ts#L388)).
- A message the server cannot parse into a known type is answered with `INVALID_MESSAGE`, and no message stream is started for it ([validated by: rejects an unparseable message and never starts a stream](../../src/transport/ws/messageHandler.test.ts#L72)).
- Each frame's bytes are parsed as JSON as they arrive, and bytes that do not parse read as no frame at all, without throwing ([validated by: reads a JSON object from text or from bytes, and an unterminated brace as null, without throwing](../../src/transport/ws/helpers.test.ts#L63)).
- A frame that is not JSON is answered with `INVALID_FORMAT` and the message `Invalid JSON`, and the connection stays open: the frame after it is handled as usual ([validated by: answers a frame that is not JSON with INVALID_FORMAT and Invalid JSON, and keeps the socket open for the next frame](../../src/transport/invalidFrame.test.ts#L16)).
- A rate limit reported by the AI provider is surfaced as `RATE_LIMITED`, which tells the client the same request is worth retrying ([validated by: tells the client to retry when the provider is rate limited](../../src/transport/ws/messageHandler.test.ts#L372)).
- Any other failure raised while processing a message that is no `AIError` is reported as `SERVER_ERROR` ([validated by: reports any other failure as a server error](../../src/transport/ws/messageHandler.test.ts#L381)).

### 5.7 pong

Response to a client `ping`. The server MUST echo the client's timestamp without modification ([validated by: answers a ping with the timestamp it was given](../../src/transport/ws/messageHandler.test.ts#L82)).

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

| Field  | Type   | Description    |
| ------ | ------ | -------------- |
| `type` | string | `"stream_end"` |

Semantics:

- The server MUST send `stream_end` after every `user_message` it receives, including streams where output was suppressed (see [tool-responses.md](../hal-engine-tool-responses/spec.md)), streams that failed after an `error` frame, and a `user_message` that failed validation ([single-terminal-frame](../hal-engine-single-terminal-frame/spec.md)). The one exception is a turn whose socket closes first: it is abandoned, and nothing more is sent ([abandon-on-close](../hal-engine-abandon-on-close/spec.md)).
- `stream_end` follows every stream even after an error: a failed run sends its `error` frame first and `stream_end` last.
- An `error` frame does not by itself end a stream. It is advisory: it may concern the run in flight or an unrelated frame, such as a malformed `ping`.
- The client SHOULD use this message to clear any "processing" or "loading" indicators.
- The client MUST treat a run as complete only at `stream_end` or when the socket closes. Unparseable JSON is the one frame answered with `INVALID_FORMAT` and no `stream_end`, because the server cannot tell what it was meant to be; for it the client falls back on the socket closing.

### 5.9 conversation_list

The answer to `list_conversations`: the connecting user's conversations, most recent activity
first. Sent only when asked for, never pushed.

```json
{
  "type": "conversation_list",
  "conversations": [
    {
      "sessionId": "0f9c8e41-...",
      "createdAt": "2026-10-06T08:12:04.001Z",
      "updatedAt": "2026-10-06T09:30:22.517Z",
      "entryCount": 12,
      "preview": "How do I cancel my subscription?"
    }
  ]
}
```

| Field                        | Type   | Description                                                                                                            |
| ---------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `type`                       | string | `"conversation_list"`                                                                                                  |
| `conversations`              | array  | Summaries, most recent activity first                                                                                  |
| `conversations[].sessionId`  | string | The id to reconnect with to rejoin that conversation                                                                   |
| `conversations[].createdAt`  | string | ISO 8601 timestamp                                                                                                     |
| `conversations[].updatedAt`  | string | ISO 8601 timestamp of the conversation's most recent activity                                                          |
| `conversations[].entryCount` | number | How many entries the conversation holds                                                                                |
| `conversations[].preview`    | string | Optional. The conversation's opening question, at most 120 code points, present only where the server enables previews |

Apart from `preview`, a summary carries no message content, and the two times are ISO strings rather than `Date`s, which
is what survives the wire ([validated by: answers the user's conversations newest first, with both times as ISO strings](../../src/transport/conversationList.test.ts#L100)). A row's `sessionId` is what a client reconnects with to rejoin that
conversation, through the resume path in 2.1 ([validated by: hands a client an id it can rejoin the conversation with](../../src/transport/conversationList.test.ts#L538)). The frame is answered without waiting on a turn, so one asked for
while an answer streams arrives before that answer ends ([validated by: answers a list in the middle of a streaming turn, before that turn ends](../../src/transport/conversationList.test.ts#L490)). The `preview` field is the one
that carries conversation content, and it is the server's decision rather than the client's: a client
cannot ask for one, and where the deployment has not enabled previews no row carries the key, even
against a store that would supply it ([validated by: strips a preview the store volunteered when this deployment did not turn previews on](../../src/transport/conversationList.test.ts#L137)). Where it has, each row carries its conversation's
opening question ([validated by: labels each conversation with its opening question where the deployer turned previews on](../../src/transport/conversationList.test.ts#L179)).

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

| Field       | Type   | Description       |
| ----------- | ------ | ----------------- |
| `role`      | string | `"user"`          |
| `content`   | string | The message text  |
| `timestamp` | string | ISO 8601 datetime |

### 6.2 AssistantEntry

A response generated by the AI model. Content is delivered incrementally via `entry_delta` messages while `isStreaming` is `true`.

```json
{
  "role": "assistant",
  "content": "Berlin currently has a temperature of 18 degrees Celsius.",
  "timestamp": "2026-01-15T14:30:01Z",
  "isStreaming": false,
  "persona": "support"
}
```

| Field         | Type    | Description                                                                                                                             |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `role`        | string  | `"assistant"`                                                                                                                           |
| `content`     | string  | Markdown text, built incrementally by deltas                                                                                            |
| `timestamp`   | string  | ISO 8601 datetime                                                                                                                       |
| `isStreaming` | boolean | `true` while deltas are arriving                                                                                                        |
| `truncated`   | `true`  | Optional. Present only when the run ended before this entry finished, or when a resume replays it still streaming; see § 7.1 and § 11.3 |
| `persona`     | string  | Optional; consumer-defined identifier of the persona that produced this entry                                                           |

The `persona` field is how a consumer attributes each answer to the persona that gave it:

- An assistant entry is created carrying the session's `activePersona` as its `persona`, and with no `persona` key at all when the session has none ([validated by: creates an assistant entry carrying persona 'support', and one with no persona key when none is given](../../src/transport/ws/assistantPersona.test.ts#L69)).
- The entry's first `entry_upsert` carries it, the frame that sends the entry whole, so a client sees the persona from the first token ([validated by: sends the assistant entry_upsert with persona 'support' when the session's activePersona is support](../../src/transport/ws/assistantPersona.test.ts#L84)).
- A session with no `activePersona` produces exactly the fields an assistant entry had before the field existed ([validated by: sends an assistant entry with no persona key when activePersona is unset, the fields the release before carried](../../src/transport/ws/assistantPersona.test.ts#L90)).
- Attribution is per answer: each message's entry carries the persona active for that message ([validated by: stamps each answer with the persona active for its own message, 'p-one' then 'p-two' in one session](../../src/transport/ws/assistantPersona.test.ts#L111)).
- Only assistant entries the engine creates are stamped. A thinking or tool entry carries no `persona`, and an assistant entry a tool supplies through `ToolResponse` is appended as the tool built it ([validated by: leaves the persona off thinking and tool entries, and appends an assistant entry a tool supplied as the tool built it](../../src/transport/ws/assistantPersona.test.ts#L124)).
- The blanking `entry_upsert` a suppression sends keeps the entry's `persona`, with `content` set to `""` ([validated by: keeps the persona on the blanking entry_upsert when a tool suppresses an answer already sent](../../src/transport/ws/assistantPersona.test.ts#L144)).
- The value is an opaque identifier the engine never resolves or validates, and a stored or replayed session can carry one the consumer's registry no longer knows, so a renderer needs a fallback for an unrecognised one.

**GDPR.** `persona` is persisted, replayed and logged wherever the session is, so it must carry an identifier and never a personal name, an account number or anything else identifying.

**EU AI Act.** Attributing an answer to a named persona does not affect the Article 50(1) disclosure obligation: a persona with a human first name is still an AI, and a deployer serving EU users still discloses that separately.

### 6.3 ThinkingEntry

Internal AI reasoning, separated from user-facing content by the server's thinking tag parser. The client SHOULD render this as a collapsible section.

```json
{
  "role": "thinking",
  "content": "I should look up the weather for Berlin using the get_weather tool.",
  "timestamp": "2026-01-15T14:30:00.000Z",
  "isStreaming": false
}
```

| Field         | Type    | Description                                                                                                                             |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `role`        | string  | `"thinking"`                                                                                                                            |
| `content`     | string  | Reasoning text, built incrementally                                                                                                     |
| `timestamp`   | string  | ISO 8601 datetime. Optional: absent on a thinking entry stored before 0.9                                                               |
| `isStreaming` | boolean | `true` while deltas are arriving                                                                                                        |
| `truncated`   | `true`  | Optional. Present only when the run ended before this entry finished, or when a resume replays it still streaming; see § 7.1 and § 11.3 |

- A thinking entry carries a `timestamp`, ISO 8601, like the other entries, and it round-trips through `Date` ([validated by: stamps a thinking entry with an ISO 8601 timestamp that round-trips through Date](../../src/orchestration/entryFactories.test.ts#L8)).
- The field is optional as a statement about stored data: a thinking entry written before it existed is still a valid `SessionEntry`, and `timestamp` can be read off any entry without narrowing on `role` ([validated by: reads timestamp off any SessionEntry with no role narrowing, and accepts a thinking entry without one](../../src/orchestration/entryFactories.test.ts#L14)).

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

| Field       | Type   | Description                        |
| ----------- | ------ | ---------------------------------- |
| `role`      | string | `"tool"`                           |
| `toolName`  | string | Registered tool name               |
| `toolInput` | object | Key-value pairs passed to the tool |
| `timestamp` | string | ISO 8601 datetime                  |

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
3. The server sends `entry_commit`. The client MUST set `isStreaming` to `false`, matching the committed entry the server keeps in the session. No further deltas will arrive for this entry ([validated by: leaves the committed assistant entry in the session, no longer streaming](../../src/transport/ws/messageHandler.test.ts#L106)).
4. Every entry the server opens is committed by the time the turn ends, on every terminal path: a `stop`, a round that ends without one, and a provider that throws mid-stream. The partial content is committed exactly as streamed, and on a throw the `entry_commit` frames arrive before the `error` frame ([validated by: commits a partial answer as streamed, before the error, when the provider throws](../../src/transport/ws/messageHandler.test.ts#L475), [validated by: commits the answer, flagged truncated, when a round ends on a tool call with no stop chunk](../../src/transport/ws/messageHandler.test.ts#L510)).
5. An entry committed because the run ended before it finished (a provider failure, or a round with no `stop`) carries `truncated: true`, in the session and on the wire: the server re-sends it as an `entry_upsert` with the flag just before its `entry_commit`, so a live client and a replay of the stored entry both see it, and a client can render a cut-off answer as cut off without the transient `error` frame. An entry committed on a `stop` never carries the field, and a suppressed entry is flagged in the session but never re-sent. Any text the thinking-tag parser still held is flushed into the entry first, as a `stop` does ([validated by: flags a partial answer truncated in the session and re-sends it with the flag before its commit](../../src/transport/ws/messageHandler.test.ts#L549), [validated by: leaves an entry committed on a stop chunk without the flag and sends it once](../../src/transport/ws/messageHandler.test.ts#L577), [validated by: flags a suppressed entry that a throw cut short in the session but never re-sends it](../../src/transport/ws/messageHandler.test.ts#L589), [validated by: keeps the text the thinking-tag parser still held when a throw cuts the answer short](../../src/transport/ws/messageHandler.test.ts#L601)).

### 7.2 Non-Streaming Entries (user, tool)

```text
entry_upsert
   |
   |  Complete on arrival.
   |  No delta or commit follows.
```

The entry is fully formed in the `entry_upsert` message, so a tool call yields one `entry_upsert` and nothing further. The client MUST NOT expect `entry_delta` or `entry_commit` for these entries ([validated by: sends a tool entry for a tool call](../../src/transport/ws/messageHandler.test.ts#L162)).

## 8. Conversation Sequence

A typical conversation produces entries in this order:

```text
Index 0: UserEntry         (user sends message)
Index 1: ThinkingEntry     (AI reasoning, streamed)
Index 2: ToolEntry         (AI invokes tool)
Index 3: AssistantEntry    (AI response, streamed)
```

In multi-tool scenarios, multiple ToolEntry objects may appear between the ThinkingEntry and AssistantEntry. The tool execution loop (Section 9) may produce additional entries.

- A reply with no tool calls and no thinking produces, in order, the user entry, the assistant entry opened empty, one `entry_delta` per text chunk, its `entry_commit`, and `stream_end` ([validated by: sends the user entry, then the assistant entry, its delta, its commit and stream_end](../../src/transport/ws/messageHandler.test.ts#L92)).
- A thinking block is committed before the assistant entry that follows it is opened, so the two never interleave ([validated by: commits the thinking entry before the assistant entry opens](../../src/transport/ws/messageHandler.test.ts#L118)).

### 8.1 Example: Full Conversation Exchange

```json
<-- {"type": "connected", "sessionId": "550e8400-...", "message": "Connected to HAL Engine", "examplePrompts": []}

--> {"type": "user_message", "content": "What is the weather in Berlin?"}

<-- {"type": "entry_upsert", "index": 0, "entry": {"role": "user", "content": "What is the weather in Berlin?", "timestamp": "2026-01-15T14:30:00Z"}}
<-- {"type": "entry_upsert", "index": 1, "entry": {"role": "thinking", "content": "", "timestamp": "2026-01-15T14:30:00Z", "isStreaming": true}}
<-- {"type": "entry_delta",  "index": 1, "delta": "Berlin"}
<-- {"type": "entry_upsert", "index": 2, "entry": {"role": "tool", "toolName": "weather", "toolInput": {"city": "Berlin"}, "timestamp": "2026-01-15T14:30:01Z"}}
<-- {"type": "entry_commit", "index": 1}
<-- {"type": "entry_upsert", "index": 3, "entry": {"role": "assistant", "content": "", "timestamp": "2026-01-15T14:30:02Z", "isStreaming": true}}
<-- {"type": "entry_delta",  "index": 3, "delta": "18 degrees and clear"}
<-- {"type": "entry_commit", "index": 3}
<-- {"type": "stream_end"}
```

Notation: `-->` is client-to-server, `<--` is server-to-client.

**Commit frames are not emitted in index order.** Above, `entry_commit` for index 1 arrives after `entry_upsert` for index 2. A thinking entry is committed when the next text segment arrives, not when a tool entry appears, so a tool call between thinking and the answer lands in the gap. A client that assumes commits arrive in ascending index order, or that an entry is committed before the next one opens, will mis-render this exchange ([validated by: commits the thinking entry when text resumes, not when a tool entry appears](../../src/transport/ws/messageHandler.test.ts#L135)).

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
<-- {"type": "error",        "code": "UPSTREAM_ERROR", "message": "AI service temporarily unavailable"}
<-- {"type": "stream_end"}
```

### 8.5 Recorded frames

`recordedFrames`, exported from the package root, is the authoritative sequence: the frames this server sends for five scripted turns, recorded through the real connection handler, orchestrator and message handler rather than transcribed from this section, so a consumer imports the fixture its client is tested against instead of writing one by hand ([validated by: exports recordedFrames as the constant src/testing/frames.ts holds, its simpleAnswer an array](../../src/index.test.ts#L26)).

- The committed constant is regenerated by `npm run record:frames` and must equal a fresh recording, so a frame edited by hand, or a change to what the server sends, fails the suite until it is re-recorded ([validated by: equals a fresh recording, so a frame edited by hand fails here until npm run record:frames rewrites it](../../src/testing/frames.test.ts#L19)).
- `thinkingThenTool` is nine frames, and the thinking entry at index 1 is committed after the tool entry at index 2 is upserted, at the round's `stop`, not when the tool entry appears ([validated by: records thinkingThenTool as nine frames, the commit at index 1 after the upsert at index 2](../../src/testing/frames.test.ts#L23)).
- `multiRoundSuppressed` is nine frames ending in the tool's own `entry_upsert`, which the orchestrator gives the next index, then the blanking `entry_upsert` of the answer already sent, then the `entry_skip` of the model's suppressed follow-up at the index after the tool's, then `stream_end` ([validated by: records multiRoundSuppressed as nine frames ending in the tool's own entry, the blanked answer and a skip](../../src/testing/frames.test.ts#L37)).
- `rateLimited` ends with the `RATE_LIMITED` error frame and then `stream_end`, as the single-terminal-frame contract requires, and its stub's vendor error, which names an internal account id, appears nowhere in the published frames ([validated by: records rateLimited ending with the RATE_LIMITED error then stream_end, carrying none of the vendor error](../../src/testing/frames.test.ts#L46)).
- `connectionOpened` is the one `connected` frame, and every `timestamp` in every scenario is the literal `"<ts>"` and the session id `"<session-id>"`, since the engine has no clock or id seam to fix them with ([validated by: records connectionOpened as one connected frame, with every timestamp <ts> and the session id <session-id>](../../src/testing/frames.test.ts#L59)).
- **GDPR.** Every string in the recording is synthetic: the user message `What is the weather in Berlin?`, the tool argument `Berlin`, which is also the thinking text, and the assistant text `18 degrees and clear`. The recorder drives the handlers with literal chunk arrays and names no provider factory, so recording cannot reach a model vendor or capture a real turn ([validated by: is recorded from literal chunks: no file under src/testing names a provider factory](../../src/testing/frames.test.ts#L74)).

## 9. Tool Execution Loop

When the AI model requests a tool invocation, the server executes the tool and re-queries the model with the result. The loop is bounded by `maxToolRounds` (default 5): at most `maxToolRounds` tool rounds are executed, and the provider is called at most `maxToolRounds + 1` times, so the default permits six model calls: the first, plus five more that each read a round's tool results. A tool round the model requests once the budget is spent is not executed; the turn ends on that call's output. No new frame type is introduced for this outcome: a consumer's `onToolBudgetExhausted` sentence arrives as an ordinary assistant entry (`entry_upsert`, `entry_delta`, `entry_commit`), and the turn still ends with `stream_end`, never `error` ([validated by: renders the hook's sentence as its own committed entry, then stream_end, with no error](../../src/transport/ws/messageHandler.test.ts#L632)).

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

Messages a tool addresses to the client are forwarded verbatim, in the position the stream produced them, rather than being rewritten into entries of the server's own ([validated by: forwards a tool result to the client untouched](../../src/transport/ws/messageHandler.test.ts#L170)).

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
- An entry still streaming when its conversation is resumed is replayed with `isStreaming: false` and `truncated: true`: the rest of its turn streams to the connection that started it, so this one would wait for a commit that never comes ([validated by: replays an entry whose turn is still running as finished and truncated, leaving the stored entry as it is](../../src/transport/sessionResume.test.ts#L392)).
- With the server's `latest` option, a client that has lost the id, after a page refresh for instance, MAY connect without one and still rejoin its user's most recent conversation, and sends `?new=1` to start a new conversation instead ([validated by: with latest on, rejoins the most recently active session of a user whose connect names none](../../src/transport/sessionResume.test.ts#L456), [validated by: with latest on, starts a new session for a user with none, and on ?new=1 even when one exists](../../src/transport/sessionResume.test.ts#L473)).

After 5 failed attempts, the client MUST stop reconnecting and report a disconnected state.

### 11.4 Server Failure After the Handshake

Once the `101` is sent the socket speaks WebSocket, so the server never writes an HTTP status line into it again.

- When something fails on the server after the handshake completed, the server closes the socket with code `1011`, "server encountered an unexpected condition" (RFC 6455 § 7.4.1). The client sees an orderly `close` event with `1011`, never a socket `error` followed by `1006`, and a failure on one connection leaves the next one unaffected ([validated by: closes with 1011 and no client error when a second connection listener throws, and the next client still connects](../../src/transport/upgradeFailure.test.ts#L52)).
- A failure while the session opens, such as a session store whose `create` throws, is answered first with an `error` frame and then the same `1011` close ([validated by: sends an error frame and closes with 1011, with no client error, through createHalEngine when the session store create throws synchronously](../../src/sessionSetupFailure.test.ts#L15)).
- The failure is logged once at `error` under `ws` as `connection failed after the handshake`, with the error's message; the upgrade request's `authorization` and `cookie` values reach no log line ([validated by: logs the failure at error under ws and keeps the authorization and cookie values out of every log line](../../src/transport/upgradeFailure.test.ts#L64)).
- Before the handshake completes, the server still answers in HTTP: a `wsAuth` that rejects gets `500 Internal Server Error` and one that resolves `null` gets `401 Unauthorized`, with no `101` and no connection opened ([validated by: answers a rejecting wsAuth with 500 and a null one with 401, with no 101 and no connection event](../../src/transport/upgradeFailure.test.ts#L85)).
- Every answer the engine itself writes before the handshake, these two and its `400`s, is a status line and an empty header block alone, such as `HTTP/1.1 401 Unauthorized\r\n\r\n`, with no header and no body, so nothing from the request is echoed into it, and the socket is destroyed once it is written. A refusal `ws` writes for an upgrade it cannot parse is its own ([validated by: writes HTTP/1.1 401 Unauthorized and an empty header block, nothing else, then destroys the socket](../../src/transport/ws/helpers.test.ts#L73)).

## 12. Security Considerations

- Access tokens are transmitted in the `Sec-WebSocket-Protocol` request header, which keeps them out of the request line and so out of a URL-based access log. They are not hidden from logging in general: an ingress or proxy that captures request headers records them, as it records an `Authorization` header, so header capture must redact `Sec-WebSocket-Protocol` too.
- The server answers with the `hal.v1` marker, so the token is never written into the 101 response headers or held as the connected socket's `protocol` property. An offer without the marker is answered with no subprotocol, so no offered value is ever echoed.
- No offered subprotocol value is written to the engine's own log at any level. Every place a credential exists during a connection - request headers, the socket's and the session's `authHeaders`, and the tool context - is listed in [the subprotocol marker spec](../hal-engine-subprotocol-marker/spec.md#where-a-credential-exists).
- An upgrade whose `Authorization` header and subprotocol carry different credentials is refused with `400` before authentication, so the credential a `WsAuthenticator` validated is the one forwarded to the session and to every tool ([validated by: refuses Bearer attacker-token beside a victim-token subprotocol with 400 before wsAuth runs, and neither value reaches the response or a log line](../../src/transport/handshake.test.ts#L182)).
- **NIS-2 (Art. 21), supply-chain security.** Before that rule, a tool calling a downstream API could receive a bearer token no authenticator had validated: the authenticator could check one carrier while the other's value was forwarded, defeating the per-user data boundary downstream ([validated by: refuses Bearer attacker-token beside a victim-token subprotocol with 400 before wsAuth runs, and neither value reaches the response or a log line](../../src/transport/handshake.test.ts#L182)).
- Message content is validated at the server boundary. Content exceeding 10,000 characters is rejected ([validated by: accepts content of exactly 10,000 characters and refuses 10,001, naming the limit](../../src/transport/ws/validation.test.ts#L72)).
- The server validates all incoming messages against known types. Unrecognized types receive an `INVALID_MESSAGE` error ([validated by: refuses a frame of type nope, naming the type](../../src/transport/ws/validation.test.ts#L88), [validated by: rejects an unparseable message and never starts a stream](../../src/transport/ws/messageHandler.test.ts#L72)).
- **GDPR (Art. 5(1)(c)), data minimisation.** A turn's log lines record the length of the user's message as `contentLength`, never its text. At every level, `debug` included, no line carries the message, a tool's arguments or result, or the answer ([validated by: logs a 32-character question as contentLength 32 at debug level, and no line carries the question, a tool argument or result, or the answer](../../src/contentFreeLogs.test.ts#L59)).

## 13. Source Files

| Concern                | File                                    |
| ---------------------- | --------------------------------------- |
| Shared entry types     | `src/types/session.ts`                  |
| Backend message types  | `src/types/messages.ts`                 |
| Backend sender helpers | `src/transport/ws/sender.ts`            |
| Message validation     | `src/transport/ws/validation.ts`        |
| Message handling       | `src/transport/ws/messageHandler.ts`    |
| Connection handler     | `src/transport/ws/connectionHandler.ts` |
