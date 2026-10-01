# Single Terminal Frame

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#60 |
| Status | Implemented          |

Every `user_message` the server receives now ends in exactly one `stream_end`, whatever happens in between, so a client has a single, un-raced signal that a run is over. Before this change a failed run ended with an `error` frame and no `stream_end`, while the protocol told clients to treat either frame as terminal; that rule could not be followed, because an unrelated `error` (a malformed `ping`) can arrive between two `entry_delta` frames of a healthy run and would read as the run ending early.

## Emission

- `sendStreamEnd` has one call site in `messageHandler.ts`, in the `finally` of the handler `createMessageHandler` returns, so a throw anywhere in the run still reaches it; `handleUserMessage` sends none ([validated by: ends a provider failure mid-stream with error then stream_end, stream_end last](../../src/transport/ws/messageHandler.test.ts#L333)).
- A provider failing mid-stream produces `error` (`SERVER_ERROR`) then `stream_end`, with `stream_end` the last frame ([validated by: ends a provider failure mid-stream with error then stream_end, stream_end last](../../src/transport/ws/messageHandler.test.ts#L333)).
- A provider rate limit produces `error` (`RATE_LIMITED`) then `stream_end` ([validated by: tells the client to retry when the provider is rate limited](../../src/transport/ws/messageHandler.test.ts#L314)).
- Any other failure produces `error` (`SERVER_ERROR`) then `stream_end` ([validated by: reports any other failure as a server error](../../src/transport/ws/messageHandler.test.ts#L323)).
- A `user_message` that fails validation (empty, blank or over-length content) never reaches the orchestrator and still produces `error` (`INVALID_MESSAGE`) then `stream_end` ([validated by: answers an empty user_message with INVALID_MESSAGE then stream_end](../../src/transport/ws/messageHandler.test.ts#L357), [validated by: answers a blank user_message with INVALID_MESSAGE then stream_end](../../src/transport/ws/messageHandler.test.ts#L361), [validated by: answers an over-length user_message with INVALID_MESSAGE then stream_end](../../src/transport/ws/messageHandler.test.ts#L365)).
- A malformed `ping` produces `error` (`INVALID_MESSAGE`) and no `stream_end` ([validated by: answers a malformed ping with INVALID_MESSAGE and no stream_end](../../src/transport/ws/messageHandler.test.ts#L369)).
- A valid `ping` produces `pong` and no `stream_end` ([validated by: answers a ping with the timestamp it was given](../../src/transport/ws/messageHandler.test.ts#L84)).
- A malformed `ping` arriving mid-run gets its own `error` frame, the run's deltas continue unaffected, and exactly one `stream_end` is the very last frame ([validated by: keeps one stream_end, last, when a malformed ping lands mid-run](../../src/transport/ws/messageHandler.test.ts#L377)).
- A three-round tool conversation still produces exactly one `stream_end`, as its last frame ([validated by: sends one stream_end for a three-round tool conversation](../../src/transport/ws/messageHandler.test.ts#L398)).
- Unparseable JSON is rejected before the server can tell what frame type it was meant to be, so it produces `error` (`INVALID_FORMAT`) alone and is never dispatched; this is the one case in which a client falls back on the socket closing ([validated by: answers unparseable JSON with INVALID_FORMAT alone and never dispatches it](../../src/transport/ws/connectionHandler.test.ts#L170)).

## What this replaces

- The rule in [websocket-protocol § 5.8](../hal-engine-websocket-protocol/spec.md) that the server MUST NOT send `stream_end` after an error is deleted, not supplemented, and a failed run now ends `error` then `stream_end` ([validated by: tells the client to retry when the provider is rate limited](../../src/transport/ws/messageHandler.test.ts#L314)).
- The client rule that a stream is complete at either `stream_end` or `error` is deleted with it: an `error` frame is advisory, and a run is complete at `stream_end` or when the socket closes ([validated by: keeps one stream_end, last, when a malformed ping lands mid-run](../../src/transport/ws/messageHandler.test.ts#L377)).
- No special case sending `stream_end` for a single error code existed to remove, because the general rule covers every code ([validated by: reports any other failure as a server error](../../src/transport/ws/messageHandler.test.ts#L323)).

## Operational resilience

- Under NIS-2 operational resilience, every accepted question now ends in a frame the client can act on, so a provider outage degrades one answer instead of leaving the client waiting on a run that never reports its end ([validated by: ends a provider failure mid-stream with error then stream_end, stream_end last](../../src/transport/ws/messageHandler.test.ts#L333)).

## Out of scope

Whether open entries are committed or discarded when a run ends badly (re-cinq/HALEngine#59, a separate defect on the same lines), what an `error` frame's message says, correlating a frame with a specific run, paths on which no frame is sent at all (a socket closing mid-run, a tool that never returns), and the unrelated interface signatures in the architecture spec.
