# Definition of Done

> A token that expires mid-conversation turns every subsequent tool call into a downstream 401, which reaches the user as a silent failed answer with no explanation. Any deployment whose downstream API issues short-lived credentials needs a named behaviour for this case: refresh, re-authenticate, or end the conversation with a message the user can act on.

**Strategy: `direct`** — The `OrchestratorHooks` and `ToolContext` seam already exists in the real entry points. The tests use a real websocket connection and chat orchestrator, so they can directly verify if `resolveAuthHeaders` is called per tool round and propagates its results or specific errors appropriately.

## Done when these pass

- [ ] **resolves auth headers per round and hands them to the tools** — verifying that the hook is invoked correctly per tool round and tools receive the newly resolved headers instead of the initial connection headers.
      `src/transport/ws/resolveAuthHeaders.acceptance.test.ts`
- [ ] **produces error CREDENTIAL_EXPIRED and stream_end over a real connection** — verifying that when the hook rejects with `CredentialExpiredError`, it ends the turn correctly with a `CREDENTIAL_EXPIRED` client error and `stream_end`.
      `src/transport/ws/resolveAuthHeaders.acceptance.test.ts`

## Facets

- [x] Export `CredentialExpiredError` from the package root.
- [x] Add `resolveAuthHeaders` to `OrchestratorHooks`.
- [x] Update `contextFor` inside the tool loop to fetch auth headers via the hook per round if provided, otherwise default to the session's auth headers.
- [x] Catch `CredentialExpiredError` and emit the correct `error` and `stream_end` WebSocket frames.
- [x] Ensure other Errors throw unmodified `SERVER_ERROR` frames.
- [x] Cover the `onError` true branch and non-Error ternary arm in `resolveRoundHeaders` for orchestration branch coverage.
- [x] Cover the `CredentialExpiredError` true branch in `resolveRoundHeaders` and `wsErrorHandler` via the recording-socket engine helper (non-WS unit test), so the branch is hit regardless of real-WS test timing.

## Out of scope

- Deciding which credential is resolved at all.
- Detecting a downstream 401 reactively.
- A veto hook before tool execution.
- Re-running `auth.ws` mid-connection or re-authorising a resumed session.
- Persisting or restoring credentials.
