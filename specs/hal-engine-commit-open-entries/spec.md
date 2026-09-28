# Commit Open Entries

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#59 |
| Status | Implemented          |

A streaming entry is born with `isStreaming: true`, and only a commit flips it to `false` and sends its `entry_commit` frame. The commit used to run only on a `stop` chunk, so a provider that threw mid-stream, or a round that ended on a tool call with no `stop`, left the entry streaming in session state forever. That is invisible today only because a session is deleted when its socket closes; once stored entries are replayed on resume, a resumed client would render the never-committed entry as streaming for the rest of the conversation.

## Committing

- `handleUserMessage` wraps its stream loop in a `try`/`finally` that commits whatever is still open, so a throw, a stopless end and a `stop` all close every entry the run opened ([validated by: commits a partial answer as streamed, before the error, when the provider throws](../../src/transport/ws/messageHandler.test.ts#L342)).
- A provider that throws after streaming text leaves no entry streaming, the assistant entry keeps the content exactly as streamed, and the client receives `entry_commit` for it before the `error` frame and then `stream_end` ([validated by: commits a partial answer as streamed, before the error, when the provider throws](../../src/transport/ws/messageHandler.test.ts#L342), [validated by: ends a provider failure mid-stream with error then stream_end, stream_end last](../../src/transport/ws/messageHandler.test.ts#L259)).
- A thinking segment open when the provider throws is committed as well, so both open entries are covered, not only the assistant one ([validated by: commits an open thinking entry too when the provider throws mid-thought](../../src/transport/ws/messageHandler.test.ts#L362)).
- A round that yields text, then a tool call, then ends with no `stop` chunk commits the assistant entry, and `stream_end` follows it with no entry left streaming ([validated by: commits the answer when a round ends on a tool call with no stop chunk](../../src/transport/ws/messageHandler.test.ts#L376)).
- A turn that ends on `stop` sends exactly one `entry_commit` per opened entry: the `stop` path clears both open indices, so the `finally` after it commits nothing twice ([validated by: sends one commit per opened entry when the turn ends on a stop chunk](../../src/transport/ws/messageHandler.test.ts#L388)).
- With suppression active when the provider throws, the open entries are committed in the session and no `entry_commit` frame is sent, as on every suppressed path ([validated by: records the open entries under suppression without sending a commit when the provider throws](../../src/transport/ws/messageHandler.test.ts#L396)).

## Why the partial answer is kept

- Discarding it server-side would make the stored conversation disagree with what the customer already saw delta by delta, and a resumed transcript would be shorter than the live one was, so the content is committed exactly as streamed ([validated by: commits a partial answer as streamed, before the error, when the provider throws](../../src/transport/ws/messageHandler.test.ts#L342)).
- `entry_commit` now arrives on terminal paths that previously sent none, so a client counting commit frames sees more of them; no wire type changes ([validated by: commits the answer when a round ends on a tool call with no stop chunk](../../src/transport/ws/messageHandler.test.ts#L376)).

## Out of scope

Which frames terminate a turn and the client's busy contract (re-cinq/HALEngine#60); what a replay does with the committed entries; marking an entry committed after an error as truncated, which would be a wire-type change nobody has asked for; flushing text the thinking-tag parser still buffers on a path with no `stop`, which the client never saw; and how a consuming client renders a partial entry.
