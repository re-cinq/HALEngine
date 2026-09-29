# Tool Budget

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#56, re-cinq/HALEngine#57 |
| Status | Implemented          |

The tool loop used to run `round <= maxToolRounds`, which is six iterations at the default of five, and the sixth executed tools whose results no provider call would ever read: the results were pushed onto `messages`, the loop ended, and the generator returned. Real data was fetched and paid for, and the model never saw it. `maxToolRounds` is now a gate immediately before tool execution rather than the loop's own condition, so every executed round is read by a following provider call.

## The two bounds

- At most `maxToolRounds` tool rounds are executed, and the provider is called at most `maxToolRounds + 1` times: with a provider that asks for a tool on every call, `maxToolRounds: 2` executes 2 rounds across 3 provider calls ([validated by: executes 2 tool rounds and makes 3 provider calls at maxToolRounds 2](../../src/orchestration/toolBudget.test.ts#L89)).
- The default of 5 executes 5 rounds across 6 provider calls, which is what the README's "5 rounds" has always claimed ([validated by: executes 5 tool rounds and makes 6 provider calls at the default budget](../../src/orchestration/toolBudget.test.ts#L95)).
- `maxToolRounds: 0` is meaningful: one provider call and no tool execution ([validated by: makes one provider call and executes no tool at maxToolRounds 0](../../src/orchestration/toolBudget.test.ts#L101)).
- The budget is normalized at construction with `Math.max(0, Math.floor(value))`, so a negative budget behaves as 0, and a non-finite one, `NaN` included, falls back to the default; either way the turn terminates ([validated by: treats a negative budget as 0 and still terminates](../../src/orchestration/toolBudget.test.ts#L108), [validated by: treats a NaN budget as the default and still terminates](../../src/orchestration/toolBudget.test.ts#L115)).
- A conversation that ends on its own is unchanged: one tool round, then an answer, is one execution across two provider calls at the default and at 5 ([validated by: leaves a conversation that ends on its own unchanged, at the default and at 5](../../src/orchestration/toolBudget.test.ts#L121)).

| `maxToolRounds` | Provider calls | Rounds executed | Rounds read by the model |
| --------------- | -------------- | --------------- | ------------------------ |
| before, default | 6              | 6               | 5                        |
| now, default    | 6              | 5               | 5                        |
| now, 0          | 1              | 0               | 0                        |

## When the budget runs out

- An exhausted budget ends the turn on the last provider call's output rather than buying one more call with `tools` omitted, which would only move the same cliff one round over ([validated by: ends an exhausted run with one synthetic stop and nothing else when no hook is installed](../../src/orchestration/toolBudget.test.ts#L143)).
- The exhausted run emits exactly one `warn` under category `orchestrator`, `tool budget exhausted`, carrying `maxToolRounds` and the names of the tools requested but not run; a `warn` is visible at the default `LOG_LEVEL` ([validated by: warns once, under orchestrator, with the budget and the tools it did not run](../../src/orchestration/toolBudget.test.ts#L131)).
- With no hook installed, the exhausted run yields exactly one chunk more than the gate alone left it: `{type: 'stop', stopReason: 'tool_budget_exhausted'}`, with no `usage`. It is a new `stopReason` value, not a new chunk type, and the WebSocket transport sends nothing for it, so the wire is unchanged for a consumer that installs nothing ([validated by: ends an exhausted run with one synthetic stop and nothing else when no hook is installed](../../src/orchestration/toolBudget.test.ts#L143)).
- **GDPR data minimisation, Art. 5(1)(c).** A tool call whose result nobody reads no longer happens: with `maxToolRounds: 1` and a provider that always asks for tools, the executor runs exactly once ([validated by: never runs a tool whose result nobody reads: one execution at maxToolRounds 1](../../src/orchestration/toolBudget.test.ts#L149)).

## Telling the consumer

- Nothing used to distinguish an exhausted budget from a successful answer or an outage, since the same `stream_end` fired either way; the synthetic `stop` now does ([validated by: ends an exhausted run with one synthetic stop and nothing else when no hook is installed](../../src/orchestration/toolBudget.test.ts#L143)).

- NIS-2 Article 21 asks for a degraded answer rather than a blank one, and the engine writes no user-facing prose of its own, so the sentence comes from the consumer through `OrchestratorHooks.onToolBudgetExhausted(session, budget)`, where `budget` is a `ToolBudgetInfo` of `{maxToolRounds, requestedTools}` ([validated by: ends the run on the hook's sentence as a text chunk, then the synthetic stop](../../src/orchestration/toolBudget.test.ts#L198)).
- A direct consumer sees every chunk, so the `stopReason` alone tells it; a transport-mediated consumer only sees frames, so the hook is its only signal ([validated by: ends an exhausted run with one synthetic stop and nothing else when no hook is installed](../../src/orchestration/toolBudget.test.ts#L143), [validated by: renders the hook's sentence as its own committed entry, then stream_end, with no error](../../src/transport/ws/messageHandler.test.ts#L490)).

- The hook fires once, from the gate, when the model asks for a round the budget refuses, with the budget and the refused round's tool names ([validated by: fires once with the budget and the refused round's tools at maxToolRounds 2](../../src/orchestration/toolBudget.test.ts#L173)).
- A conversation that ends on its own never fires it, at the default and at 5 ([validated by: never fires for a conversation that ends on its own, at the default and at 5](../../src/orchestration/toolBudget.test.ts#L181)).
- At `maxToolRounds: 0` it fires once with the tools requested by the single provider call ([validated by: fires once at maxToolRounds 0 with the single provider call's requested tools](../../src/orchestration/toolBudget.test.ts#L190)).
- A returned string is yielded as an ordinary `text` chunk and then the synthetic `stop`, always in that order: the round's own `stop` already committed its assistant entry, so the sentence opens a new entry, and only a following `stop` commits it ([validated by: ends the run on the hook's sentence as a text chunk, then the synthetic stop](../../src/orchestration/toolBudget.test.ts#L198)).
- A hook returning `undefined` or `''` yields only the synthetic `stop` ([validated by: yields only the synthetic stop when the hook returns undefined or an empty string](../../src/orchestration/toolBudget.test.ts#L204)).
- `afterModelResponse` fires after it and receives response text ending in the sentence, with the same `usage` as a run without the hook: the synthetic `stop` contributes nothing to token counts ([validated by: hands afterModelResponse text ending in the sentence, and the usage of a run without the hook](../../src/orchestration/toolBudget.test.ts#L214)).
- The non-streaming `processMessage` returns the model's text with the sentence appended ([validated by: returns the model's text with the sentence appended from processMessage](../../src/orchestration/toolBudget.test.ts#L229)).
- Over the WebSocket, the sentence is its own entry: `entry_upsert` with empty content, `entry_delta` carrying the sentence, `entry_commit` at that index, then `stream_end`. **NIS-2 Article 21:** the terminal frame is `stream_end`, never `error`, because this is a degraded answer, not a failed stream ([validated by: renders the hook's sentence as its own committed entry, then stream_end, with no error](../../src/transport/ws/messageHandler.test.ts#L490)).
- If a tool earlier in the turn suppressed the assistant response, the sentence is written into the session but announced only with `entry_skip`, with no `entry_delta`; suppression stays sticky for the whole stream ([validated by: writes the sentence into the session but only skips it on the wire under suppression](../../src/transport/ws/messageHandler.test.ts#L502)).
- The hook cannot buy another round; a consumer that wants more sets `maxToolRounds` higher ([validated by: fires once with the budget and the refused round's tools at maxToolRounds 2](../../src/orchestration/toolBudget.test.ts#L173)).

## Why this is not a header change to `<`

- Changing the loop header from `<=` to `<` would remove the wasted execution but also the useful sixth provider call that reads round five's results, so the model would only ever see four rounds. Gating execution keeps six provider calls, which five rounds need, and drops only the sixth execution, the one nobody reads ([validated by: executes 5 tool rounds and makes 6 provider calls at the default budget](../../src/orchestration/toolBudget.test.ts#L95)).

## Compatibility

- No exported type, signature or name changes, but the behaviour does: a consumer whose tool has a side effect in the final, unread round stops seeing that round execute. That is breaking by meaning rather than by type, so the bump is MINOR with the change stated in the release notes, and a consumer relying on the old count restores it by raising `maxToolRounds` by one ([validated by: executes 2 tool rounds and makes 3 provider calls at maxToolRounds 2](../../src/orchestration/toolBudget.test.ts#L89)).

## Out of scope

The user-facing sentence itself and routing an exhausted turn to a human, which belong to the consumer; failing over to a second provider; a `stopReason` taxonomy, since `tool_budget_exhausted` is the first engine-normalized value and provider strings otherwise pass through; summing usage across rounds, which touches the same loop; an unknown tool name and input the schema rejects, both about one call failing rather than a call not being made; and per-tool or per-turn cost budgets and a whole-turn deadline.
