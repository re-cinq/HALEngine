# beforeToolCall Hook

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#72 |
| Status | Implemented          |

`OrchestratorHooks` had no member that fires around a tool call, so the only way to audit what the model attempted, or to refuse a call, was to wrap every executor at registration by hand. `beforeToolCall` is that seam, built once where the calls run: it sees each known tool call before its executor, and it can let the call proceed or answer it in the executor's place.

## Contract

- `beforeToolCall?: (session: ChatSession, call: ToolCall) => Promise<ToolResponse | undefined>` is an optional member of `OrchestratorHooks`, and `ToolCall` and `ToolResponse` are importable from the package root beside it, as `example/full-config.ts` does under `npm run typecheck:example` ([validated by: hands the executor the very object the model produced when the policy returns undefined](../../src/transport/ws/beforeToolCall.test.ts#L109)).
- With no `beforeToolCall` configured, each pending call runs exactly once through the registry, as before ([validated by: runs each pending call exactly once in a two-tool round when no policy is configured](../../src/transport/ws/beforeToolCall.test.ts#L99)).
- `undefined` means proceed: the executor runs and receives the same input object the model produced, with no defensive copy between the hook and the executor ([validated by: hands the executor the very object the model produced when the policy returns undefined](../../src/transport/ws/beforeToolCall.test.ts#L109)).

## Declining a call

- A returned `ToolResponse` declines the call: the executor never runs, and `response.result` reaches the model as the `tool_result` whose `toolUseId` is the declined call's id ([validated by: answers a declined call with the policy's result under its own id and never runs the executor](../../src/transport/ws/beforeToolCall.test.ts#L119)).
- In a round where one call is declined and another proceeds, the model receives a `tool_result` for both, in the order of the `tool_use` blocks ([validated by: answers both calls of a round where one is declined and one proceeds, in order](../../src/transport/ws/beforeToolCall.test.ts#L130)).
- A declined response takes the executor's path in full: its `clientMessages` reach the browser with an assigned entry index, the run still ends in `stream_end`, and the next user message on the same socket is answered ([validated by: delivers a declined response's client messages to the browser, then answers the next message](../../src/transport/ws/beforeToolCall.test.ts#L202)).
- A declined response with `suppressAssistantResponse: true` suppresses exactly as a tool's would, with one `suppress_output` chunk ([validated by: suppresses on a declined response that asks for it, exactly as a tool would](../../src/transport/ws/beforeToolCall.test.ts#L143)).
- The wording of a declined result belongs to the consumer; the engine only carries it ([validated by: answers a declined call with the policy's result under its own id and never runs the executor](../../src/transport/ws/beforeToolCall.test.ts#L119)).

## When it fires

- The hook fires only for a tool name the registry has, so a call to an unknown tool is never presented to the policy and keeps the registry's own unknown-tool path ([validated by: never consults the policy for a tool the registry does not have](../../src/transport/ws/beforeToolCall.test.ts#L160)).
- It fires once per requested call per round, not once per turn: one tool in each of three rounds is three calls, and two tools in one round is two ([validated by: consults the policy once per requested call per round across three rounds](../../src/transport/ws/beforeToolCall.test.ts#L225), [validated by: consults the policy once for each call of a two-tool round](../../src/transport/ws/beforeToolCall.test.ts#L235)).
- Calls within a round are presented concurrently, inside the round's existing `Promise.all`, with no ordering guarantee between them ([validated by: consults the policy once for each call of a two-tool round](../../src/transport/ws/beforeToolCall.test.ts#L235)).

## A policy that throws

- A throwing policy declines its call rather than ending the conversation: the executor does not run, the model receives a `tool_result` naming the tool, `stream_end` is sent, `afterModelResponse` fires once, and `onError` does not fire, because the turn did not fail ([validated by: declines the call when the policy throws, and the turn survives with every hook but onError](../../src/transport/ws/beforeToolCall.test.ts#L181)).
- Every `tool_use` block the provider was sent must be answered by a `tool_result`, so a raw throw escaping the round would leave the conversation unanswerable; catching it keeps the turn alive ([validated by: declines the call when the policy throws, and the turn survives with every hook but onError](../../src/transport/ws/beforeToolCall.test.ts#L181)).

## Personal data and oversight

- **GDPR.** The engine adds no log line carrying a value from the tool input, for a declined or an allowed call; the throw path logs the tool name and the error's type only ([validated by: writes no value from the tool input to any log line, for a declined and an allowed call](../../src/transport/ws/beforeToolCall.test.ts#L244)).
- **GDPR.** The hook receives the model's raw tool input and, through `session`, the caller's `authHeaders`; the TSDoc says so, and a policy that logs either is logging personal data and credential material ([validated by: hands the executor the very object the model produced when the policy returns undefined](../../src/transport/ws/beforeToolCall.test.ts#L109)).
- **EU AI Act, Article 14.** The TSDoc names this hook as the supported seam for a human-oversight control and points at `docs/adding-a-tool.md` for what a declined call looks like to the model; the engine asserts nothing about any policy installed through it ([validated by: answers a declined call with the policy's result under its own id and never runs the executor](../../src/transport/ws/beforeToolCall.test.ts#L119)).

## Out of scope

A symmetric `afterToolCall` hook; rewriting a tool call's input; per-tool policy on the registry; the unknown-tool message (re-cinq/HALEngine#51) and the tool-call deadline (re-cinq/HALEngine#50), whose results this hook only reads; and the `tool` entry already sent to the browser before any policy runs. The wire contract (`src/types/messages.ts`) and the registry (`src/orchestration/tools/registry.ts`) are untouched.
