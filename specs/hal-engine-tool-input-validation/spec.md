# Tool Input Validation

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#37 |
| Status | Implemented          |

`ToolRegistry.execute` validates the caller-supplied `input` against the tool's declared `inputSchema` before invoking the executor. A failure returns a `ToolResponse` describing the constraint violation so the model can read it and attempt a corrected call within the existing tool-round budget; it never throws, because a throw propagates out of the orchestrator's `Promise.all` and ends the whole conversation with a transport error rather than giving the model a chance to recover.

## Validation contract

- `execute` validates `input` against the resolved tool definition's `inputSchema` before calling the executor; on failure it returns a `ToolResponse` whose `result` describes the failure, and the executor is never invoked ([validated by: returns a ToolResponse naming the missing required field and does not invoke the executor](../../src/orchestration/tools/registry.test.ts#L7)).
- Valid input passes through to the executor unchanged; extra properties that are present in `input` but absent from the schema are forwarded without modification ([validated by: passes valid input with an extra property through to the executor unchanged](../../src/orchestration/tools/registry.test.ts#L30)).
- Validation enforces `required`, declared types, and `enum` constraints only — it does not inject `additionalProperties: false`, coerce types, or apply defaults ([validated by: passes valid input with an extra property through to the executor unchanged](../../src/orchestration/tools/registry.test.ts#L30)).
- A wrong-typed field is rejected with a message naming the field path and the expected type; the offending value does not appear in the rejection text or in any log line produced during the call ([validated by: rejects a call whose field type is wrong, naming the field path and expected type but not the value](../../src/orchestration/tools/registry.test.ts#L50), [validated by: does not include the rejected field value in the returned text or any log line](../../src/orchestration/tools/registry.test.ts#L112)).
- `execute` still throws `Error('Unknown tool: <name>')` for an unregistered name, unchanged — a missing tool name is a programming error in the caller, not a model input to be corrected ([validated by: throws for an unregistered tool name](../../src/orchestration/tools/registry.test.ts#L106)).

## Schema compilation

- A static tool's `inputSchema` is compiled at `register` time; an uncompilable schema causes `register` to throw synchronously with a message that names the tool, so a broken schema fails at startup rather than mid-conversation ([validated by: throws at register time when the inputSchema is uncompilable and the message names the tool](../../src/orchestration/tools/registry.test.ts#L70)).
- A function-valued `ToolDefinitionSource` is resolved on each `execute` call; the schema validated against is the schema returned by that call, not the one resolved at `register` time ([validated by: validates each call against the schema the definition function returns at that call](../../src/orchestration/tools/registry.test.ts#L81)).

## Orchestrator integration

- A validation failure becomes a tool result (not a thrown error), so the orchestrator delivers the rejection text to the model and the model can attempt a corrected call; `DEFAULT_MAX_TOOL_ROUNDS = 5` is the bound that stops a retry cycle from spinning ([validated by: resolves processMessage and makes the validation-rejection text visible to the provider on the next round](../../src/orchestration/chatOrchestrator.test.ts#L523)).

## Out of scope

Validating tool output, hallucination detection, per-tool authorisation, retry and rate limiting around tool execution, and the `Unknown tool: <name>` throw becoming a tool result (tracked separately).
