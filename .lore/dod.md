# Definition of Done

> ChatSession.entries accumulates every user question, assistant answer, thinking segment and tool argument object for the life of the session, with no bound and no way to drop or mask an entry — the whole vocabulary for writing session state (appendEntry, appendDelta, commitEntry in src/orchestration/entryMutations.ts) is purely additive.

**Strategy: `direct`** — The engine configuration provides a direct seam for supplying a history policy at construction, and the orchestrator exposes processMessage methods to observe the policy's effects on the stored session.

## Done when these pass

- [ ] **maxContentEntries bound** — retains the exact array length but clears the content of older entries (leaving their roles, indices and timestamps intact), preserving their slots for subsequent delta merges
      `src/historyPolicy.acceptance.test.ts`
- [ ] **redactEntry transform** — rewrites ToolEntry and AssistantEntry contents when they are finalized, leaves UserEntry untouched, and is rejected if it alters an entry's role
      `src/historyPolicy.acceptance.test.ts`

## Facets

- [x] Add the `history` property to `HalEngineConfig` and `ChatOrchestratorOptions`.
- [x] Implement `trimOldContent` in `entryMutations.ts` (pure function: clears content of entries beyond the bound, never splices).
- [x] Implement `maxContentEntries` trimming logic — call `trimOldContent` from `processMessageStream.finally` once `history` is threaded through.
- [x] Implement `redactEntry` transformation logic in `entryMutations.ts` for ToolEntry and AssistantEntry.
- [x] Add error checking in `entryMutations.ts` to ensure `redactEntry` preserves the entry `role`.
- [x] Update documentation and examples (`docs/getting-started.md`) to reflect `SessionStore.delete` and retention policies.

## Out of scope

- Age-based expiry of sessions.
- Redaction of engine logging.
- Any time-based bounds.
- SessionStore interface modifications beyond clarifying existing `delete` behavior in docs.
