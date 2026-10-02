# A Tool Call That Fails

| Field  | Value                                      |
| ------ | ------------------------------------------ |
| Issue  | re-cinq/HALEngine#51, re-cinq/HALEngine#52 |
| Status | Implemented                                |

A tool call the registry could not run used to end the conversation. `ToolRegistry.execute` threw for a tool name the model invented and rejected when an executor threw; either way one promise in the round's `Promise.all` rejected, the run failed with `SERVER_ERROR`, and the round's other results were lost with it. Both are now answered to the model as that call's `tool_result`, so it can correct the call, try another tool or tell the user.

## The contract

- `execute` resolves for every call the model authored, whether it names a tool that does not exist, carries input the schema rejects, or reaches an executor that throws. Only a caller's malformed input, a `null` that a schema accepting anything let through, still rejects, since it is a bug in the caller rather than something the model can correct ([validated by: answers an unregistered name with a result naming it and every registered tool, instead of throwing](../../src/orchestration/tools/registry.test.ts#L132), [validated by: answers an executor that rejects with a result naming the tool, never the thrown message](../../src/orchestration/tools/registry.test.ts#L159), [validated by: still rejects a null input a caller slipped past a schema that accepts anything, a caller bug and not the model](../../src/orchestration/tools/registry.test.ts#L203)).

## A tool name the model invented

- It is answered with a `ToolResponse` whose `result` names the attempted name and every registered tool, with no `clientMessages` and no `suppressAssistantResponse` ([validated by: answers an unregistered name with a result naming it and every registered tool, instead of throwing](../../src/orchestration/tools/registry.test.ts#L132)).
- With no tool registered, the answer says so instead of ending in an empty list ([validated by: says that no tools are registered when the registry is empty, ending in no empty list](../../src/orchestration/tools/registry.test.ts#L139)).
- The attempted name is cut to 64 characters, in the answer and in the one `warn` line, `tool not found` under `tool`, which is the only signal that a prompt or a registration is broken ([validated by: bounds an invented name to 64 characters in its answer and in its one warn line, under tool](../../src/orchestration/tools/registry.test.ts#L145)).
- The model reads the answer as that call's `tool_result`, and the turn goes on to its answer ([validated by: answers a call to a tool name the model invented, and the turn goes on to its answer](../../src/orchestration/chatOrchestrator.test.ts#L741)).

## An executor that throws

- It is answered with a `result` naming the tool and saying the call failed, never the thrown message ([validated by: answers an executor that rejects with a result naming the tool, never the thrown message](../../src/orchestration/tools/registry.test.ts#L159)).
- A throw of any shape is answered alike: a string, `undefined`, a plain object, and an object with no prototype, whose message cannot even be turned into a string ([validated by: answers a throw of any shape alike: a string, undefined, a plain object, an object with no prototype](../../src/orchestration/tools/registry.test.ts#L166)).
- The throw is logged once, at `error` under `tool` as `tool executor threw`, with the tool's name, the error's type and its message cut to 500 characters ([validated by: logs a throw once, at error under tool, with the tool name and error type, its message cut to 500 characters](../../src/orchestration/tools/registry.test.ts#L174)).
- The turn goes on to its answer and succeeds: `afterModelResponse` fires and `onError` does not ([validated by: answers a call whose executor threw, and the turn goes on to its answer with afterModelResponse and no onError](../../src/orchestration/chatOrchestrator.test.ts#L752)).

## Both

- No value from the call's input reaches the answer or any log line, only the input's keys, which the registry already logs ([validated by: keeps every value of the call input out of the answer and the log, for an invented name and a throwing executor](../../src/orchestration/tools/registry.test.ts#L192)).
- A round in which some calls fail still returns every result: a working tool beside them runs once and its result reaches the model unchanged ([validated by: returns every result of a round in which calls fail, the working tool run once and its result unchanged](../../src/orchestration/chatOrchestrator.test.ts#L765)).
- **NIS-2 Article 21, operational resilience.** Over the WebSocket, a turn whose tool name was invented streams its answer and ends with `stream_end`, never an `error` frame ([validated by: completes a turn whose tool name the model invented: its answer streams, then stream_end, with no error frame](../../src/transport/ws/messageHandler.test.ts#L808)).
- So does a turn whose tool executor threw: one broken tool degrades one answer instead of ending the conversation ([validated by: completes a turn whose tool executor threw: its answer streams, then stream_end, with no error frame](../../src/transport/ws/messageHandler.test.ts#L814)).

## Compatibility

- The change is MINOR, but breaking by meaning: `execute` no longer throws `Unknown tool: <name>` and no longer rejects when an executor throws, so a caller that caught either stops seeing it ([validated by: answers an unregistered name with a result naming it and every registered tool, instead of throwing](../../src/orchestration/tools/registry.test.ts#L132), [validated by: answers an executor that rejects with a result naming the tool, never the thrown message](../../src/orchestration/tools/registry.test.ts#L159)).

## Rationale

The fix lives in the registry, not around the orchestrator's `Promise.all`: `execute` is the published seam consumers call directly, and a catch in the orchestrator would also have hidden a genuine executor failure behind a model mistake.

The thrown message is not forwarded to the model. That is a common pattern, and safe when every tool calls one system whose error strings the same author writes, but this registry takes any consumer's executors, and the engine cannot tell whether an `Error.message` is a tidy sentence or a stack of connection details naming an internal host or another user.

**GDPR.** The thrown message is bounded to 500 characters and logged, but never redacted, and the engine cannot enforce what a tool author puts in an error string, so a tool must keep credentials and personal data out of its errors. The `tool executor threw` line is also the only source for a tool success-rate metric.

## Open Questions

On Vertex a tool call's id is the tool's name, so the answer to an invented name goes back as a `functionResponse` named after the invented string. Whether the model accepts a `functionResponse` for a function it was never declared cannot be known from the SDK's types; a live provider smoke test is where it gets answered.

## Out of scope

Telling the provider on the wire that a result is an error (re-cinq/HALEngine#53); the tool entry the client already shows for a call that failed; stopping the model from inventing names, which is the prompt's job; a hook for observing a crashed tool, since a consumer can wrap its own executor at registration; and validating input, specified in [tool input validation](../hal-engine-tool-input-validation/spec.md).
