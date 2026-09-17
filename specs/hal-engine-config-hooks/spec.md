# Config-Installed Orchestrator Hooks

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#36 |
| Status | Shipped              |

`OrchestratorHooks` is the engine's only lifecycle seam, and `HalEngineConfig.orchestrator.hooks` is the supported way to install it: `createHalEngine` forwards the set to `createChatOrchestrator`, so a hook a deployer passes through the factory reaches the running orchestrator rather than sitting unread on the config object. This spec pins that forwarding and the measured semantics the seam already carries, so the hook-based features that follow in this epic — transparency disclosure, audit and usage recording, human oversight, provider failover — specify against real behaviour rather than against what the hook names suggest.

## Installing hooks through config

- A hook passed through `orchestrator.hooks` is forwarded to the orchestrator and fires ([validated by: forwards an orchestrator hook, so one passed through the config actually fires](../../src/config.test.ts#L18)).
- An engine built with no `orchestrator` key at all still processes a message, so the field is optional in fact and not only in the type ([validated by: processes a message when the config declares no orchestrator key at all](../../src/config.test.ts#L94)).
- A `beforeModelResponse` hook installed through config is handed the base system prompt built from `prompt`, proving the hook reaches the orchestrator and is wired into the prompt pipeline rather than only being stored on the config ([validated by: hands a config-installed beforeModelResponse hook the built base system prompt, not merely storing it](../../src/config.test.ts#L107)).
- The value the hook returns then replaces the system prompt the provider receives; this is exercised at the orchestrator layer because `HalEngineConfig.provider` takes a `ProviderConfig` and offers no seam to inject a recording provider through config ([validated by: replaces system prompt with returned value](../../src/orchestration/chatOrchestrator.test.ts#L194)).
- For a session that completes without error the hooks fire in the order `beforeSession` → `beforeUserInput` → `afterUserInput` → `beforeModelResponse` → `afterModelResponse` → `afterSession` ([validated by: fires the lifecycle hooks in documented order for a session that completes without error](../../src/config.test.ts#L131)).

## Engine startup

- The engine's `start()` method rejects the returned promise when it cannot bind the configured port, rather than emitting an unhandled error event that would take the process down ([validated by: rejects instead of taking the process down with an unhandled error event](../../src/config.test.ts#L173)).

## Measured semantics — out of scope

These three properties of `src/orchestration/chatOrchestrator.ts` are recorded so the hook features that follow specify against real behaviour. This issue changes none of them; each is a separate, out-of-scope change owned by no issue in this epic.

- `beforeSession` is awaited before the `try` block opens ([chatOrchestrator.ts#L74](../../src/orchestration/chatOrchestrator.ts#L74)), so a throw there escapes before the `catch`/`finally` exist and skips both `onError` and `afterSession`.
- The `catch` gates `onError` on `error instanceof Error` ([chatOrchestrator.ts#L127](../../src/orchestration/chatOrchestrator.ts#L127)), so a rejection that is not an `Error` — a thrown string or object — bypasses `onError` entirely while still propagating to the caller.
- `afterModelResponse` is called once per user message after the round loop exits ([chatOrchestrator.ts#L125](../../src/orchestration/chatOrchestrator.ts#L125)), and is passed the `lastUsage` local — the most recent round's usage, not a sum across tool rounds, so a deployer using the hook for billing or audit under-counts every turn that ran tools.
