# History Policy

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#41 |
| Status | Shipped              |

The history policy bounds what `HalEngineConfig` stores in server-side conversation history. `history.maxContentEntries` trims by clearing entry content in place — never by splicing the array, so the WS protocol's index-addressed frames (`entry_delta`, `entry_commit`) continue to resolve to the same slot. `history.redactEntry(entry) => entry` rewrites a finalised entry before it is stored; it runs on `ToolEntry` at append time and on `AssistantEntry` at commit time. Both fields are optional; an engine configured without a `history` block behaves as it does today.

## Content bound

- `trimOldContent` clears the content of entries that fall outside the bound (`length - maxContentEntries` oldest entries), leaving the array length, each entry's role and each entry's timestamp unchanged; a `ToolEntry` has its `toolInput` cleared to `{}` rather than a `content` field set to `''`; when the bound is at least as large as the array length no entry is cleared
  ([validated by: clears content of entries beyond the bound, keeping array length, roles and timestamps](../../src/orchestration/entryMutations.test.ts#L5), [validated by: does not clear any entry when the bound covers all entries](../../src/orchestration/entryMutations.test.ts#L90), [validated by: clears toolInput of a ToolEntry in the cleared range](../../src/orchestration/entryMutations.test.ts#L105)).
- With `maxContentEntries: 10`, a session driven to 26 entries has `entries.length === 26` and the 16 oldest entries have `content === ''`, while the 10 newest retain their content; a cleared entry's role and timestamp survive, and an `entry_delta` addressed to a cleared index still merges to that slot
  ([validated by: maxContentEntries clears content but retains array slots](../../src/historyPolicy.acceptance.test.ts#L41)).
- `trimOldContent` is called after each turn completes in `processMessageStream`, so the bound is enforced on the stored session, not just in-memory; configuring `maxContentEntries: 2` on a session with 3 existing entries produces a 4-entry array whose first 2 entries are cleared
  ([validated by: trims session entries to the configured maxContentEntries bound after a turn completes](../../src/orchestration/chatOrchestrator.test.ts#L894)).

## Entry redaction

- `redactEntry(entry) => entry` runs on a `ToolEntry` before it is stored and on an `AssistantEntry` when `commitEntry` fires, leaving `UserEntry` untouched — `beforeUserInput` already owns the user-message path, and a second mechanism for the same content is duplication; a transform that returns a different `role` than it was given is rejected rather than stored
  ([validated by: redactEntry runs on ToolEntry and AssistantEntry, but not UserEntry, and rejects invalid role](../../src/historyPolicy.acceptance.test.ts#L86)).
- `applyRedaction(session, index, redactEntry)` writes the transform's result back to `session.entries[index]`, leaving the stored entry identical to the redacted object the transform returned
  ([validated by: stores the result of the redact transform in the session entry](../../src/orchestration/entryMutations.test.ts#L37)).
- When `applyRedaction` receives a transform that returns a different `role` than the original entry carried, it throws before writing to the session, so no partially-redacted entry is ever stored
  ([validated by: throws when the redact transform changes the entry role](../../src/orchestration/entryMutations.test.ts#L49)).
- `commitStreamingEntries` iterates `session.entries` at turn end and sets `isStreaming = false` on every assistant and thinking entry; any entry that was still streaming when the turn ended also has `truncated = true` set, while an already-committed entry is left without `truncated`; entries of other roles (user, tool) are left unchanged by the `continue` guard
  ([validated by: marks every streaming assistant or thinking entry as committed, and sets truncated on any still-streaming entry](../../src/orchestration/entryMutations.test.ts#L61)).
- `applyRedactionsForTurn` applies `redactEntry` to every `ToolEntry` and `AssistantEntry` added to the session between `turnStart` and `session.entries.length` during a single turn, leaving entries from earlier turns and user entries untouched; an `AssistantEntry` upserted by a tool via `entry_upsert` is redacted the same way as one the provider streamed
  ([validated by: applies the redactEntry transform to entries appended during a tool round](../../src/orchestration/chatOrchestrator.test.ts#L913), [validated by: redactEntry does not transform a user entry added during a tool round](../../src/orchestration/chatOrchestrator.test.ts#L933)).
