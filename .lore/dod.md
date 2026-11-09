# Definition of Done

> Resolve the tool credential per round instead of once per connection

**Strategy: `direct`** — The seam exists in the orchestrator to resolve credentials before tool execution. We write tests to verify this new behavior, which fail today because the hook is not invoked.

## Done when these pass

- [ ] **resolveAuthHeaders hook acceptance** — A two-round tool conversation whose hook returns different headers per round reaches the tool with the round-0 value in round 0 and the round-1 value in round 1
  `src/transport/ws/resolveAuthHeaders.acceptance.test.ts`
- [ ] **resolveAuthHeaders hook exactly once** — A round with two tool calls invokes the hook exactly once; a turn with no tool call invokes it zero times
  `src/transport/ws/resolveAuthHeaders.acceptance.test.ts`
- [ ] **session.authHeaders remains captured-at-upgrade** — After a run whose hook returned a different value, `session.authHeaders` still equals the value captured at upgrade — only the context is affected
  `src/transport/ws/resolveAuthHeaders.acceptance.test.ts`
- [ ] **CredentialExpiredError stream_end** — A hook throwing `CredentialExpiredError('<message>')` produces, in order: `{type: 'error', code: 'CREDENTIAL_EXPIRED', message: '<that message>'}` then `{type: 'stream_end'}`, over a real connection
  `src/transport/ws/resolveAuthHeaders.acceptance.test.ts`
- [ ] **onError exact match** — `onError` fires exactly once, with the same error instance, before the error frame is sent
  `src/transport/ws/resolveAuthHeaders.acceptance.test.ts`
- [ ] **other Error unchanged** — Any other `Error` thrown from the hook keeps today's generic `SERVER_ERROR` path unchanged
  `src/transport/ws/resolveAuthHeaders.acceptance.test.ts`
- [ ] **tested not assumed** — With no `resolveAuthHeaders` configured, a tool still receives the headers captured at upgrade — tested, not assumed
  `src/transport/ws/resolveAuthHeaders.acceptance.test.ts`
- [ ] **aliasing fix** — A tool executor that mutates `context.authHeaders.authorization` changes neither `session.authHeaders` nor the context handed to the next tool in the same round — the aliasing fix
  `src/transport/ws/resolveAuthHeaders.acceptance.test.ts`

## Facets

- [ ] Add `resolveAuthHeaders` to `OrchestratorHooks`
- [ ] Pass the resolved headers down to the tool context, ensuring it does not overwrite the session's headers
- [ ] Implement `CredentialExpiredError` and add `CREDENTIAL_EXPIRED` to error codes
- [ ] Handle `CredentialExpiredError` in the websocket message handler

## Out of scope

- Deciding which credential is resolved at all
- Detecting a downstream 401
- Re-running `auth.ws` mid-connection or re-authorising a resumed session
- Persisting or restoring credentials
