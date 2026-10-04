# Abandon the Turn When Its Socket Closes

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#49 |
| Status | Implemented          |

Closing a socket used to stop nothing. The turn it had started kept generating billed tokens, kept calling tools on behalf of a user who had left, and kept writing frames to a socket nobody read, silently, since `ws` accepts a send on a closed socket. A close now abandons the socket's turn. It cancels the turn, not the conversation: the session outlives the close, as before.

## The connection signal

- Each connection has one `AbortController` of its own, and its signal reaches the message handler as the optional fourth argument of `ConnectionHandlerDeps.handleMessage`: every message on a connection is handed the same signal, and another connection gets another ([validated by: hands every message on a connection the same signal, and each connection its own](../../src/transport/ws/connectionHandler.test.ts#L170)).
- The message handler hands that signal on to the run, as `processMessageStream`'s `signal` ([validated by: hands the run its connection signal](../../src/transport/ws/messageHandler.test.ts#L778)).
- The socket's `close` listener aborts it first, before the session is torn down and before `onDisconnect` is called ([validated by: aborts the connection signal when its socket closes, before onDisconnect is called](../../src/transport/ws/connectionHandler.test.ts#L191)).

## When the socket closes mid-turn

- The message handler stops pulling the turn's chunks. A chunk that arrives after the close is not processed, and leaving the loop returns the run's generator, so the run pulls nothing more from the provider while its own teardown still runs: `afterSession` fires once and `onError` never ([validated by: stops the run pulling chunks, fires afterSession once and onError never, and keeps the answer as it stood](../../src/transport/abandonOnClose.test.ts#L88)).
- No `error` and no `stream_end` follow the close, since nobody is left to read a terminal frame. The answer cut off is committed as it stood and flagged `truncated: true`, so it is re-sent and committed, the two frames any cut-off answer gets, here written to a closed socket ([validated by: abandons the turn mid-stream with no error and no stream_end, committing the cut-off answer as it stood](../../src/transport/ws/messageHandler.test.ts#L747)).
- The session keeps no entry still streaming: the answer is stored committed and truncated, its content what streamed before the close, so a session resumed later shows the turn as it stood ([validated by: stops the run pulling chunks, fires afterSession once and onError never, and keeps the answer as it stood](../../src/transport/abandonOnClose.test.ts#L88)).
- The abandonment is logged once, at `info`, as `turn abandoned: its socket closed` with `sessionId` and `elapsedMs` alone, and from the close on no line carries the user's id or a credential ([validated by: logs the abandonment as its session id and elapsed time alone, and no user id or credential from the close on](../../src/transport/abandonOnClose.test.ts#L102)).
- A message queued behind the turn, or handed over after the close, is dropped: nothing is recorded, the orchestrator is never asked and nothing is sent ([validated by: drops a turn whose connection signal is already aborted: records nothing, asks nothing, sends nothing](../../src/transport/ws/messageHandler.test.ts#L765)).
- A `ping` is answered whatever the signal ([validated by: answers a ping whose connection signal is aborted](../../src/transport/ws/messageHandler.test.ts#L798)).
- `stop()` closes every socket, so a server that stops abandons every turn in flight ([validated by: abandons a turn in flight when the server stops, as a deploy does](../../src/transport/abandonOnClose.test.ts#L142)).

## The run

- `ChatOrchestrator.processMessageStream` takes an optional second argument, `{signal}`, and hands the signal to `provider.sendMessage` as `params.signal`, the very object the caller passed ([validated by: reaches the provider as params.signal, the very object the caller passed](../../src/orchestration/chatOrchestrator.test.ts#L704)).
- A run whose provider stops on the abort ends with that round: `afterModelResponse` does not fire, since there is no finished answer, and `afterSession` fires once ([validated by: skips afterModelResponse when its provider stops on the abort, firing afterSession once](../../src/orchestration/chatOrchestrator.test.ts#L723)).
- An abort is a controlled stop, not a failure: a failure after the signal aborted ends the run quietly, with no `onError`, no `afterModelResponse`, since there is no finished response, and no rethrow, while `afterSession` fires once ([validated by: ends quietly when the provider fails after the signal aborted: no onError, afterModelResponse or rethrow, afterSession once](../../src/orchestration/chatOrchestrator.test.ts#L729)).
- Each tool call's `ToolContext.signal` is composed from the run's signal and the call's own through `AbortSignal.any`, so neither replaces the other: abandoning the run aborts it, and so does the call's deadline ([validated by: aborts each call's context signal when its run is abandoned, the signal still the call's own](../../src/toolDeadline.test.ts#L370), [validated by: answers a call that never settles at toolTimeoutMs with a result naming the tool and the deadline, and aborts its signal](../../src/toolDeadline.test.ts#L100)).
- A round whose run is abandoned while a tool hangs ends at once, with a deadline or with `toolTimeoutMs: 0`, and no provider call follows it ([validated by: ends the round at once when its run is abandoned while a tool hangs, with a deadline or with none](../../src/toolDeadline.test.ts#L380)).
- A round leaves no listener on the run's signal once its calls have settled, so a long-lived connection does not collect one per tool call ([validated by: leaves no abort listener on the run signal once its calls have settled](../../src/toolDeadline.test.ts#L390)).
- Nothing a round produced is recorded once its run is abandoned, not even an entry a tool that finished first asked the client to show, and the provider is asked nothing more ([validated by: records nothing the round produced once its run is abandoned, and asks the provider nothing more](../../src/toolDeadline.test.ts#L400)).
- `withRetry` composes the run's signal with each attempt's own rather than replacing it, so an abort reaches the attempt in flight, and its own timeouts still abort an attempt when no signal is passed ([validated by: composes a caller signal with each attempt signal, so a caller abort reaches the provider while its stream is live](../../src/providers/withRetry.test.ts#L58), [validated by: abandons an attempt whose first chunk never arrives, aborts its signal, calls return on it, and retries](../../src/providers/withRetry.test.ts#L173)).

## Compatibility

- The change is MINOR. `processMessageStream`'s option and `handleMessage`'s fourth parameter are both optional, so a caller passing neither is unchanged. The behaviour is not: a turn that used to run to completion after its socket closed is now abandoned, and its client gets no `stream_end` ([validated by: stops the run pulling chunks, fires afterSession once and onError never, and keeps the answer as it stood](../../src/transport/abandonOnClose.test.ts#L88)).

## Rationale

The controller belongs to the connection. It is not a field of `ChatSession`, which a store persists and an `AbortSignal` cannot survive, and it is not per message, because a close has to abandon the messages queued behind the turn as well as the turn. A session resumed on another connection keeps its own signal, so the turn the old socket started streams to that socket until it closes, and is abandoned then.

**GDPR, transfer volume.** What a closed tab now stops depends on the provider. On Bedrock the abort closes the live HTTP/2 stream, so the vendor stops sending. On Vertex, measured at `@google-cloud/vertexai` 1.10.4, the vendor request runs to completion and only the engine's reading stops ([providers § Cancellation](../hal-engine-providers/spec.md#cancellation)). A tool stops its own downstream request only if it honours `ToolContext.signal`.

**NIS-2, operational resilience.** A socket that misses a heartbeat is terminated and `stop()` closes every socket, and both reach the same `close` listener, so a deploy that stops the server abandons every turn in flight unless connections are drained first.

## Out of scope

Re-targeting a live stream at a reconnected socket; barge-in, where a new message cancels the run before it; rolling back a downstream write an abandoned tool call started; `stream_end` on error paths in general; and a grace period or a flag to keep a turn running after its socket closed, since nobody can receive what it would stream. The two cancellation seams this composes with are re-cinq/HALEngine#48 and re-cinq/HALEngine#50.
