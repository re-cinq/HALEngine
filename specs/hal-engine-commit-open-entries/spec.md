# Commit Open Entries

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#59, re-cinq/HALEngine#105 |
| Status | Implemented          |

A streaming entry is born with `isStreaming: true`, and only a commit flips it to `false` and sends its `entry_commit` frame. The commit used to run only on a `stop` chunk, so a provider that threw mid-stream, or a round that ended on a tool call with no `stop`, left the entry streaming in session state forever. That is invisible today only because a session is deleted when its socket closes; once stored entries are replayed on resume, a resumed client would render the never-committed entry as streaming for the rest of the conversation.

## Committing

- `handleUserMessage` wraps its stream loop in a `try`/`finally` that commits whatever is still open, so a throw, a stopless end and a `stop` all close every entry the run opened ([validated by: commits a partial answer as streamed, before the error, when the provider throws](../../src/transport/ws/messageHandler.test.ts#L390)).
- A provider that throws after streaming text leaves no entry streaming, the assistant entry keeps the content exactly as streamed, and the client receives `entry_commit` for it before the `error` frame and then `stream_end` ([validated by: commits a partial answer as streamed, before the error, when the provider throws](../../src/transport/ws/messageHandler.test.ts#L390), [validated by: ends a provider failure mid-stream with error then stream_end, stream_end last](../../src/transport/ws/messageHandler.test.ts#L306)).
- A thinking segment open when the provider throws is committed as well, so both open entries are covered, not only the assistant one ([validated by: commits an open thinking entry too when the provider throws mid-thought](../../src/transport/ws/messageHandler.test.ts#L411)).
- A round that yields text, then a tool call, then ends with no `stop` chunk commits the assistant entry, and `stream_end` follows it with no entry left streaming ([validated by: commits the answer, flagged truncated, when a round ends on a tool call with no stop chunk](../../src/transport/ws/messageHandler.test.ts#L425)).
- A turn that ends on `stop` sends exactly one `entry_commit` per opened entry: the `stop` path clears both open indices, so the `finally` after it commits nothing twice ([validated by: sends one commit per opened entry when the turn ends on a stop chunk](../../src/transport/ws/messageHandler.test.ts#L439)).
- With suppression active when the provider throws, the open entries are committed in the session and no `entry_commit` frame is sent, as on every suppressed path ([validated by: records the open entries under suppression without sending a commit when the provider throws](../../src/transport/ws/messageHandler.test.ts#L447)).

## Why the partial answer is kept

- Discarding it server-side would make the stored conversation disagree with what the customer already saw delta by delta, and a resumed transcript would be shorter than the live one was, so the content is committed exactly as streamed ([validated by: commits a partial answer as streamed, before the error, when the provider throws](../../src/transport/ws/messageHandler.test.ts#L390)).
- `entry_commit` now arrives on terminal paths that previously sent none, so a client counting commit frames sees more of them; no wire type changes ([validated by: commits the answer, flagged truncated, when a round ends on a tool call with no stop chunk](../../src/transport/ws/messageHandler.test.ts#L425)).

## Marking what was cut short

- Committing a cut-off entry keeps what the customer saw, but on its own a committed entry reads as a finished answer, and the `error` frame that explained it is not stored, so a replay would present half a sentence as a complete reply; the flag carries that fact on the entry itself ([validated by: flags a partial answer truncated in the session and re-sends it with the flag before its commit](../../src/transport/ws/messageHandler.test.ts#L464)).
- An entry still open when the run ends, which after a `stop` is never the case, is marked `truncated: true` before it is committed, so the flag lives on the stored entry that any replay sends ([validated by: flags a partial answer truncated in the session and re-sends it with the flag before its commit](../../src/transport/ws/messageHandler.test.ts#L464)).
- A live client learns it from an `entry_upsert` of that entry, carrying the flag, sent just before its `entry_commit` ([validated by: flags a partial answer truncated in the session and re-sends it with the flag before its commit](../../src/transport/ws/messageHandler.test.ts#L464)).
- A thinking entry cut off mid-thought is flagged the same way ([validated by: flags an open thinking entry truncated when the provider throws mid-thought](../../src/transport/ws/messageHandler.test.ts#L483)).
- A round that ends on a tool call with no `stop` flags its answer too ([validated by: commits the answer, flagged truncated, when a round ends on a tool call with no stop chunk](../../src/transport/ws/messageHandler.test.ts#L425)).
- An entry committed on a `stop` never carries the field and is sent once ([validated by: leaves an entry committed on a stop chunk without the flag and sends it once](../../src/transport/ws/messageHandler.test.ts#L492)).
- A suppressed entry is flagged in the session like any other, since the flag describes the entry, but it is never re-sent: it is hidden from the customer, so nothing is shown as cut off ([validated by: flags a suppressed entry that a throw cut short in the session but never re-sends it](../../src/transport/ws/messageHandler.test.ts#L504)).
- Text the thinking-tag parser still held back, a tail that might have opened a tag, is flushed into the entry before it is flagged, so a cut-off answer keeps everything the model produced, as a `stop` already did ([validated by: keeps the text the thinking-tag parser still held when a throw cuts the answer short](../../src/transport/ws/messageHandler.test.ts#L516)).
- The same holds for a suppressed entry: the flushed tail is stored and the entry flagged, and none of it reaches the customer, who only ever saw `entry_skip` for it ([validated by: keeps the held text in a suppressed entry too, flagged, without sending any of it](../../src/transport/ws/messageHandler.test.ts#L528)).

## Out of scope

Which frames terminate a turn and the client's busy contract (re-cinq/HALEngine#60); what a replay does with the committed entries; and how a consuming client renders a partial entry.
