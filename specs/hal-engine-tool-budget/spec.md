# Tool Budget

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#56 |
| Status | Implemented          |

The tool loop used to run `round <= maxToolRounds`, which is six iterations at the default of five, and the sixth executed tools whose results no provider call would ever read: the results were pushed onto `messages`, the loop ended, and the generator returned. Real data was fetched and paid for, and the model never saw it. `maxToolRounds` is now a gate immediately before tool execution rather than the loop's own condition, so every executed round is read by a following provider call.

## The two bounds

- At most `maxToolRounds` tool rounds are executed, and the provider is called at most `maxToolRounds + 1` times: with a provider that asks for a tool on every call, `maxToolRounds: 2` executes 2 rounds across 3 provider calls ([validated by: executes 2 tool rounds and makes 3 provider calls at maxToolRounds 2](../../src/orchestration/toolBudget.test.ts#L69)).
- The default of 5 executes 5 rounds across 6 provider calls, which is what the README's "5 rounds" has always claimed ([validated by: executes 5 tool rounds and makes 6 provider calls at the default budget](../../src/orchestration/toolBudget.test.ts#L75)).
- `maxToolRounds: 0` is meaningful: one provider call and no tool execution ([validated by: makes one provider call and executes no tool at maxToolRounds 0](../../src/orchestration/toolBudget.test.ts#L81)).
- The budget is normalized at construction with `Math.max(0, Math.floor(value))`, so a negative budget behaves as 0, and a non-finite one, `NaN` included, falls back to the default; either way the turn terminates ([validated by: treats a negative budget as 0 and still terminates](../../src/orchestration/toolBudget.test.ts#L88), [validated by: treats a NaN budget as the default and still terminates](../../src/orchestration/toolBudget.test.ts#L95)).
- A conversation that ends on its own is unchanged: one tool round, then an answer, is one execution across two provider calls at the default and at 5 ([validated by: leaves a conversation that ends on its own unchanged, at the default and at 5](../../src/orchestration/toolBudget.test.ts#L101)).

| `maxToolRounds` | Provider calls | Rounds executed | Rounds read by the model |
| --------------- | -------------- | --------------- | ------------------------ |
| before, default | 6              | 6               | 5                        |
| now, default    | 6              | 5               | 5                        |
| now, 0          | 1              | 0               | 0                        |

## When the budget runs out

- An exhausted budget ends the turn on the last provider call's output rather than buying one more call with `tools` omitted, which would only move the same cliff one round over ([validated by: yields exactly the chunks it did before for an exhausted run, with nothing added](../../src/orchestration/toolBudget.test.ts#L123)).
- The exhausted run emits exactly one `warn` under category `orchestrator`, `tool budget exhausted`, carrying `maxToolRounds` and the names of the tools requested but not run; a `warn` is visible at the default `LOG_LEVEL` ([validated by: warns once, under orchestrator, with the budget and the tools it did not run](../../src/orchestration/toolBudget.test.ts#L111)).
- The yielded chunk sequence is identical to what it was before for the same provider: no new chunk variant and no extra `text` chunk. Telling the consumer is re-cinq/HALEngine#57 ([validated by: yields exactly the chunks it did before for an exhausted run, with nothing added](../../src/orchestration/toolBudget.test.ts#L123)).
- **GDPR data minimisation, Art. 5(1)(c).** A tool call whose result nobody reads no longer happens: with `maxToolRounds: 1` and a provider that always asks for tools, the executor runs exactly once ([validated by: never runs a tool whose result nobody reads: one execution at maxToolRounds 1](../../src/orchestration/toolBudget.test.ts#L129)).

## Why this is not a header change to `<`

- Changing the loop header from `<=` to `<` would remove the wasted execution but also the useful sixth provider call that reads round five's results, so the model would only ever see four rounds. Gating execution keeps six provider calls, which five rounds need, and drops only the sixth execution, the one nobody reads ([validated by: executes 5 tool rounds and makes 6 provider calls at the default budget](../../src/orchestration/toolBudget.test.ts#L75)).

## Compatibility

- No exported type, signature or name changes, but the behaviour does: a consumer whose tool has a side effect in the final, unread round stops seeing that round execute. That is breaking by meaning rather than by type, so the bump is MINOR with the change stated in the release notes, and a consumer relying on the old count restores it by raising `maxToolRounds` by one ([validated by: executes 2 tool rounds and makes 3 provider calls at maxToolRounds 2](../../src/orchestration/toolBudget.test.ts#L69)).

## Out of scope

Telling the consumer the budget ran out (re-cinq/HALEngine#57, which fires from this gate); summing usage across rounds, which touches the same loop; an unknown tool name and input the schema rejects, both about one call failing rather than a call not being made; and per-tool or per-turn cost budgets and a whole-turn deadline.
