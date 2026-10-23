# History Controls

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#41 |
| Status | Implemented          |

`orchestrator.entries` decides what a stored conversation keeps of its entries. `maxContentEntries` empties every entry older than the newest N when a turn ends, and `redactEntry` rewrites every entry but a user's once its content is final. Unset, the engine stores every entry as written, as it always has.

## Background

`ChatSession.entries` holds every question, answer, thought and tool argument object of a conversation, and nothing bounded or rewrote it. `ContextConfig` looks like a bound but only slices the copy a turn sends the provider. Once a durable store and resume let a conversation outlive its socket, the entries are personal data held for as long as the store keeps the session, and the tool arguments a model writes, a booking reference or a name, are the category a deployer most often has to account for.

## Configuration

- `HalEngineConfig.orchestrator.entries` accepts `maxContentEntries` and `redactEntry`, both optional; with no policy, every entry is stored as written and an answer still open when its turn ends is closed as truncated, as before ([validated by: stores every entry as written and closes an open answer as truncated, exactly as before](../../src/orchestration/entryMutations.test.ts#L42)).
- A policy the engine cannot honour fails when the engine is built: a `maxContentEntries` that is not a whole number of at least 1, or a `redactEntry` that is not a function, throws an error naming the setting ([validated by: throws at construction, naming orchestrator.entries.maxContentEntries, for a bound of 0; a bound of 5 or no policy constructs normally](../../src/config.test.ts#L441), [validated by: refuses a maxContentEntries of 0, 2.5, NaN or -3, naming the setting](../../src/orchestration/entryMutations.test.ts#L194), [validated by: refuses a redactEntry that is not a function](../../src/orchestration/entryMutations.test.ts#L211)).
- The orchestrator and the WebSocket transport each build their entry writer from the one policy, so an entry the transport writes is kept as one the orchestrator writes is ([validated by: applies orchestrator.entries to the transport's writes: a redacted tool input stored and sent, the answer redacted at commit, and older entries cleared when the turn ends](../../src/historyControls.test.ts#L80)).

## The content bound

- When a turn ends, every entry older than the newest `maxContentEntries` is cleared: with a bound of 10, a session of 25 entries keeps the content of entries 15 to 24 and clears entries 0 to 14 ([validated by: clears entries 0 to 14 and keeps 15 to 24 when a 25-entry session closes its turn with maxContentEntries 10](../../src/orchestration/entryMutations.test.ts#L62)).
- A cleared entry stays at its index with its role and timestamp and is marked `cleared: true`; its text becomes `''` and a tool entry's `toolInput` becomes `{}`, so no index a client was sent shifts ([validated by: keeps every cleared entry at its index with its role and timestamp, so an index sent before the trim names the same entry](../../src/orchestration/entryMutations.test.ts#L82), [validated by: clears entries 0 to 14 and keeps 15 to 24 when a 25-entry session closes its turn with maxContentEntries 10](../../src/orchestration/entryMutations.test.ts#L62)).
- A cleared entry of a role the engine does not know, which a tool may store, keeps only its role and its timestamp ([validated by: keeps only the role and timestamp of a cleared entry whose role a tool invented, since its fields can't be judged](../../src/orchestration/entryMutations.test.ts#L93)).
- Nothing is cleared while a turn runs ([validated by: clears nothing while a turn runs, since the bound applies only when the turn closes](../../src/orchestration/entryMutations.test.ts#L104)).

## Redaction

- `redactEntry` rewrites a tool entry, and an entry a tool returns, before it is stored, so a policy that empties `toolInput` leaves the session holding no tool arguments ([validated by: rewrites a tool entry before it is stored, so the session holds no tool arguments](../../src/orchestration/entryMutations.test.ts#L116), [validated by: applies orchestrator.entries to the transport's writes: a redacted tool input stored and sent, the answer redacted at commit, and older entries cleared when the turn ends](../../src/historyControls.test.ts#L80), [validated by: redacts an entry a tool returns before it is stored, and yields the stored entry for the transport to send](../../src/historyControls.test.ts#L134)).
- An assistant or thinking entry is redacted once, when it is committed, and never while it is empty and streaming ([validated by: sees an answer once, when it is committed, and not while it is empty and streaming](../../src/orchestration/entryMutations.test.ts#L124), [validated by: applies orchestrator.entries to the transport's writes: a redacted tool input stored and sent, the answer redacted at commit, and older entries cleared when the turn ends](../../src/historyControls.test.ts#L80)).
- `redactEntry` never receives a user's entry ([validated by: never hands a user's own entry to redactEntry](../../src/orchestration/entryMutations.test.ts#L144)).
- A `redactEntry` that throws, or that returns an entry of another role, stores the entry cleared instead and logs one error naming only the entry's role ([validated by: stores the entry cleared and logs only its role when redactEntry returns another role](../../src/orchestration/entryMutations.test.ts#L152), [validated by: stores the entry cleared when redactEntry throws](../../src/orchestration/entryMutations.test.ts#L163)).
- Text the thinking-tag parser held back, which can reach an answer after its turn closed it, is redacted with the rest of that answer ([validated by: redacts an answer again when text the parser held back reaches it after the turn closed it](../../src/orchestration/entryMutations.test.ts#L178)).

## What the provider and a client see

- The turn after a redacted answer sends the provider the redacted text, not the text that streamed ([validated by: sends the provider the redacted answer, not the streamed one, on the turn after it](../../src/historyControls.test.ts#L113)).
- Cleared entries are left out of the messages a turn sends the provider ([validated by: leaves cleared entries out of the messages a turn sends the provider](../../src/orchestration/conversationContext.test.ts#L6)).
- The messages a turn sends start at a user message of text, never at a tool result whose call the window cut away ([validated by: starts at a user message of text, never at a tool result whose call the window cut away](../../src/orchestration/conversationContext.test.ts#L16)).
- A live client is sent a tool entry, and an entry a tool returns, as it was stored, so a redacted input looks the same live as on a resume's replay ([validated by: applies orchestrator.entries to the transport's writes: a redacted tool input stored and sent, the answer redacted at commit, and older entries cleared when the turn ends](../../src/historyControls.test.ts#L80), [validated by: redacts an entry a tool returns before it is stored, and yields the stored entry for the transport to send](../../src/historyControls.test.ts#L134)).
- A resumed client is sent a cleared entry as `entry_skip` ([validated by: replays an entry the content bound cleared as a skip, so a resumed client is shown no empty bubble](../../src/transport/sessionResume.test.ts#L360)).
- A conversation whose opening question was cleared has no preview in the conversation list ([validated by: is absent for a conversation whose opening question the content bound cleared](../../src/infrastructure/stores/sessionPreview.test.ts#L62)).

## Rationale

Entries are emptied in place rather than removed. `entry_upsert`, `entry_delta` and `entry_commit` address an entry by index, and the protocol has no message that resets a client's view, so a removal would shift every index a client holds.

The bound applies when a turn ends, not on every append. A turn reads its history once, at its start, so a mid-turn trim would gain nothing for that turn, and it would risk clearing the entry a turn is still streaming into.

A failed redaction stores the entry cleared. Storing the original would keep exactly what the deployer asked to keep out, and failing the turn would cost the customer an answer for a fault in configuration.

User entries are left to `beforeUserInput`, which already rewrites the user's text before the turn reads it; a second seam for the same text would be two places to keep in step.

The policy is `orchestrator.entries` because `transport.history` already names the conversation list.

## Limitations

A live client has already been shown an answer's text as it streamed when that answer is redacted at commit. Redaction governs what is stored, what a resume replays, and what later turns send the provider.

`redactEntry` should be safe to run twice on one entry: an answer that receives held-back text after its turn closed it is redacted again with that text appended.

Until a turn ends, a session can hold more than `maxContentEntries` entries with content.

The REST chat routes keep their own history in a router-local map, outside this policy and outside the session store.

## Out of scope

Age-based retention, which the session store owns through `InMemorySessionStore`'s `maxAgeMs` and `MongoSessionStore.eraseOlderThan`; erasing a conversation, which is `SessionStore.delete`; and what a consumer's own tools or logs keep.
