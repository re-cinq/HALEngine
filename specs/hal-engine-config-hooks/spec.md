# Config-Installed Orchestrator Hooks

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#36 |
| Status | Shipped              |

`OrchestratorHooks` is the engine's only lifecycle seam, and `HalEngineConfig.orchestrator.hooks` is the supported way to install it: `createHalEngine` forwards the set to `createChatOrchestrator`, so a hook a deployer passes through the factory reaches the running orchestrator rather than sitting unread on the config object. This spec pins that forwarding and the measured semantics the seam already carries, so the hook-based features that follow in this epic — transparency disclosure, audit and usage recording, human oversight, provider failover — specify against real behaviour rather than against what the hook names suggest.

## Installing hooks through config

- A hook passed through `orchestrator.hooks` is forwarded to the orchestrator and fires ([validated by: forwards an orchestrator hook, so one passed through the config actually fires](../../src/config.test.ts#L19)).
- An engine built with no `orchestrator` key at all still processes a message, so the field is optional in fact and not only in the type ([validated by: processes a message when the config declares no orchestrator key at all](../../src/config.test.ts#L95)).
- A `beforeModelResponse` hook installed through config is handed the base system prompt built from `prompt`, proving the hook reaches the orchestrator and is wired into the prompt pipeline rather than only being stored on the config ([validated by: hands a config-installed beforeModelResponse hook the built base system prompt, not merely storing it](../../src/config.test.ts#L129)).
- The value the hook returns then replaces the system prompt the provider receives; this is exercised at the orchestrator layer because `HalEngineConfig.provider` takes a `ProviderConfig` and offers no seam to inject a recording provider through config ([validated by: replaces system prompt with returned value](../../src/orchestration/chatOrchestrator.test.ts#L246)).
- For a session that completes without error the hooks fire in the order `beforeSession` → `beforeUserInput` → `afterUserInput` → `beforeModelResponse` → `afterModelResponse` → `afterSession` ([validated by: fires the lifecycle hooks in documented order for a session that completes without error](../../src/config.test.ts#L153)).
- A `beforeSession` that throws reaches the caller as a rejection, and also runs `onError` with the thrown error and then `afterSession`, because the call sits inside the same `try`/`finally` as the rest of the turn. An `afterSession` hook called under this condition can infer the session never advanced past `beforeSession`: no user-input hooks ran, no model response was generated, and no tool rounds were started — a cleanup hook that allocates in `beforeSession` and frees in `afterSession` will therefore always see the allocation and the release on the same error path ([validated by: runs onError then afterSession when it throws, and still rejects to the caller](../../src/orchestration/chatOrchestrator.test.ts#L141)).
- `afterModelResponse` is called once per user message after the round loop exits and is passed `totalUsage` — the sum of the usage every provider call in the turn reported, not the last round alone ([validated by: sums the usage of every round, not only the last](../../src/orchestration/chatOrchestrator.test.ts#L616)).
- Every rejection reaches `onError`: a value that is not already an `Error` is wrapped in one whose `cause` is that original value, so a hook typed against `Error` still fires and a hook that wants the raw value can still reach it, while the caller receives the original rejection unchanged ([validated by: wraps a non-Error rejection in an Error whose cause is the original and still rejects the caller with the original](../../src/orchestration/chatOrchestrator.test.ts#L336)).

## Engine startup

- The engine's `start()` method rejects the returned promise when it cannot bind the configured port, rather than emitting an unhandled error event that would take the process down ([validated by: rejects instead of taking the process down with an unhandled error event](../../src/config.test.ts#L195)).

