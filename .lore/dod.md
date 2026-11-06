# Definition of Done

> Resolve the tool credential per round instead of once per connection

**Strategy: `direct`** — The seam exists in the orchestrator to resolve credentials before tool execution. We write tests to verify this new behavior, which fail today because the hook is not invoked.

## Done when these pass

- [ ] **resolveAuthHeaders hook acceptance** — A two-round tool conversation whose hook returns different headers per round reaches the tool with the round-0 value in round 0 and the round-1 value in round 1
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
